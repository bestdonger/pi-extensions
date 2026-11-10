import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const SAMPLE_TYPE = "token-speed-sample-v1";

interface SpeedSample {
	outputTokens: number;
	decodeMs: number;
}

export function formatSpeed(outputTokens: number, decodeMs: number): string {
	if (decodeMs <= 0) return "⚡—tok/s";
	const rate = outputTokens * 1000 / decodeMs;
	return `⚡${rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10}tok/s`;
}

function isToken(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta !== "";
		case "toolcall_start": {
			const block = event.partial.content[event.contentIndex];
			return block?.type === "toolCall" && block.name !== "";
		}
		default:
			return false;
	}
}

export default function tokenSpeed(pi: ExtensionAPI) {
	let outputTokens = 0;
	let decodeMs = 0;
	let displayed: string | undefined;
	let response: { firstTokenAt?: number } | undefined;

	function show(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const label = formatSpeed(outputTokens, decodeMs);
		const styled = ctx.ui.theme.fg(decodeMs > 0 ? "accent" : "dim", label);
		if (styled === displayed) return;
		ctx.ui.setStatus(STATUS_KEY, styled);
		displayed = styled;
	}

	function restore(ctx: ExtensionContext) {
		outputTokens = 0;
		decodeMs = 0;
		response = undefined;
		displayed = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SAMPLE_TYPE) continue;
			const sample = entry.data as SpeedSample;
			outputTokens += sample.outputTokens;
			decodeMs += sample.decodeMs;
		}
		show(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => show(ctx));

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") response = {};
	});

	pi.on("message_update", (event) => {
		if (!response || response.firstTokenAt !== undefined || !isToken(event.assistantMessageEvent)) return;
		response.firstTokenAt = performance.now();
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const firstTokenAt = response?.firstTokenAt;
		response = undefined;
		const message = event.message;
		if (firstTokenAt === undefined || message.stopReason === "aborted" || message.stopReason === "error") return;
		const sample = { outputTokens: message.usage.output, decodeMs: performance.now() - firstTokenAt };
		// Pi uses zero both for unreported output usage and for genuinely empty responses.
		if (sample.outputTokens <= 0 || sample.decodeMs <= 0) return;
		pi.appendEntry<SpeedSample>(SAMPLE_TYPE, sample);
		outputTokens += sample.outputTokens;
		decodeMs += sample.decodeMs;
		show(ctx);
	});

	pi.on("agent_end", () => { response = undefined; });
	pi.on("session_shutdown", (_event, ctx) => {
		response = undefined;
		outputTokens = 0;
		decodeMs = 0;
		displayed = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
