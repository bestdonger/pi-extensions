import assert from "node:assert/strict";
import { test } from "node:test";
import tokenSpeed, { formatSpeed } from "../src/index.ts";

const SAMPLE_TYPE = "token-speed-sample-v1";

function assistant(output = 0, overrides = {}) {
	return {
		role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "gpt-5.5",
		timestamp: 10_000, stopReason: "stop",
		usage: {
			input: 1000, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

function sample(outputTokens, decodeMs) {
	return { type: "custom", customType: SAMPLE_TYPE, data: { outputTokens, decodeMs } };
}

function harness(t, hasUI = true) {
	let now = 0;
	let branch = [];
	const handlers = new Map();
	const statuses = new Map([["openai-fast-mode", "fast:on"]]);
	const writes = [];
	const records = [];
	t.mock.method(performance, "now", () => now);
	t.mock.method(globalThis, "setInterval", () => assert.fail("token speed must not start a refresh timer"));
	const ctx = {
		hasUI,
		sessionManager: { getBranch: () => branch },
		ui: hasUI ? {
			theme: { fg: (_color, text) => text },
			setStatus: (key, value) => { statuses.set(key, value); writes.push([key, value]); },
		} : undefined,
	};
	tokenSpeed({
		on(name, callback) { handlers.set(name, callback); },
		appendEntry(customType, data) {
			const entry = { type: "custom", customType, data };
			records.push(entry);
			branch.push(entry);
		},
	});
	const h = {
		ctx, handlers, writes, records, statuses,
		get status() { return statuses.get("token-speed"); },
		emit(name, event = {}) { return handlers.get(name)?.(event, ctx); },
		advance(ms) { now += ms; },
		setBranch(entries) { branch = entries; },
		start(message = assistant()) { h.emit("message_start", { message }); },
		update(type = "text_delta", delta = "chunk", message = assistant()) {
			h.emit("message_update", { message, assistantMessageEvent: { type, delta, contentIndex: 0, partial: message } });
		},
		finish(output, overrides = {}) { h.emit("message_end", { message: assistant(output, overrides) }); },
		respond(output, duration = 1000, wait = 2000, overrides = {}) {
			h.start();
			h.advance(wait);
			h.update();
			h.advance(duration);
			h.finish(output, overrides);
		},
	};
	h.emit("session_start");
	return h;
}

test("format is compact, with a new speed icon and no spaces", () => {
	assert.equal(formatSpeed(0, 0), "↯—tok/s");
	assert.equal(formatSpeed(200, 4000), "↯50tok/s");
	assert.equal(formatSpeed(165, 2000), "↯83tok/s");
	assert.equal(formatSpeed(17, 2000), "↯8.5tok/s");
	assert.equal(formatSpeed(1, 3000), "↯0.3tok/s");
	assert.equal(formatSpeed(20, 1000).includes(" "), false);
});

test("startup shows a placeholder without creating a timer", t => {
	const h = harness(t);
	assert.equal(h.status, "↯—tok/s");
	assert.equal(h.records.length, 0);
});

test("request wait and native whole-response duration are not decode time", t => {
	const h = harness(t);
	h.respond(100, 1000, 20_000, { durationMs: 21_000 });
	assert.equal(h.status, "↯100tok/s");
	assert.deepEqual(h.records, [sample(100, 1000)]);
});

test("cumulative speed is total tokens / total decode time, not average rates or latest response", t => {
	const h = harness(t);
	h.respond(100, 1000);
	h.respond(100, 9000);
	assert.equal(h.status, "↯20tok/s"); // Not (100 + 11.1) / 2, and not 11.1.
	assert.deepEqual(h.records, [sample(100, 1000), sample(100, 9000)]);
});

test("streaming never publishes estimates or initial usage snapshots", t => {
	const h = harness(t);
	const writes = h.writes.length;
	h.start();
	h.advance(1000);
	h.update("text_delta", "x".repeat(400), assistant(1));
	for (let n = 0; n < 1000; n++) h.update("text_delta", "more", assistant(1));
	h.advance(2000);
	assert.equal(h.status, "↯—tok/s");
	assert.equal(h.writes.length, writes);
	assert.equal(h.records.length, 0);
	h.finish(100);
	assert.equal(h.status, "↯50tok/s");
	assert.deepEqual(h.records, [sample(100, 2000)]);
});

for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
	test(`${type} starts timing at its first nonempty delta`, t => {
		const h = harness(t);
		h.start();
		h.advance(3000);
		h.update(type, "");
		h.advance(2000);
		h.update(type, " ");
		h.advance(1000);
		h.update(type, "later");
		h.advance(1000);
		h.finish(80);
		assert.deepEqual(h.records, [sample(80, 2000)]);
		assert.equal(h.status, "↯40tok/s");
	});
}

test("a name-bearing tool call counts as the first token before argument deltas", t => {
	const h = harness(t);
	h.start();
	h.advance(2000);
	h.update("toolcall_start", "", assistant(0, { content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }));
	h.advance(1000);
	h.update("toolcall_delta", '{"command":"pwd"}');
	h.advance(1000);
	h.finish(60, { stopReason: "toolUse" });
	assert.deepEqual(h.records, [sample(60, 2000)]);
});

test("block starts, ends and unnamed empty tool calls do not invent a first token", t => {
	const h = harness(t);
	h.start();
	for (const type of ["text_start", "thinking_start", "text_end", "thinking_end", "toolcall_end"]) {
		h.update(type, "", assistant(0, { content: [{ type: "text", text: "shared partial already mutated" }] }));
	}
	h.update("toolcall_start", "", assistant(0, { content: [{ type: "toolCall", id: "", name: "", arguments: {} }] }));
	h.advance(1000);
	h.finish(100);
	assert.equal(h.status, "↯—tok/s");
	assert.equal(h.records.length, 0);
});

test("reasoning output is taken from final usage without double counting content", t => {
	const h = harness(t);
	h.respond(180, 3000, 1000, { content: [{ type: "thinking", thinking: "brief visible summary" }] });
	assert.equal(h.status, "↯60tok/s");
});

test("input, cache and cost fields are not included", t => {
	const h = harness(t);
	const message = assistant(100);
	message.usage.cacheRead = 20_000;
	message.usage.cost.total = 9;
	h.start();
	h.update();
	h.advance(2000);
	h.emit("message_end", { message });
	assert.equal(h.status, "↯50tok/s");
});

for (const stopReason of ["aborted", "error"]) {
	test(`${stopReason} does not count stale partial usage or erase completed statistics`, t => {
		const h = harness(t);
		h.respond(80, 2000);
		h.respond(1, 10000, 1000, { stopReason });
		assert.equal(h.status, "↯40tok/s");
		assert.equal(h.records.length, 1);
	});
}

test("length-limited successful responses contribute their final usage", t => {
	const h = harness(t);
	h.respond(80, 2000, 1000, { stopReason: "length" });
	assert.equal(h.status, "↯40tok/s");
});

test("missing/zero output usage, absent first tokens and zero decode time do not enter totals", t => {
	const h = harness(t);
	h.respond(80, 2000);
	h.respond(0);
	h.respond(100, 0);
	h.start();
	h.advance(1000);
	h.finish(500);
	h.finish(999, { durationMs: 1000 });
	assert.equal(h.status, "↯40tok/s");
	assert.equal(h.records.length, 1);
});

test("tool execution, waiting and empty responses keep the same value without redraws", t => {
	const h = harness(t);
	h.respond(80, 2000, 1000, { stopReason: "toolUse" });
	const writes = h.writes.length;
	for (const role of ["user", "toolResult", "custom"]) {
		h.emit("message_start", { message: { role } });
		h.advance(60_000);
		h.emit("message_end", { message: { role } });
	}
	h.emit("agent_end");
	h.emit("turn_start");
	h.emit("model_select");
	h.respond(0, 1000, 60_000);
	h.advance(3600_000);
	assert.equal(h.status, "↯40tok/s");
	assert.equal(h.writes.length, writes);
	h.respond(120, 3000);
	assert.equal(h.status, "↯40tok/s");
	assert.equal(h.writes.length, writes); // Even an unchanged rounded result is deduplicated.
});

test("changing models retains whole-session totals and does not interrupt current timing", t => {
	const h = harness(t);
	h.respond(100, 1000);
	h.start();
	h.update();
	h.emit("model_select");
	h.advance(4000);
	h.finish(100, { provider: "anthropic", model: "claude-sonnet-4-5", api: "anthropic-messages" });
	assert.equal(h.status, "↯40tok/s");
});

for (const name of ["session_start", "session_tree"]) {
	test(`${name} restores all current-branch samples, including those before compaction`, t => {
		const h = harness(t);
		h.setBranch([
			sample(100, 1000),
			{ type: "compaction", summary: "old context summarized" },
			sample(100, 9000),
			{ type: "custom", customType: "another-extension", data: {} },
			{ type: "message", message: assistant(2000, { durationMs: 1000 }) },
		]);
		h.emit(name);
		assert.equal(h.status, "↯20tok/s");
		assert.equal(h.records.length, 0);
		h.respond(100, 5000);
		assert.equal(h.status, "↯20tok/s");
	});
}

test("old history without first-token samples is not assigned invented decode timing", t => {
	const h = harness(t);
	h.setBranch([{ type: "message", message: assistant(2000, { durationMs: 1000 }) }]);
	h.emit("session_start");
	assert.equal(h.status, "↯—tok/s");
});

test("reloads do not count samples twice and abandoned branches cannot leak statistics", t => {
	const h = harness(t);
	h.respond(100, 1000);
	h.emit("session_start");
	h.emit("session_start");
	h.respond(100, 9000);
	assert.equal(h.status, "↯20tok/s");
	h.setBranch([sample(30, 1000)]);
	h.emit("session_tree");
	assert.equal(h.status, "↯30tok/s");
	h.setBranch([]);
	h.emit("session_start");
	assert.equal(h.status, "↯—tok/s");
});

test("branch navigation discards unfinished timing", t => {
	const h = harness(t);
	h.start();
	h.update();
	h.emit("session_tree");
	h.advance(1000);
	h.finish(100);
	assert.equal(h.records.length, 0);
});

test("agent_end discards an unfinished stream without counting it on the next response", t => {
	const h = harness(t);
	h.start();
	h.update();
	h.advance(1000);
	h.emit("agent_end");
	h.finish(100);
	assert.equal(h.records.length, 0);
	h.respond(20, 1000);
	assert.equal(h.status, "↯20tok/s");
});

test("headless execution records samples but never calls UI or starts a timer", t => {
	const h = harness(t, false);
	h.respond(80, 2000);
	h.emit("session_start");
	h.emit("model_select");
	h.emit("session_shutdown");
	assert.deepEqual(h.records, [sample(80, 2000)]);
	assert.equal(h.writes.length, 0);
});

test("finished statistics remain in the readable accent color", t => {
	const h = harness(t);
	const colors = [];
	h.ctx.ui.theme.fg = (color, text) => { colors.push(color); return text; };
	h.respond(80, 2000);
	assert.equal(colors.at(-1), "accent");
});

test("session shutdown clears the status and all active timing", t => {
	const h = harness(t);
	h.respond(80, 2000);
	h.start();
	h.update();
	h.emit("session_shutdown");
	assert.equal(h.status, undefined);
	h.advance(1000);
	h.finish(100);
	assert.equal(h.status, undefined);
	assert.equal(h.records.length, 1);
});

test("Fast Mode, provider requests and assistant messages are not modified", t => {
	const h = harness(t);
	const message = assistant(80, { durationMs: 9999 });
	const before = structuredClone(message);
	h.start(message);
	h.update("text_delta", "answer", message);
	h.advance(2000);
	h.emit("message_end", { message });
	assert.deepEqual(message, before);
	assert.equal(h.statuses.get("openai-fast-mode"), "fast:on");
	assert.equal(h.handlers.has("before_provider_request"), false);
});
