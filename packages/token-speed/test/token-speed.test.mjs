import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import tokenSpeed, { formatSpeed } from "../src/index.ts";

function assistant(overrides = {}) {
	return {
		role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "gpt-5.5",
		timestamp: 10_000, stopReason: "stop",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

function withOutput(tokens, overrides = {}) {
	const message = assistant(overrides);
	message.usage = { ...message.usage, input: 1000, output: tokens, totalTokens: 1000 + tokens };
	return message;
}

function harness(t, hasUI = true) {
	let now = 0;
	let unrefs = 0;
	const timers = new Map();
	const handlers = new Map();
	const statuses = new Map([["openai-fast-mode", "fast: on"]]);
	const writes = [];
	t.mock.method(performance, "now", () => now);
	t.mock.method(Date, "now", () => 10_000 + now);
	t.mock.method(globalThis, "setInterval", (callback, delay) => {
		assert.equal(delay, 250);
		const handle = { unref() { unrefs++; } };
		timers.set(handle, callback);
		return handle;
	});
	t.mock.method(globalThis, "clearInterval", handle => timers.delete(handle));
	const ctx = {
		hasUI,
		ui: hasUI ? {
			theme: { fg: (_color, text) => text },
			setStatus: (key, value) => { statuses.set(key, value); writes.push([key, value]); },
		} : undefined,
	};
	tokenSpeed({ on(name, callback) { handlers.set(name, callback); } });
	return {
		ctx, handlers, timers, writes, statuses,
		get unrefs() { return unrefs; },
		get status() { return statuses.get("token-speed"); },
		emit(name, event = {}) { return handlers.get(name)(event, ctx); },
		advance(ms) { now += ms; },
		tick(ms = 250) { now += ms; for (const callback of timers.values()) callback(); },
	};
}

test("idle and empty responses show a placeholder", () => {
	assert.equal(formatSpeed(undefined, 0), "↑ — tok/s");
	assert.equal(formatSpeed(assistant(), 1000, true), "↑ — tok/s");
});

test("actual output tokens produce an exact rate and ignore input/cache usage", () => {
	const message = withOutput(200);
	message.usage.cacheRead = 20_000;
	assert.equal(formatSpeed(message, 4000, true), "↑ 50.0 tok/s");
});

test("unreported output usage uses the host estimator with an estimate marker", () => {
	const message = assistant({ content: [{ type: "text", text: "x".repeat(40) }] });
	assert.equal(formatSpeed(message, 2000), "↑ ~5.0 tok/s");
	assert.equal(formatSpeed(message, 2000, true), "↑ ~5.0 tok/s");
});

test("thinking, CJK text and tool arguments use the same estimator as Pi", () => {
	const message = assistant({ content: [
		{ type: "thinking", thinking: "比较两种方案" },
		{ type: "text", text: "选择第二种方案。" },
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
	] });
	assert.equal(formatSpeed(message, 1000), `↑ ~${estimateTokens(message).toFixed(1)} tok/s`);
});

test("initial usage snapshots cannot freeze live speed at one token", () => {
	const message = withOutput(1, { api: "anthropic-messages", content: [{ type: "text", text: "x".repeat(400) }] });
	assert.equal(formatSpeed(message, 1000), "↑ ~100.0 tok/s");
});

test("successful final usage remains authoritative even below the content estimate", () => {
	const message = withOutput(50, { content: [{ type: "text", text: "x".repeat(400) }] });
	assert.equal(formatSpeed(message, 1000, true), "↑ 50.0 tok/s");
});

for (const [reason, suffix] of [["aborted", "stopped"], ["error", "error"]]) {
	test(`${reason} keeps stale partial usage approximate`, () => {
		const message = withOutput(1, { stopReason: reason, content: [{ type: "text", text: "x".repeat(400) }] });
		assert.equal(formatSpeed(message, 1000, true), `↑ ~100.0 tok/s (${suffix})`);
	});
}

test("hidden reasoning output usage is not double counted", () => {
	const message = withOutput(180, { content: [{ type: "thinking", thinking: "brief summary" }] });
	assert.equal(formatSpeed(message, 3000, true), "↑ 60.0 tok/s");
});

test("zero duration does not display Infinity or NaN", () => {
	assert.equal(formatSpeed(withOutput(20), 0, true), "↑ — tok/s");
});

for (const [reason, suffix] of [["aborted", "stopped"], ["error", "error"]]) {
	test(`${reason} marks the final partial response`, () => {
		const message = assistant({ stopReason: reason, content: [{ type: "text", text: "x".repeat(40) }] });
		assert.equal(formatSpeed(message, 1000, true), `↑ ~10.0 tok/s (${suffix})`);
		assert.equal(formatSpeed(message, 1000), "↑ ~10.0 tok/s");
	});
}

test("session startup shows the status without starting a timer", t => {
	const h = harness(t);
	h.emit("session_start");
	assert.equal(h.status, "↑ — tok/s");
	assert.equal(h.timers.size, 0);
});

test("live updates include time before the first byte and refresh without new chunks", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant({ timestamp: 8000 }) });
	h.emit("message_update", { message: assistant({ content: [{ type: "text", text: "x".repeat(160) }] }) });
	h.tick(1000);
	assert.equal(h.status, "↑ ~13.3 tok/s"); // 40 estimated tokens / 3s, including the 2s wait.
	h.tick(1000);
	assert.equal(h.status, "↑ ~10.0 tok/s");
	assert.equal(h.unrefs, 1);
});

