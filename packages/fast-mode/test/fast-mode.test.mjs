import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import fastMode from "../src/index.ts";

const STATE_TYPE = "openai-fast-mode";
const gpt = { id: "gpt-6.1-sol", api: "openai-responses", provider: "openai" };
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let testDir;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
	process.env.PI_CODING_AGENT_DIR = join(testDir, "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testDir, { recursive: true, force: true });
});

const configPath = () => join(process.env.PI_CODING_AGENT_DIR, "fast-mode.json");
const readConfig = () => JSON.parse(readFileSync(configPath(), "utf8"));

function writeConfig(enabled) {
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(configPath(), JSON.stringify({ enabled }));
}

function harness(initial, provider, branch = []) {
	if (initial !== undefined) writeConfig(initial);
	const handlers = new Map();
	const commands = new Map();
	const statuses = new Map();
	const notices = [];
	const entries = [...branch];
	const ctx = {
		hasUI: true,
		model: { ...gpt },
		sessionManager: { getBranch: () => entries },
		modelRegistry: { getProvider: () => provider },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (key, value) => statuses.set(key, value),
			notify: (message, level) => notices.push({ message, level }),
		},
	};
	fastMode({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	});
	const emit = (name, event = {}) => handlers.get(name)(event, ctx);
	emit("session_start");
	return {
		ctx, statuses, notices, entries, emit,
		command: commands.get("fast"),
		run: (args = "") => commands.get("fast").handler(args, ctx),
		request: (payload = { model: ctx.model.id }) => emit("before_provider_request", { payload }),
	};
}

function state(enabled) {
	return { type: "custom", customType: STATE_TYPE, data: { enabled } };
}

test("provider pricing wraps once and restores methods on shutdown without re-registering", () => {
	const stream = () => {}, streamSimple = () => {};
	const provider = { id: "openai", auth: { apiKey: {} }, getModels: () => [gpt], stream, streamSimple };
	const auth = provider.auth, getModels = provider.getModels;
	const h = harness(undefined, provider);
	const wrapped = provider.streamSimple;
	assert.notEqual(wrapped, streamSimple);
	assert.equal(provider.auth, auth);
	assert.equal(provider.getModels, getModels);
	h.emit("model_select");
	h.emit("session_tree");
	h.emit("turn_start");
	h.emit("cache_warming_decision");
	assert.equal(provider.streamSimple, wrapped);
	h.emit("session_shutdown");
	assert.equal(provider.stream, stream);
	assert.equal(provider.streamSimple, streamSimple);
});

test("refreshed provider instances are wrapped before the next turn and restored on shutdown", () => {
	const first = { stream() {}, streamSimple() {} };
	const second = { stream() {}, streamSimple() {} };
	const originals = [first.streamSimple, second.streamSimple];
	const h = harness(undefined, first);
	h.ctx.modelRegistry.getProvider = () => second;
	h.emit("turn_start");
	assert.notEqual(first.streamSimple, originals[0]);
	assert.notEqual(second.streamSimple, originals[1]);
	h.emit("session_shutdown");
	assert.equal(first.streamSimple, originals[0]);
	assert.equal(second.streamSimple, originals[1]);
});

test("missing global config defaults off without creating a file", () => {
	const h = harness();
	assert.equal(h.statuses.get(STATE_TYPE), "fast:off");
	assert.equal(h.request().service_tier, "default");
	assert.equal(h.entries.length, 0);
	assert.equal(existsSync(configPath()), false);
});

test("/fast toggles globally and does not append session entries", async () => {
	const h = harness();
	await h.run();
	assert.equal(h.request().service_tier, "priority");
	assert.equal(h.statuses.get(STATE_TYPE), "fast:on");
	assert.deepEqual(readConfig(), { enabled: true });
	assert.match(h.notices.at(-1).message, /全局/);
	await h.run();
	assert.equal(h.request().service_tier, "default");
	assert.deepEqual(readConfig(), { enabled: false });
	assert.deepEqual(h.entries, []);
});

test("explicit on/off commands are idempotent and normalize whitespace/case", async () => {
	const h = harness();
	await h.run(" ON ");
	await h.run("on");
	assert.deepEqual(readConfig(), { enabled: true });
	await h.run("off");
	await h.run("off");
	assert.deepEqual(readConfig(), { enabled: false });
	assert.deepEqual(h.entries, []);
});

function diagnosticProvider(reported = "default") {
	return {
		stream() {},
		streamSimple(model, _context, options) {
			const message = {
				role: "assistant", api: model.api,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0, totalFromProvider: true } },
			};
			const ready = (async () => {
				await options.onPayload({ model: model.id }, model);
				await options.onProviderStreamEvent({ type: "response.completed", response: { service_tier: reported } }, model);
			})();
			return {
				result: async () => { await ready; return message; },
				async *[Symbol.asyncIterator]() { await ready; yield { type: "done", message }; },
			};
		},
	};
}

