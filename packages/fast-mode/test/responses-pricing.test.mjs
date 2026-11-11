import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ai } from "./host-modules.mjs";
import { withServiceTierPricing } from "../src/provider-pricing.ts";

const load = (path) => import(pathToFileURL(path).href);
const { stream, streamSimple } = await load(join(ai, "dist/api/openai-responses.js"));
const { OPENAI_MODELS } = await load(join(ai, "dist/providers/openai.models.js"));
const model = OPENAI_MODELS["gpt-6.1-sol"];
const provider = { id: "openai", getModels: () => [model], stream, streamSimple };
const context = { messages: [{ role: "user", content: "offline subscription test", timestamp: 0 }] };

function fixture(requested, reported, apiKey) {
	const sent = [];
	return {
		sent,
		options: {
			apiKey, reasoning: "high",
			onPayload: (payload) => ({ ...payload, service_tier: requested }),
			fetch: async (_url, init) => {
				sent.push(JSON.parse(String(init.body)));
				const response = {
					id: "offline-response", status: "completed", output: [],
					usage: { input_tokens: 300000, output_tokens: 80, total_tokens: 300080, input_tokens_details: { cached_tokens: 1000 } },
					...(reported === undefined ? {} : { service_tier: reported }),
				};
				return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
			},
		},
	};
}

const standard = (await streamSimple(model, context, fixture("default", "default", "sk-offline-test").options).result()).usage.cost;
for (const auth of ["subscription", "api-key", "gateway", "custom-provider"]) {
	for (const requested of ["priority", "default"]) {
		for (const reported of [undefined, "default", "priority", "fast", "flex"]) {
			test(`Responses ${auth}: ${requested} with ${reported ?? "missing"} echo`, async () => {
				const selected = { ...model };
				if (auth === "gateway") selected.baseUrl = "https://example.invalid/v1";
				if (auth === "custom-provider") selected.provider = "offline-provider";
				const f = fixture(requested, reported, auth === "api-key" ? "sk-offline-test" : "offline-oauth-token");
				const observations = [];
				const result = await withServiceTierPricing(provider, (o) => observations.push(o)).streamSimple(selected, context, f.options).result();
				assert.equal(result.stopReason, "stop", result.errorMessage);
				const tier = auth === "subscription" && reported === "default" ? requested : reported ?? requested;
				const multiplier = ["priority", "fast"].includes(tier) ? 2 : tier === "flex" ? 0.5 : 1;
				for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
					assert.equal(result.usage.cost[field], standard[field] * multiplier, field);
				}
				assert.equal(f.sent[0].service_tier, requested);
				// The host uses configuration_update for API-key/gateway effort changes,
				// but subscription requests keep the effort in the top-level reasoning field.
				assert.equal(f.sent[0].reasoning.effort, auth === "subscription" ? "high" : "medium");
				if (auth !== "subscription") assert.equal(result.providerThinkingLevel, "high");
				assert.deepEqual(observations, [{ provider: selected.provider, model: selected.id, requestedTier: requested, responseTier: reported, subscription: auth === "subscription" }]);
				assert.ok(!JSON.stringify(observations).includes(f.options.apiKey));
			});
		}
	}
}

test("subscription estimates and observations are stable across iteration and repeated result()", async () => {
	const observations = [];
	const output = withServiceTierPricing(provider, (o) => observations.push(o)).streamSimple(model, context, fixture("priority", "default", "offline-oauth-token").options);
	let terminal;
	for await (const event of output) if (event.type === "done") terminal = event.message;
	assert.equal(await output.result(), terminal);
	assert.equal(await output.result(), terminal);
	assert.equal(terminal.usage.cost.total, standard.total * 2);
	assert.equal(observations.length, 1);
});

test("subscription native stream options are not double-priced", async () => {
	const f = fixture("priority", "default", "offline-oauth-token");
	const result = await withServiceTierPricing(provider).stream(model, context, { ...f.options, serviceTier: "priority" }).result();
	assert.equal(result.usage.cost.total, standard.total * 2);
});

test("concurrent subscription requests retain their own estimate and observation", async () => {
	const observations = [];
	const wrapped = withServiceTierPricing(provider, (o) => observations.push(o));
	const [priority, normal] = await Promise.all(["priority", "default"].map((tier) =>
		wrapped.streamSimple(model, context, fixture(tier, "default", "offline-oauth-token").options).result(),
	));
	assert.equal(priority.usage.cost.total, normal.usage.cost.total * 2);
	assert.deepEqual(observations.map((o) => o.requestedTier).sort(), ["default", "priority"]);
});

test("subscription requests without a tier override keep native pricing", async () => {
	const f = fixture("priority", "default", "offline-oauth-token");
	delete f.options.onPayload;
	const result = await withServiceTierPricing(provider).streamSimple(model, context, f.options).result();
	assert.equal(result.usage.cost.total, standard.total);
});
