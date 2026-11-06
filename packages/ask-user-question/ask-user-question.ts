import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable, QuestionnaireQueue, WAIT_MESSAGE } from "./questionnaire-lifecycle.ts";
import { type OpenQuestionnaire, registerAnswerChannel } from "./answer-channel.ts";
import { loadConfig, resolveCollapseKey, resolveNotesKey, validateGuidanceFields } from "./config.ts";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.ts";
// Static import is fine — rpc-fallback pulls only types + the i18n bridge,
// none of the ~560ms TUI render graph that QuestionnaireSession lazy-loads.
import { inlineRowBudget, rowBudgetForHost, waitForInlineSlot } from "./presentation.ts";
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.ts";
import { displayLabel, t } from "./state/i18n-bridge.ts";
import { sentinelsToAppend } from "./state/row-intent.ts";
import { normalizeQuestionParams, prepareQuestionArguments } from "./tool/normalize-params.ts";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.ts";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.ts";
import { validateQuestionnaire } from "./tool/validate-questionnaire.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";
import { renderAskCall, renderAskResult } from "./view/transcript.ts";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams, toolCallId: string): void {
	const payload: AskUserPromptEventPayload = {
		toolCallId,
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(pi: ExtensionAPI, active: boolean, toolCallId: string): void {
	const payload: AskUserBlockedEventPayload = { active, toolCallId };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

/** Non-interactive host backstop (the reconciler normally strips the tool first). */
function rejectWithoutUi() {
	return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_SESSION_LOAD_FAILED =
	"Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
	"Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

/** Standard terminal bell — same byte rpiv-warp exports as OSC_TERMINATOR. */
export const BEL = "\x07";

/**
 * Emit one portable terminal attention signal without touching redirected output.
 * Writes to stdout rather than rpiv-warp's `/dev/tty` transport: the `isTTY` gate
 * both proves an interactive terminal owns the coming wait and keeps the byte out
 * of piped RPC transports (VS Code pendant, Zed) — a `/dev/tty` write would ring
 * even when the questionnaire renders in a remote host's own UI.
 */
function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY && !process.env.REX_SESSION) process.stdout.write(BEL);
	} catch {
		// Terminal attention is best effort; the questionnaire must still proceed.
	}
}

/** Delay before the background session-graph pre-warm; mirrors rpiv-workflow's /wf prewarm. */
export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.ts");

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

/**
 * Lazy-load the ~560ms QuestionnaireSession view/TUI render graph, guarding
 * the two failure shapes of issue #107. Pi's jiti loader registers a module in
 * its graph cache BEFORE evaluating the body and does not evict it when
 * evaluation throws (jiti 2.7.0), so one failed load — e.g. `pnpm install
 * --force` replacing the store entry mid-session — leaves every later import
 * of this specifier resolving to a namespace without the class. That state is
 * unrecoverable in-process (cache-busting specifiers fail jiti resolution);
 * both branches therefore return an LLM-facing envelope that names the restart
 * requirement instead of leaking a bare "not a constructor" TypeError.
 */
export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.ts");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
		};
	}
	return { ok: true, module: mod };
}

/** No invisible placeholder is mounted while an existing overlay owns focus. */
const INERT_COMPONENT: import("./state/questionnaire-session.ts").QuestionnaireSessionComponent = {
	render: () => [],
	invalidate: () => {},
	handleInput: () => {},
};

/** One inline dialog, managed by Pi's root blocked state and the per-extension FIFO. */
async function mountQuestionnaire(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	open: OpenQuestionnaire;
	Session: SessionModule["QuestionnaireSession"];
	signal: AbortSignal;
}): Promise<QuestionnaireResult | undefined> {
	const { ctx, typed, open, Session, signal } = config;
	const settings = loadConfig();
	return ctx.ui.custom<QuestionnaireResult>(
		async (tui, theme, keybindings, done) => {
			if (open.settled) {
				done(open.settled);
				return INERT_COMPONENT;
			}
			// Attach before waiting: cancellation closes even a still-pending factory.
			open.attach(done);
			if (!(await waitForInlineSlot(tui, signal)) || open.settled) {
				done(open.settled ?? { answers: [], cancelled: true });
				return INERT_COMPONENT;
			}
			const session = new Session({
				tui,
				theme,
				params: typed,
				itemsByTab: typed.questions.map(buildItemsForQuestion),
				done: (result) => open.settle(result),
				keybindings,
				editInput: async (value) => {
					try {
						const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
							import("@earendil-works/pi-coding-agent"),
							import("./state/external-editor.ts"),
						]);
						const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
							projectTrusted: ctx.isProjectTrusted(),
						}).getExternalEditorCommand();
						if (!editorCommand) throw new Error("No external editor command is configured");
						return await editWithExternalEditor(tui, editorCommand, value);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`${t("editor.failed", "External editor failed")}: ${message}`, "error");
						return undefined;
					}
				},
				collapseKey: resolveCollapseKey(settings),
				notesKey: resolveNotesKey(settings),
				canReopenWhileHidden: false,
				rowBudget: rowBudgetForHost(tui.terminal, inlineRowBudget),
			});
			emitTerminalAttention(); // Suppressed in Rex: its native status policy owns alerts.
			return session.component;
		},
		{ overlay: false, blocked: { kind: "question", message: WAIT_MESSAGE } },
	);
}

