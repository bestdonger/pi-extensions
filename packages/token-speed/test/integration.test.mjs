import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { host } from "./host-modules.mjs";
import { formatSpeed } from "../src/index.ts";

const fromHost = path => import(pathToFileURL(join(host, path)).href);
const { createAgentSession, DefaultResourceLoader, FooterComponent, initTheme, ModelRuntime, SessionManager, SettingsManager } = await fromHost("dist/index.js");
const { createProvider } = await fromHost("node_modules/@earendil-works/pi-ai/dist/models.js");
const { createAssistantMessageEventStream } = await fromHost("node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js");
const samples = manager => manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "token-speed-sample-v1").map(entry => entry.data);

test("real SDK settles cumulative decode speed, persists it outside model context and restores on reload", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-speed-sdk-"));
	const statuses = [];
	const observations = [];
	const contexts = [];
	let responses = 0;
	const model = {
		id: "offline-speed", name: "Offline Speed", provider: "offline-speed", api: "openai-responses",
		baseUrl: "https://offline.invalid", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000,
	};
	function stream(_model, context) {
		contexts.push(context);
		const turn = responses++;
		const events = createAssistantMessageEventStream();
		const message = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			timestamp: Date.now(), stopReason: "stop", content: [],
			usage: {
				input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		void (async () => {
			const before = statuses.at(-1);
			const writes = statuses.length;
			events.push({ type: "start", partial: message });
			await delay(80); // Request/prefill wait is excluded from decodeMs.
			const text = { type: "text", text: "" };
			message.content.push(text);
			events.push({ type: "text_start", contentIndex: 0, partial: message });
			text.text = "offline text ".repeat(20);
			events.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
			await delay(60);
			observations.push({ before, during: statuses.at(-1), writesBefore: writes, writesDuring: statuses.length });
			await delay(turn === 0 ? 60 : 180);
			message.usage.output = turn === 0 ? 80 : 20;
			message.usage.totalTokens = 100 + message.usage.output;
			events.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
			events.push({ type: "done", reason: "stop", message });
			events.end();
		})();
		return events;
	}
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog.json"),
		refreshOnCreate: false,
	});
	let session;
	try {
		runtime.registerNativeProvider(createProvider({
			id: model.provider, name: "Offline fixture", models: [model],
			auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "offline-fixture" }, source: "test" }) } },
			api: { id: model.api, stream, streamSimple: stream },
		}));
		const settingsManager = SettingsManager.inMemory({
			cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager,
			noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		({ session } = await createAgentSession({
			cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader,
			settingsManager, sessionManager: manager, tools: [],
		}));
		const errors = [];
		await session.bindExtensions({
			mode: "interactive", onError: error => errors.push(error),
			uiContext: {
				theme: { fg: (_color, text) => text },
				setStatus(key, text) { if (key === "token-speed") statuses.push(text); },
			},
		});
		assert.equal(statuses.at(-1), "⚡—tok/s");
		await session.prompt("first offline fixture");
		const first = samples(manager)[0];
		const firstMessage = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
		assert.equal(first.outputTokens, 80);
		assert.ok(first.decodeMs > 0);
		assert.ok(first.decodeMs + 40 < firstMessage.message.durationMs, JSON.stringify({ first, durationMs: firstMessage.message.durationMs }));
		assert.equal(statuses.at(-1), formatSpeed(first.outputTokens, first.decodeMs));
		const firstSpeed = statuses.at(-1);

		await session.prompt("second offline fixture");
		const readings = samples(manager);
		assert.equal(readings.length, 2);
		assert.equal(readings[1].outputTokens, 20);
		const totalMs = readings.reduce((sum, reading) => sum + reading.decodeMs, 0);
		assert.equal(statuses.at(-1), formatSpeed(100, totalMs));
		assert.notEqual(statuses.at(-1), formatSpeed(20, readings[1].decodeMs));
		assert.equal(observations[0].during, "⚡—tok/s");
		assert.equal(observations[1].during, firstSpeed);
		for (const reading of observations) assert.equal(reading.writesDuring, reading.writesBefore);
		for (const context of contexts) {
			assert.equal(context.messages.some(message => message.role === "custom" || message.customType === "token-speed-sample-v1"), false);
		}
		assert.deepEqual(errors, []);

		const finalSpeed = statuses.at(-1);
		manager.appendCompaction("offline compaction", firstMessage.id, 1000);
		assert.deepEqual(samples(manager), readings);
		await session.reload();
		assert.equal(statuses.at(-1), finalSpeed);
		assert.deepEqual(samples(manager), readings);
		assert.deepEqual(errors, []);
		const reopened = SessionManager.open(manager.getSessionFile());
		assert.deepEqual(samples(reopened), readings);
		reopened.branch(firstMessage.id);
		assert.deepEqual(samples(reopened), [first]);

		initTheme("dark", false);
		const footer = new FooterComponent(session, {
			getGitBranch: () => null,
			getAvailableProviderCount: () => 1,
			getExtensionStatuses: () => new Map([["openai-fast-mode", "fast:on"], ["token-speed", statuses.at(-1)]]),
			onBranchChange: () => () => {},
		});
		for (const width of [40, 120]) {
			const rendered = footer.render(width).map(stripVTControlCharacters).join("\n");
			assert.ok(rendered.includes(finalSpeed), rendered);
			assert.ok(rendered.includes("fast:on"), rendered);
		}
		footer.dispose();
		const finishedWrites = statuses.length;
		await delay(300);
		assert.equal(statuses.length, finishedWrites);
	} finally {
		session?.dispose();
		await runtime.settleCredentialWrites();
		await rm(dir, { recursive: true, force: true });
	}
});
