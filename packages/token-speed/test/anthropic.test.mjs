import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { host } from "./host-modules.mjs";
import tokenSpeed, { formatSpeed } from "../src/index.ts";

const { stream } = await import(pathToFileURL(join(host, "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js")).href);

test("native Anthropic initial usage is ignored until the response settles", async () => {
	const handlers = new Map();
	const readings = [];
	let status;
	const ctx = {
		hasUI: true, sessionManager: { getBranch: () => [] },
		ui: { theme: { fg: (_color, text) => text }, setStatus(_key, value) { status = value; } },
	};
	tokenSpeed({
		on(name, handler) { handlers.set(name, handler); },
		appendEntry(type, data) { assert.equal(type, "token-speed-sample-v1"); readings.push(data); },
	});
	handlers.get("session_start")({}, ctx);
	const model = {
		id: "claude-sonnet-4-5", name: "Offline Anthropic", provider: "anthropic", api: "anthropic-messages",
		baseUrl: "https://offline.invalid", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000,
	};
	const raw = [
		{ type: "message_start", message: { id: "fixture", model: model.id, usage: { input_tokens: 100, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(400) } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
		{ type: "message_stop" },
	];
	const body = new ReadableStream({
		async start(controller) {
			for (const event of raw) {
				controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
				// Let consumers observe the intermediate shared partial before final usage.
				await delay(10);
			}
			controller.close();
		},
	});
	const client = {
		beta: { messages: { create() { return { asResponse: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) }; } } },
	};
	let sawDelta = false;
	let sawDone = false;
	for await (const event of stream(model, { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, { client })) {
		assert.notEqual(event.type, "error", event.type === "error" ? event.error.errorMessage : "");
		if (event.type === "start") handlers.get("message_start")({ message: event.partial }, ctx);
		else if (event.type !== "done") handlers.get("message_update")({ message: event.partial, assistantMessageEvent: event }, ctx);
		if (event.type === "text_delta") {
			sawDelta = true;
			assert.equal(event.partial.usage.output, 1);
			assert.equal(status, "↯—tok/s");
			assert.equal(readings.length, 0);
		}
		if (event.type === "done") {
			sawDone = true;
			assert.equal(event.message.usage.output, 100);
			handlers.get("message_end")({ message: event.message }, ctx);
			assert.equal(readings.length, 1);
			assert.equal(readings[0].outputTokens, 100);
			assert.ok(readings[0].decodeMs > 0);
			assert.equal(status, formatSpeed(100, readings[0].decodeMs));
		}
	}
	assert.equal(sawDelta, true);
	assert.equal(sawDone, true);
});
