import type { AssistantMessage } from "@earendil-works/pi-ai";
import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const REFRESH_MS = 250;

export function formatSpeed(message: AssistantMessage | undefined, elapsedMs: number, final = false): string {
	const output = message?.usage.output ?? 0;
	// Mid-stream usage can be an initial snapshot (Anthropic often reports 1).
	// Only a successful terminal message makes the reported output authoritative.
	const measured = final && message?.stopReason !== "aborted" && message?.stopReason !== "error" && output > 0;
	const tokens = measured ? output : Math.max(output, message ? estimateTokens(message) : 0);
	const rate = tokens > 0 && elapsedMs > 0
		? `${measured ? "" : "~"}${(tokens * 1000 / elapsedMs).toFixed(1)}`
		: "—";
	const stopped = final && (message?.stopReason === "aborted" || message?.stopReason === "error")
		? ` (${message.stopReason === "aborted" ? "stopped" : "error"})`
		: "";
	return `↑ ${rate} tok/s${stopped}`;
}

export default function tokenSpeed(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let response: { message: AssistantMessage; startedAt: number; elapsedBeforeStart: number } | undefined;

	function stopTimer() {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	}

	function elapsed() {
		return response ? response.elapsedBeforeStart + performance.now() - response.startedAt : 0;
	}

	function reset(ctx: ExtensionContext, hide = false) {
		stopTimer();
		response = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, hide ? undefined : ctx.ui.theme.fg("dim", "↑ — tok/s"));
		}
	}

	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("model_select", (_event, ctx) => reset(ctx));
	pi.on("turn_start", (_event, ctx) => reset(ctx));

	pi.on("message_start", (event, ctx) => {
		if (!ctx.hasUI || event.message.role !== "assistant") return;
		stopTimer();
		response = {
			message: event.message,
			startedAt: performance.now(),
			// message_start can arrive after headers or the first byte. Include that wait.
			elapsedBeforeStart: Math.max(0, Date.now() - event.message.timestamp),
		};
		const render = () => {
			if (!response) return;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", formatSpeed(response.message, elapsed())));
		};
		render();
		timer = setInterval(render, REFRESH_MS);
		timer.unref();
	});

	pi.on("message_update", (event) => {
		if (response && event.message.role === "assistant") response.message = event.message;
	});

	pi.on("message_end", (event, ctx) => {
		if (!ctx.hasUI || event.message.role !== "assistant") return;
		stopTimer();
		const duration = event.message.durationMs ?? elapsed();
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatSpeed(event.message, duration, true)));
		response = undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		stopTimer();
		if (response && ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatSpeed(response.message, elapsed())));
		}
		response = undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => reset(ctx, true));
}