/** RPC hosts still use their native dialogs, with cancellable host requests. */
function cancellableDialogs(ui: DialogUI, signal: AbortSignal): DialogUI {
	return {
		select: (title, options) =>
			abortable(() => ui.select(title, options, { signal }), signal, undefined),
		input: (title, placeholder) =>
			abortable(() => ui.input(title, placeholder, { signal }), signal, undefined),
	};
}

/** Late/legacy RPC fallback: undefined means the host never rendered custom UI. */
async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams, signal: AbortSignal) {
	if (hasDialogUI(ctx.ui)) {
		if (!signal.aborted) emitTerminalAttention();
		return buildQuestionnaireResponse(await runRpcQuestionnaire(cancellableDialogs(ctx.ui, signal), typed), typed);
	}
	return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
}

async function runTuiPath(ctx: ExtensionContext, typed: QuestionParams, open: OpenQuestionnaire, signal: AbortSignal) {
	// Cancellation during lazy loading does not wait for the module or open a late dialog.
	const sessionLoad = await abortable<SessionLoad | undefined>(loadQuestionnaireSession, signal, undefined);
	if (open.settled) return buildQuestionnaireResponse(open.settled, typed);
	if (!sessionLoad) return buildQuestionnaireResponse({ answers: [], cancelled: true }, typed);
	if (!sessionLoad.ok) {
		return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
	}
	const result = await mountQuestionnaire({ ctx, typed, open, Session: sessionLoad.module.QuestionnaireSession, signal });
	if (result === undefined) {
		open.host = "rpc";
		return resolveUndefinedResult(ctx, typed, signal);
	}
	return buildQuestionnaireResponse(result, typed);
}

/**
 * Pre-warm the lazy session graph once startup settles (#107). A graph
 * evaluated while the paths Pi resolved at boot still exist stays in memory
 * for the process lifetime, so later on-disk dependency churn (e.g. `pnpm
 * install --force` replacing the store mid-session) can no longer poison
 * jiti's graph cache. Swallowed failure is safe: the first real call
 * re-imports and surfaces it through loadQuestionnaireSession's structured
 * envelope. unref keeps the timer from holding a non-TUI embedder's process
 * open.
 */
function prewarmSessionGraph(): void {
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const queue = new QuestionnaireQueue();
	const activeCancellations = new Set<() => void>();
	pi.on("session_shutdown", () => {
		for (const cancel of [...activeCancellations]) cancel();
	});
	const guidance = validateGuidanceFields(loadConfig().guidance);
	const answers = registerAnswerChannel(pi);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Question",
		// Interactive: always a top-level call, never from a codemode script, so
		// codemode "only" keeps declaring it to the model (#310).
		exposure: "model-only",
		description: guidance.description ?? DEFAULT_TOOL_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,
		// Undo double-encoded nested arguments before Pi validates them (#244).
		prepareArguments: prepareQuestionArguments,
		renderCall: (args, theme) => renderAskCall(args, theme),
		renderResult: (result, { expanded }, theme, context) =>
			renderAskResult(result, context?.args, theme, { expanded, isError: context?.isError ?? false }),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			// Line-terminator normalization runs once here, ahead of validation, so
			// every downstream consumer — validator, TUI, RPC walker, envelope, prompt
			// event — sees the same clean text (#192).
			const typed = normalizeQuestionParams(params as unknown as QuestionParams);
			if (!ctx.hasUI) return rejectWithoutUi();

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// RPC hosts (VSCode pendant, ACP clients like Zed/Paseo — issue #78):
			// ui.custom() cannot render there, but the select/input dialog
			// sub-protocol works. Hosts that advertise ctx.mode (pi ≥0.79) route to
			// the sequential dialog walker up front, skipping the TUI render-graph
			// import entirely; RPC builds that predate ctx.mode are caught by the
			// custom()-resolved-undefined backstop below. See ./rpc-fallback.ts.
			const viaRpc = (ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui);
			// Open for inbound answers before the prompt goes out: an emitter may answer
			// straight from its prompt listener.
			const open = answers.open(toolCallId, typed.questions, viaRpc ? "rpc" : "tui");
			const controller = new AbortController();
			const cancel = () => {
				open.settle({ answers: [], cancelled: true });
				controller.abort();
			};
			activeCancellations.add(cancel);
			signal?.addEventListener("abort", cancel, { once: true });
			// Early external answers must also remove a queued request / cancel a load.
			void open.answeredEarly.then(() => controller.abort());
			if (signal?.aborted) cancel();
			let release: (() => void) | undefined;
			try {
				// Keep the external answer/mirroring event contract. Rex state is managed
				// ONLY by the visible inline custom dialog, not by these extension events.
				emitAskUserPromptEvent(pi, typed, toolCallId);
				emitAskUserBlockedEvent(pi, true, toolCallId);
				if (open.settled) return buildQuestionnaireResponse(open.settled, typed);
				release = await queue.acquire(controller.signal);
				if (!release || open.settled) {
					return buildQuestionnaireResponse(open.settled ?? { answers: [], cancelled: true }, typed);
				}
				if (viaRpc) {
					emitTerminalAttention();
					return buildQuestionnaireResponse(
						await runRpcQuestionnaire(cancellableDialogs(ctx.ui, controller.signal), typed),
						typed,
					);
				}
				return await runTuiPath(ctx, typed, open, controller.signal);
			} finally {
				controller.abort();
				signal?.removeEventListener("abort", cancel);
				activeCancellations.delete(cancel);
				release?.();
				answers.close(open);
				emitAskUserBlockedEvent(pi, false, toolCallId);
			}
		},
	});

	prewarmSessionGraph();
}

export { buildQuestionnaireResponse, buildToolResult };