test("future message timestamps do not create negative elapsed time", t => {
	const h = harness(t);
	h.emit("message_start", { message: withOutput(20, { timestamp: 10_001 }) });
	h.tick(1000);
	assert.equal(h.status, "↑ ~20.0 tok/s");
});

test("native duration and actual output replace the live estimate at completion", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant() });
	h.emit("message_update", { message: assistant({ content: [{ type: "text", text: "x".repeat(40) }] }) });
	h.tick(1000);
	assert.equal(h.status, "↑ ~10.0 tok/s");
	h.advance(4000); // Includes a delayed extension callback; native timing wins.
	h.emit("message_end", { message: withOutput(120, { durationMs: 2000 }) });
	assert.equal(h.status, "↑ 60.0 tok/s");
	assert.equal(h.timers.size, 0);
	h.tick(30_000);
	assert.equal(h.status, "↑ 60.0 tok/s");
});

test("live provider output usage is a lower bound, not a current exact count", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant() });
	h.emit("message_update", { message: withOutput(60) });
	h.tick(2000);
	assert.equal(h.status, "↑ ~30.0 tok/s");
});

test("legacy responses fall back to monotonic elapsed time", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant() });
	h.advance(2000);
	h.emit("message_end", { message: withOutput(100) });
	assert.equal(h.status, "↑ 50.0 tok/s");
});

test("missing final usage keeps the estimate marker", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant() });
	h.advance(1000);
	h.emit("message_end", { message: assistant({ durationMs: 2000, content: [{ type: "text", text: "x".repeat(80) }] }) });
	assert.equal(h.status, "↑ ~10.0 tok/s");
});

test("user and tool messages do not affect speed or add tool execution time", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant() });
	h.emit("message_end", { message: withOutput(40, { durationMs: 1000, stopReason: "toolUse" }) });
	for (const role of ["user", "toolResult", "custom"]) {
		h.emit("message_start", { message: { role } });
		h.emit("message_end", { message: { role } });
	}
	h.tick(60_000);
	assert.equal(h.status, "↑ 40.0 tok/s");
	assert.equal(h.timers.size, 0);
});

test("each assistant response has independent timing and tokens", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant() });
	h.emit("message_end", { message: withOutput(100, { durationMs: 1000 }) });
	h.advance(20_000);
	h.emit("message_start", { message: assistant({ timestamp: 30_000 }) });
	assert.equal(h.status, "↑ — tok/s");
	h.emit("message_update", { message: withOutput(20) });
	h.tick(2000);
	assert.equal(h.status, "↑ ~10.0 tok/s");
	assert.equal(h.timers.size, 1);
});