async function observeRequest(h, provider, apiKey = "offline-oauth-token") {
	return provider.streamSimple(h.ctx.model, {}, { apiKey, onPayload: (payload) => h.request(payload) }).result();
}

test("status separates subscription request tier from its non-authoritative default echo", async () => {
	const provider = diagnosticProvider();
	const h = harness(true, provider);
	h.ctx.model.baseUrl = "https://api.openai.com/v1";
	await observeRequest(h, provider);
	await h.run("status");
	const notice = h.notices.at(-1).message;
	assert.match(notice, /priority → 上游回显 default/);
	assert.match(notice, /不能证明 Fast 未生效/);
	assert.match(notice, /估算.*不代表实际账单/);
	assert.equal(h.statuses.get(STATE_TYPE), "fast:on");
});

test("status does not apply subscription echo semantics to API keys", async () => {
	const provider = diagnosticProvider();
	const h = harness(true, provider);
	h.ctx.model.baseUrl = "https://api.openai.com/v1";
	await observeRequest(h, provider, "sk-offline-test");
	await h.run("status");
	assert.match(h.notices.at(-1).message, /优先采用上游回显/);
	assert.doesNotMatch(h.notices.at(-1).message, /订阅的 default/);
});

test("status has no observation before the first request or after branch navigation", async () => {
	const provider = diagnosticProvider();
	const h = harness(true, provider);
	await h.run("status");
	assert.match(h.notices.at(-1).message, /尚无请求观测/);
	await observeRequest(h, provider);
	h.emit("session_tree");
	await h.run("status");
	assert.match(h.notices.at(-1).message, /尚无请求观测/);
});

test("status does not reuse another model's response tier", async () => {
	const provider = diagnosticProvider();
	const h = harness(true, provider);
	await observeRequest(h, provider);
	h.ctx.model = { ...gpt, id: "gpt-6-astra" };
	h.emit("model_select");
	await h.run("status");
	assert.match(h.notices.at(-1).message, /尚无请求观测/);
	h.ctx.model = { ...gpt };
	h.emit("model_select");
	await h.run("status");
	assert.match(h.notices.at(-1).message, /priority → 上游回显 default/);
});

test("status is read-only", async () => {
	const h = harness(true);
	const original = readFileSync(configPath(), "utf8");
	await h.run("status");
	assert.equal(h.request().service_tier, "priority");
	assert.equal(readFileSync(configPath(), "utf8"), original);
	assert.deepEqual(h.entries, []);
	assert.match(h.notices.at(-1).message, /已开启/);
});

test("invalid arguments do not change the mode or create global config", async () => {
	const h = harness();
	await h.run("on off");
	assert.equal(h.request().service_tier, "default");
	assert.equal(h.entries.length, 0);
	assert.equal(existsSync(configPath()), false);
	assert.equal(h.notices.at(-1).level, "warning");
});

for (const api of ["openai-responses", "openai-codex-responses", "openai-completions"]) {
	test(`on/off works with ${api}`, async () => {
		const h = harness();
		h.ctx.model.api = api;
		await h.run("on");
		assert.equal(h.request().service_tier, "priority");
		await h.run("off");
		assert.equal(h.request({ model: gpt.id, service_tier: "priority" }).service_tier, "default");
	});
}

test("payload changes preserve reasoning, tools, inputs, and other fields without mutation", async () => {
	const h = harness();
	await h.run("on");
	const payload = {
		model: gpt.id,
		reasoning: { effort: "high" },
		tools: [{ type: "function", name: "read" }],
		input: [{ role: "user", content: "hello" }],
		stream: true,
	};
	const original = structuredClone(payload);
	assert.deepEqual(h.request(payload), { ...original, service_tier: "priority" });
	assert.deepEqual(payload, original);
});

test("non-GPT models are not modified and saved mode resumes after switching back", async () => {
	const h = harness();
	await h.run("on");
	for (const model of [
		{ id: "claude-sonnet-4-5", api: "anthropic-messages" },
		{ id: "qwen3", api: "openai-completions" },
		{ id: "gpt-custom", api: "anthropic-messages" },
	]) {
		h.ctx.model = model;
		h.emit("model_select");
		assert.equal(h.request(), undefined);
		assert.equal(h.statuses.get(STATE_TYPE), "fast:on(GPT-only)");
	}
	h.ctx.model = { ...gpt };
	h.emit("model_select");
	assert.equal(h.request().service_tier, "priority");
	assert.equal(h.statuses.get(STATE_TYPE), "fast:on");
});

test("namespaced GPT model IDs work on compatible gateways", async () => {
	const h = harness();
	h.ctx.model.id = "openai/gpt-5.4";
	await h.run("on");
	assert.equal(h.request().service_tier, "priority");
});

