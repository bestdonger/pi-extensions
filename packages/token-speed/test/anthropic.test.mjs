import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { host } from "./host-modules.mjs";
import { formatSpeed } from "../src/index.ts";

const { stream } = await import(pathToFileURL(join(host, "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js")).href);

test("native Anthropic adapter's initial usage cannot masquerade as live output", async () => {
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
		if (event.type === "text_delta") {
			sawDelta = true;
			assert.equal(event.partial.usage.output, 1);
			assert.equal(formatSpeed(event.partial, 1000), "↑ ~100.0 tok/s");
		}
		if (event.type === "done") {
			sawDone = true;
			assert.equal(event.message.usage.output, 100);
			assert.equal(formatSpeed(event.message, 1000, true), "↑ 100.0 tok/s");
		}
		assert.notEqual(event.type, "error", event.type === "error" ? event.error.errorMessage : "");
	}
	assert.equal(sawDelta, true);
	assert.equal(sawDone, true);
});
