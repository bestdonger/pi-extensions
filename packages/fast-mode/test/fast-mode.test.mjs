import assert from "node:assert/strict";
import { test } from "node:test";
import fastMode from "../src/index.ts";

const STATE_TYPE = "openai-fast-mode";
const gpt = { id: "gpt-6.1-sol", api: "openai-responses", provider: "openai" };

function harness(branch = [], provider) {
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
	const h = harness([], provider);
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
	const h = harness([], first);
	h.ctx.modelRegistry.getProvider = () => second;
	h.emit("turn_start");
	assert.notEqual(first.streamSimple, originals[0]);
	assert.notEqual(second.streamSimple, originals[1]);
	h.emit("session_shutdown");
	assert.equal(first.streamSimple, originals[0]);
	assert.equal(second.streamSimple, originals[1]);
});

test("new sessions start off and explicitly use the standard tier", () => {
	const h = harness();
	assert.equal(h.statuses.get(STATE_TYPE), "fast:off");
	assert.equal(h.request().service_tier, "default");
	assert.equal(h.entries.length, 0);
});

test("/fast toggles on and off and persists both transitions", async () => {
	const h = harness();
	await h.run();
	assert.equal(h.request().service_tier, "priority");
	assert.equal(h.statuses.get(STATE_TYPE), "fast:on");
	await h.run();
	assert.equal(h.request().service_tier, "default");
	assert.deepEqual(h.entries, [state(true), state(false)]);
});

test("explicit on/off commands are idempotent and normalize whitespace/case", async () => {
	const h = harness();
	await h.run(" ON ");
	await h.run("on");
	assert.equal(h.entries.length, 1);
	await h.run("off");
	await h.run("off");
	assert.deepEqual(h.entries, [state(true), state(false)]);
});

test("status is read-only", async () => {
	const h = harness([state(true)]);
	await h.run("status");
	assert.equal(h.request().service_tier, "priority");
	assert.deepEqual(h.entries, [state(true)]);
	assert.match(h.notices.at(-1).message, /已开启/);
});

test("invalid arguments do not change the mode", async () => {
	const h = harness();
	await h.run("on off");
	assert.equal(h.request().service_tier, "default");
	assert.equal(h.entries.length, 0);
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
	const h = harness([state(true)]);
	assert.equal(h.request({ model: "claude-sonnet-4-5", input: [] }), undefined);
});

test("missing session model does not modify requests", () => {
	const h = harness([state(true)]);
	h.ctx.model = undefined;
	assert.equal(h.request({ model: gpt.id }), undefined);
});

test("reload/resume restores the last mode on the active branch", async () => {
	const h = harness();
	await h.run("on");
	const reloaded = harness(h.entries);
	assert.equal(reloaded.request().service_tier, "priority");
	await reloaded.run("off");
	assert.equal(harness(reloaded.entries).request().service_tier, "default");
});

test("tree navigation reconstructs only the active branch", () => {
	const h = harness([state(true), state(false)]);
	assert.equal(h.request().service_tier, "default");
	h.entries.splice(0, h.entries.length, state(true));
	h.emit("session_tree");
	assert.equal(h.request().service_tier, "priority");
	h.entries.splice(0);
	h.emit("session_tree");
	assert.equal(h.request().service_tier, "default");
});

test("a new session does not inherit another session's mode", async () => {
	const h = harness();
	await h.run("on");
	assert.equal(harness().request().service_tier, "default");
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
	assert.deepEqual(h.entries, [state(true)]);
});