test("a non-GPT request payload is not changed even with a GPT session model", async () => {
	const h = harness(true);
	assert.equal(h.request({ model: "claude-sonnet-4-5", input: [] }), undefined);
});

test("missing session model does not modify requests", () => {
	const h = harness(true);
	h.ctx.model = undefined;
	assert.equal(h.request({ model: gpt.id }), undefined);
});

test("reload/resume restores global config instead of legacy branch entries", async () => {
	const h = harness();
	await h.run("on");
	h.emit("session_shutdown");
	const reloaded = harness(undefined, undefined, [state(false)]);
	assert.equal(reloaded.statuses.get(STATE_TYPE), "fast:on");
	assert.equal(reloaded.request().service_tier, "priority");
	await reloaded.run("off");
	assert.equal(harness(undefined, undefined, [state(true)]).request().service_tier, "default");
});

test("tree navigation never restores legacy branch state or resets the global mode", async () => {
	const h = harness(undefined, undefined, [state(true)]);
	assert.equal(h.request().service_tier, "default");
	assert.equal(existsSync(configPath()), false);
	await h.run("on");
	h.entries.splice(0, h.entries.length, state(false));
	h.emit("session_tree");
	assert.equal(h.statuses.get(STATE_TYPE), "fast:on");
	assert.equal(h.request().service_tier, "priority");
	h.entries.splice(0);
	h.emit("session_tree");
	assert.equal(h.request().service_tier, "priority");
	assert.deepEqual(readConfig(), { enabled: true });
});

test("new sessions in other projects inherit the global mode", async () => {
	const h = harness();
	h.ctx.cwd = join(testDir, "project-a");
	await h.run("on");
	const other = harness();
	other.ctx.cwd = join(testDir, "project-b");
	assert.equal(other.statuses.get(STATE_TYPE), "fast:on");
	assert.equal(other.request().service_tier, "priority");
	await other.run("off");
	assert.equal(harness().request().service_tier, "default");
});

test("already-open sessions refresh the global setting before requests and commands", async () => {
	const first = harness();
	const second = harness();
	await first.run("on");
	assert.equal(second.request().service_tier, "priority");
	assert.equal(second.statuses.get(STATE_TYPE), "fast:on");
	await first.run("off");
	await second.run("status");
	assert.equal(second.statuses.get(STATE_TYPE), "fast:off");
	assert.match(second.notices.at(-1).message, /已关闭/);
	await first.run("on");
	await second.run();
	assert.deepEqual(readConfig(), { enabled: false });
	assert.equal(first.request().service_tier, "default");
});

test("external global config edits apply to the next request, including cache warming", async () => {
	const provider = diagnosticProvider();
	const h = harness(undefined, provider);
	writeConfig(true);
	h.emit("cache_warming_decision");
	await observeRequest(h, provider);
	await h.run("status");
	assert.match(h.notices.at(-1).message, /priority → 上游回显 default/);
	writeConfig(false);
	assert.equal(h.request().service_tier, "default");
});

test("project-local configuration cannot override global Fast mode", () => {
	const h = harness(true);
	h.ctx.cwd = join(testDir, "project");
	const projectConfigDir = join(h.ctx.cwd, ".pi");
	mkdirSync(projectConfigDir, { recursive: true });
	writeFileSync(join(projectConfigDir, "fast-mode.json"), '{"enabled":false}');
	assert.equal(h.request().service_tier, "priority");
});

test("status and explicit off do not create config when already off", async () => {
	const h = harness();
	await h.run("status");
	await h.run("off");
	assert.equal(existsSync(configPath()), false);
});

test("failed config writes reject the command without reporting a successful toggle", async () => {
	const h = harness();
	mkdirSync(`${configPath()}.${process.pid}.tmp`, { recursive: true });
	await assert.rejects(h.run("on"));
	assert.equal(h.statuses.get(STATE_TYPE), "fast:off");
	assert.deepEqual(h.notices, []);
});

test("command arguments offer filtered completions", () => {
	const { command } = harness();
	assert.deepEqual(command.getArgumentCompletions("").map((item) => item.value), ["on", "off", "status"]);
	assert.deepEqual(command.getArgumentCompletions("of").map((item) => item.value), ["off"]);
	assert.equal(command.getArgumentCompletions("unknown"), null);
});

test("headless mode persists and applies changes without UI calls", async () => {
	const h = harness();
	h.ctx.hasUI = false;
	h.ctx.ui = undefined;
	h.emit("session_start");
	await h.run("on");
	await h.run("status");
	await h.run("invalid");
	assert.equal(h.request().service_tier, "priority");
	assert.deepEqual(readConfig(), { enabled: true });
	assert.deepEqual(h.entries, []);
});
