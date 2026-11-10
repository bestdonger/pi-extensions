import { calculateCost } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";

type Stream = ReturnType<Provider["streamSimple"]>;

/** Keep each request's tier and response local, including concurrent cache refreshes. */
function withPricing(
	model: Model<any>,
	options: StreamOptions | undefined,
	start: (options: StreamOptions) => Stream,
): Stream {
	let requestedTier: string | undefined;
	let responseTier: string | undefined;
	const source = start({
		...options,
		onPayload: async (payload, requestModel) => {
			const replacement = await options?.onPayload?.(payload, requestModel);
			requestedTier = ((replacement ?? payload) as { service_tier?: string }).service_tier;
			return replacement;
		},
		onProviderStreamEvent: async (data, requestModel) => {
			const event = data as { type?: string; service_tier?: string; response?: { service_tier?: string } };
			if (["response.completed", "response.done", "response.incomplete"].includes(event.type ?? "")) {
				responseTier = event.response?.service_tier;
			} else if (event.service_tier !== undefined) {
				responseTier = event.service_tier;
			}
			await options?.onProviderStreamEvent?.(data, requestModel);
		},
	});
	const corrected = new WeakSet<AssistantMessage>();

	function correct(message: AssistantMessage): AssistantMessage {
		if (
			(requestedTier !== "priority" && requestedTier !== "default") ||
			message.usage.cost.totalFromProvider ||
			corrected.has(message)
		) return message;

		const codexFallback = message.api === "openai-codex-responses" &&
			(responseTier === undefined || responseTier === "default");
		const completions = message.api === "openai-completions";
		const responsesFallback = message.api === "openai-responses" && responseTier === undefined;
		if (!codexFallback && !completions && !responsesFallback) return message;

		// Match the host's Responses tier policy; Codex also trusts an explicitly requested
		// priority tier when its backend echoes default. Completions needs the multiplier
		// even when its completion chunk explicitly reports priority.
		const tier = codexFallback && responseTier === "default" && requestedTier === "priority"
			? requestedTier
			: responseTier ?? requestedTier;
		const multiplier = tier === "priority" ? (model.id === "gpt-5.5" ? 2.5 : 2) : tier === "flex" ? 0.5 : 1;
		// Recompute from host catalog rates, including context tiers, rather than multiplying
		// an estimate that the host may already have adjusted.
		const cost = calculateCost(model, message.usage);
		cost.input *= multiplier;
		cost.output *= multiplier;
		cost.cacheRead *= multiplier;
		cost.cacheWrite *= multiplier;
		cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
		corrected.add(message);
		return message;
	}

	// Keep the original stream contract; both agent iteration and complete()/cache warming
	// see the same corrected terminal message, without starting a second consumer.
	const result = source.result.bind(source);
	source.result = async () => correct(await result());
	const iterate = source[Symbol.asyncIterator].bind(source);
	source[Symbol.asyncIterator] = async function* () {
		for await (const event of { [Symbol.asyncIterator]: iterate }) {
			if (event.type === "done") correct(event.message);
			if (event.type === "error") correct(event.error);
			yield event;
		}
	};
	return source;
}

/** Patch only stream methods: re-registering a provider discards legacy model auth/headers. */
export function installServiceTierPricing(provider: Provider): () => void {
	const stream = provider.stream;
	const streamSimple = provider.streamSimple;
	const wrapped = withServiceTierPricing({
		...provider,
		stream: stream.bind(provider),
		streamSimple: streamSimple.bind(provider),
	});
	provider.stream = wrapped.stream;
	provider.streamSimple = wrapped.streamSimple;
	return () => {
		if (provider.stream === wrapped.stream) provider.stream = stream;
		if (provider.streamSimple === wrapped.streamSimple) provider.streamSimple = streamSimple;
	};
}

export function withServiceTierPricing(provider: Provider): Provider {
	return {
		...provider,
		stream(model, context, options) {
			return withPricing(model, options, (next) => provider.stream(model, context, next as typeof options));
		},
		streamSimple(model, context, options) {
			return withPricing(model, options, (next) => provider.streamSimple(model, context, next));
		},
	};
}