for (const name of ["session_start", "session_tree", "model_select", "turn_start"]) {
	test(`${name} clears active state and timers`, t => {
		const h = harness(t);
		h.emit("message_start", { message: withOutput(20) });
		h.tick(1000);
		h.emit(name);
		assert.equal(h.status, "↑ — tok/s");
		assert.equal(h.timers.size, 0);
		h.emit("message_update", { message: withOutput(100) });
		h.tick(1000);
		assert.equal(h.status, "↑ — tok/s");
	});
}

test("agent_end stops unfinished streams and preserves a finalized status", t => {
	const h = harness(t);
	h.emit("message_start", { message: withOutput(60) });
	h.advance(3000);
	h.emit("agent_end");
	assert.equal(h.status, "↑ ~20.0 tok/s");
	assert.equal(h.timers.size, 0);
	h.emit("agent_end");
	assert.equal(h.status, "↑ ~20.0 tok/s");
});

test("session shutdown removes the status and cannot leave a timer behind", t => {
	const h = harness(t);
	h.emit("message_start", { message: withOutput(20) });
	h.emit("session_shutdown");
	assert.equal(h.status, undefined);
	assert.equal(h.timers.size, 0);
	h.tick(1000);
	assert.equal(h.status, undefined);
});

test("an error before streaming can still show its native timing", t => {
	const h = harness(t);
	h.emit("message_end", { message: withOutput(20, { stopReason: "error", durationMs: 1000 }) });
	assert.equal(h.status, "↑ ~20.0 tok/s (error)");
	assert.equal(h.timers.size, 0);
});

test("stream chunks do not cause a status redraw on every delta", t => {
	const h = harness(t);
	h.emit("message_start", { message: assistant() });
	const initialWrites = h.writes.length;
	for (let n = 1; n <= 1000; n++) {
		h.emit("message_update", { message: assistant({ content: [{ type: "text", text: "x".repeat(n) }] }) });
	}
	assert.equal(h.writes.length, initialWrites);
	h.tick();
	assert.equal(h.writes.length, initialWrites + 1);
});

test("headless operation never touches UI or starts timers", t => {
	const h = harness(t, false);
	for (const name of ["session_start", "session_tree", "model_select", "turn_start"]) h.emit(name);
	h.emit("message_start", { message: assistant() });
	h.emit("message_update", { message: withOutput(20) });
	h.emit("message_end", { message: withOutput(20) });
	h.emit("agent_end");
	h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
	assert.equal(h.writes.length, 0);
});

test("all model APIs share the same status implementation", t => {
	const h = harness(t);
	for (const [provider, api] of [["anthropic", "anthropic-messages"], ["google", "google-generative-ai"], ["openai-codex", "openai-codex-responses"]]) {
		h.emit("message_start", { message: assistant({ provider, api }) });
		h.emit("message_end", { message: withOutput(80, { provider, api, durationMs: 2000 }) });
		assert.equal(h.status, "↑ 40.0 tok/s");
	}
});

test("Fast Mode status and provider requests are untouched", t => {
	const h = harness(t);
	h.emit("session_start");
	h.emit("message_start", { message: assistant() });
	h.emit("message_end", { message: withOutput(100, { durationMs: 1000 }) });
	assert.equal(h.statuses.get("openai-fast-mode"), "fast: on");
	assert.equal(h.handlers.has("before_provider_request"), false);
	assert.equal(h.handlers.has("provider_stream_event"), false);
});

test("calculating speed never mutates the message", () => {
	const message = assistant({ content: [{ type: "text", text: "immutable output" }] });
	Object.freeze(message.content[0]);
	Object.freeze(message.content);
	Object.freeze(message.usage);
	Object.freeze(message);
	const before = JSON.stringify(message);
	formatSpeed(message, 1000, true);
	assert.equal(JSON.stringify(message), before);
});
