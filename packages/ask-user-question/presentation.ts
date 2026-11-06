import { waitForRetry } from "./questionnaire-lifecycle.ts";

/** Keep transcript space above the inline question, including in short terminals. */
export const INLINE_ROW_RATIO = 0.7;
export const INLINE_MIN_ROWS = 12;
export type RowBudget = (terminalRows: number) => number;
export const fullRowBudget: RowBudget = (terminalRows) => terminalRows;
export const HOST_ALLOCATED_ROWS = Symbol.for("rpiv-ask-user-question:host-allocated-rows");

function hostAllocatesRows(terminal: object): boolean {
	return (terminal as Record<symbol, unknown>)[HOST_ALLOCATED_ROWS] === true;
}

export function rowBudgetForHost(terminal: object, budget: RowBudget): RowBudget {
	return hostAllocatesRows(terminal) ? fullRowBudget : budget;
}

export const inlineRowBudget: RowBudget = (terminalRows) =>
	Math.min(terminalRows, Math.max(INLINE_MIN_ROWS, Math.floor(terminalRows * INLINE_ROW_RATIO)));

type OverlayHost = { terminal: object; hasOverlay?: () => boolean };

/**
 * Keep the upstream feature-detected capture check: nonCapturing HUDs do not block.
 * The topmost-overlay query is not in all hosts' typings; older hosts use the
 * conservative public hasOverlay fallback. Never hide or take over another overlay.
 */
export function mustYieldInlineSlot(tui: OverlayHost): boolean {
	if (hostAllocatesRows(tui.terminal)) return false;
	const { getTopmostVisibleOverlay } = tui as { getTopmostVisibleOverlay?: () => unknown };
	if (typeof getTopmostVisibleOverlay === "function") return getTopmostVisibleOverlay.call(tui) !== undefined;
	return typeof tui.hasOverlay === "function" && tui.hasOverlay();
}

/**
 * Called from the asynchronous custom-component factory, before Pi mounts anything.
 * Checks only while another capturing overlay exists, not for status/notifications.
 * Cancellation clears the pending timer and prevents a late, invisible question.
 */
export async function waitForInlineSlot(tui: OverlayHost, signal: AbortSignal): Promise<boolean> {
	while (!signal.aborted && mustYieldInlineSlot(tui)) await waitForRetry(signal);
	return !signal.aborted;
}
