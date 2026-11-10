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

test("real Pi SDK streams live estimated speed, finalizes actual usage and stops redrawing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-speed-sdk-"));
	const model = {
		id: "offline-speed", name: "Offline Speed", provider: "offline-speed", api: "openai-responses",
		baseUrl: "https://offline.invalid", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000,
	};
	function stream() {
		const events = createAssistantMessageEventStream();
		const message = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			timestamp: Date.now(), stopReason: "stop", content: [],
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		void (async () => {
			events.push({ type: "start", partial: message });
			const text = { type: "text", text: "" };
			message.content.push(text);
			events.push({ type: "text_start", contentIndex: 0, partial: message });
			text.text = "offline text ".repeat(20);
			events.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
			await delay(650);
			message.usage.input = 100;
			message.usage.output = 80;
			message.usage.totalTokens = 180;
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
		({ session } = await createAgentSession({
			cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader,
			settingsManager, sessionManager: SessionManager.inMemory(dir), tools: [],
		}));
		const statuses = [];
		const errors = [];
		await session.bindExtensions({
			mode: "interactive", onError: error => errors.push(error),
			uiContext: {
				theme: { fg: (_color, text) => text },
				setStatus(key, text) { if (key === "token-speed") statuses.push(text); },
			},
		});
		await session.prompt("offline fixture");
		const message = session.messages.filter(message => message.role === "assistant").at(-1);
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.equal(message.usage.output, 80);
		assert.ok(message.durationMs > 0);
		assert.ok(statuses.some(text => /↑ ~\d+\.\d tok\/s/.test(text)), JSON.stringify(statuses));
		assert.equal(statuses.at(-1), formatSpeed(message, message.durationMs, true));
		assert.deepEqual(errors, []);
		initTheme("dark", false);
		const footer = new FooterComponent(session, {
			getGitBranch: () => null,
			getAvailableProviderCount: () => 1,
			getExtensionStatuses: () => new Map([["openai-fast-mode", "fast: on"], ["token-speed", statuses.at(-1)]]),
			onBranchChange: () => () => {},
		});
		const rendered = footer.render(120).map(stripVTControlCharacters).join("\n");
		assert.ok(rendered.includes(statuses.at(-1)), rendered);
		assert.ok(rendered.includes("fast: on"), rendered);
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
