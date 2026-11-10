import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { ai, host } from "./host-modules.mjs";
import fastMode from "../src/index.ts";
import { withServiceTierPricing } from "../src/provider-pricing.ts";

const load = (path) => import(pathToFileURL(path).href);
const { stream, streamSimple } = await load(join(ai, "dist/api/openai-codex-responses.js"));
const completions = await load(join(ai, "dist/api/openai-completions.js"));
const { OPENAI_CODEX_MODELS } = await load(join(ai, "dist/providers/openai-codex.models.js"));
const { ModelRuntime } = await load(join(host, "dist/core/model-runtime.js"));
const { AuthStorage } = await load(join(host, "dist/core/auth-storage.js"));
const model = OPENAI_CODEX_MODELS["gpt-6.1-sol"];
const provider = { id: model.provider, getModels: () => [model], stream, streamSimple };
const context = { messages: [{ role: "user", content: "offline pricing test", timestamp: 0 }] };
// Synthetic JWT for the local adapter's account-id parser, never sent to a network.
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64url")}.test`;

function options(tier, reported, eventType = "response.completed") {
	const sent = [], observed = [];
	return {
		sent, observed,
		value: {
			apiKey: token, transport: "sse", reasoning: "high",
			onPayload: (payload) => ({ ...payload, service_tier: tier }),
			onProviderStreamEvent: (event) => observed.push(event),
			fetch: async (_url, init) => {
				const body = new Headers(init.headers).get("content-encoding") === "zstd"
					? zlib.zstdDecompressSync(init.body).toString() : String(init.body);
				sent.push(JSON.parse(body));
				const response = {
					id: "offline-response", status: "completed", output: [],
					usage: { input_tokens: 300000, output_tokens: 80, total_tokens: 300080, input_tokens_details: { cached_tokens: 1000 } },
					...(reported === undefined ? {} : { service_tier: reported }),
				};
				return new Response(`data: ${JSON.stringify({ type: eventType, response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
			},
		},
	};
}

async function nativeCost(tier, reported, selected = model, eventType) {
	return (await stream(selected, context, { ...options(tier, reported, eventType).value, serviceTier: tier }).result()).usage.cost;
}

for (const tier of ["priority", "default"]) {
	for (const reported of [undefined, "default", "priority", "flex"]) {
		test(`Codex ${tier} with reported ${reported ?? "missing"} matches native tier pricing`, async () => {
			const fixture = options(tier, reported);
			const actual = await withServiceTierPricing(provider).streamSimple(model, context, fixture.value).result();
			assert.equal(actual.stopReason, "stop", actual.errorMessage);
			assert.deepEqual(actual.usage.cost, await nativeCost(tier, reported));
			assert.equal(fixture.sent[0].service_tier, tier);
			assert.equal(fixture.sent[0].reasoning.effort, "high");
			assert.equal(fixture.observed.length, 1);
		});
	}
}

test("legacy model routing headers and configuration survive installation and shutdown", async () => {
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("offline-gateway", {
		api: "openai-responses", baseUrl: "https://example.invalid/v1", apiKey: "offline-test",
		headers: { "X-Provider": "provider-header" },
		models: [{ ...model, api: "openai-responses", headers: { "X-Model-Route": "required-route" } }],
	});
	const selected = runtime.getModel("offline-gateway", model.id);
	const config = runtime.getRegisteredProviderConfig("offline-gateway");
	const before = (await runtime.getAuth(selected)).auth.headers;
	const native = runtime.getProvider("offline-gateway"), original = native.streamSimple;
	const handlers = new Map();
	fastMode({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} });
	const ctx = { model: selected, modelRegistry: runtime, sessionManager: { getBranch: () => [] }, hasUI: false };
	handlers.get("session_start")({}, ctx);
	assert.deepEqual((await runtime.getAuth(selected)).auth.headers, before);
	assert.equal(runtime.getRegisteredProviderConfig("offline-gateway"), config);
	assert.equal(runtime.getProvider("offline-gateway"), native);
	assert.notEqual(native.streamSimple, original);
	handlers.get("session_shutdown")({}, ctx);
	assert.equal(native.streamSimple, original);
	assert.deepEqual((await runtime.getAuth(selected)).auth.headers, before);
});

test("gpt-5.5 uses the host's 2.5x Codex priority multiplier", async () => {
	const selected = { ...model, id: "gpt-5.5" };
	const actual = await withServiceTierPricing(provider).streamSimple(selected, context, options("priority", "default").value).result();
	assert.deepEqual(actual.usage.cost, await nativeCost("priority", "default", selected));
});

test("direct native stream options are not double-priced", async () => {
	const actual = await withServiceTierPricing(provider).stream(model, context, { ...options("priority", "default").value, serviceTier: "priority" }).result();
	assert.deepEqual(actual.usage.cost, await nativeCost("priority", "default"));
});

test("iteration and repeated result() calls see the same cost without double pricing", async () => {
	const output = withServiceTierPricing(provider).streamSimple(model, context, options("priority", "default").value);
	let terminal;
	for await (const event of output) if (event.type === "done") terminal = event.message;
	const expected = await nativeCost("priority", "default");
	assert.deepEqual(terminal.usage.cost, expected);
	assert.equal(await output.result(), terminal);
	assert.deepEqual((await output.result()).usage.cost, expected);
});

test("response.done uses the native fallback price", async () => {
	const actual = await withServiceTierPricing(provider).streamSimple(model, context, options("priority", "default", "response.done").value).result();
	assert.deepEqual(actual.usage.cost, await nativeCost("priority", "default", model, "response.done"));
});

test("concurrent requests retain independent tiers", async () => {
	const wrapped = withServiceTierPricing(provider);
	const [priority, standard] = await Promise.all([
		wrapped.streamSimple(model, context, options("priority", "default").value).result(),
		wrapped.streamSimple(model, context, options("default", "default").value).result(),
	]);
	assert.equal(priority.usage.cost.total, standard.usage.cost.total * 2);
});

test("requests without a tier override keep their original cost", async () => {
	const { value } = options("priority", "default");
	delete value.onPayload;
	const actual = await withServiceTierPricing(provider).streamSimple(model, context, value).result();
	assert.deepEqual(actual.usage.cost, (await streamSimple(model, context, value).result()).usage.cost);
});

test("pricing snapshots the final payload rather than a later UI mode", async () => {
	let tier = "priority";
	const { value } = options("priority", "default");
	value.onPayload = async (payload) => {
		const replacement = { ...payload, service_tier: tier };
		tier = "default";
		return replacement;
	};
	const actual = await withServiceTierPricing(provider).streamSimple(model, context, value).result();
	assert.equal(tier, "default");
	assert.deepEqual(actual.usage.cost, await nativeCost("priority", "default"));
});

const completionModel = { ...model, id: "gpt-5.4", api: "openai-completions", provider: "openai", baseUrl: "https://example.invalid/v1" };
const completionProvider = { ...provider, stream: completions.stream, streamSimple: completions.streamSimple };
async function completionCost(requested, reported, upstreamCost) {
	let sent;
	const result = await withServiceTierPricing(completionProvider).streamSimple(completionModel, context, {
		apiKey: "offline-test", onPayload: (payload) => ({ ...payload, service_tier: requested }),
		fetch: async (_url, init) => {
			sent = JSON.parse(String(init.body));
			const chunk = {
				id: "offline-completion", object: "chat.completion.chunk", created: 0, model: completionModel.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 300000, completion_tokens: 80, total_tokens: 300080, prompt_tokens_details: { cached_tokens: 1000 }, ...(upstreamCost === undefined ? {} : { cost: upstreamCost }) },
				...(reported === undefined ? {} : { service_tier: reported }),
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(sent.service_tier, requested);
	return result.usage.cost;
}

for (const reported of [undefined, "priority", "default", "flex"]) {
	test(`Chat Completions priority with reported ${reported ?? "missing"} applies the correct multiplier`, async () => {
		const standard = await completionCost("default", "default");
		const actual = await completionCost("priority", reported);
		const multiplier = reported === "default" ? 1 : reported === "flex" ? 0.5 : 2;
		assert.equal(actual.total, standard.total * multiplier);
	});
}

test("provider-reported costs are preserved", async () => {
	const message = {
		api: "openai-completions", usage: { cost: { total: 42, totalFromProvider: true } },
	};
	const fake = {
		...provider,
		streamSimple(_model, _context, options) {
			const ready = options.onPayload({ service_tier: "priority" }, completionModel);
			return {
				result: async () => { await ready; return message; },
				async *[Symbol.asyncIterator]() { await ready; yield { type: "done", message }; },
			};
		},
	};
	assert.equal((await withServiceTierPricing(fake).streamSimple(completionModel, context, {}).result()).usage.cost.total, 42);
});
