# pi-activity-summary — approved design

The user explicitly confirmed this revision after a design interview and authorized implementation and testing. Target remains this machine's Pi 1.5.0, regular TUI. Do not upgrade Pi, change global settings, enable the old fullscreen plugin, or force a reload of the user's running session.

## Transcript and counting

- Consecutive nonempty thinking blocks and top-level tools occupy ONE summary block. All assistant prose, including commentary, streams immediately and separates activity groups. User messages and meaningful content also separate runs.
- Pure prose and empty thinking blocks do not create summary rows.
- Adopt fullscreen's activity-entry counting: `steps = nonempty thinking blocks + top-level tool calls`. Each nonempty thinking/tool block counts once per original message/block index. Distinct sequential calls may reuse an ID without being merged. Streaming updates and tool results do not add steps.
- Model requests themselves, continuations, provider/agent retries and nested tools add no steps. A retry that produces a new thinking block or top-level tool counts that actual content.
- Display only steps and a nonzero failed-tool count; retain outcomes internally for semantic backgrounds. Ignore events carrying parentToolCallId, without inferring nesting from ID spelling. Nested calls must not change counters, theme or background. A codemode call that catches an inner failure and succeeds is a successful top-level tool.
- Results marked isError count failed tools; calls without terminal results remain open. Blocked calls with error results count failures. Do not guess results for ambiguous concurrent duplicate IDs. Adopt execution-before-declaration occurrences instead of counting them twice.
- The LAST activity determines the title: latest thinking heading/paragraph first line, or a tool's semantic renderer label with command/path/query/name fallback. Earlier parallel tool results cannot roll the title back. No extra model request or arbitrary result-body headings.
- Match the compact fullscreen grammar: `• bash: bun test · 1 step ›` or `× 检查配置 · 6 steps · 1 failed ›`. Use singular/plural step(s), omit zero failures, remove tools/ok/err/open and their alternate narrow formats. Use a trailing `⌄` when expanded; `●` denotes pending/unknown. Truncate one grammar with Pi's terminal-column helpers, preserve the trailing chevron, and sanitize untrusted terminal sequences.
- Default to collapsed. The user subsequently requested global Ctrl+O expansion and explicitly authorized manual history reflow. This supersedes the original no-expansion requirement. Preserve original messages, tool results, exports and model context; do not introduce animations or fullscreen behavior.

## Global expansion (approved follow-up)

- Reuse Pi's native `app.tools.expand` action (Ctrl+O by default) and `ctx.ui.getToolsExpanded()`. No competing shortcut registration or raw-input listener. Honor native focus/modal behavior and user-remapped keys.
- Toggle ALL activity groups, including history and groups created while expanded. Display the summary followed by the original thinking Markdown and native top-level ToolExecutionComponent payloads, as in the fullscreen reference. Ordinary prose remains outside the surface and streams without waiting for completion.
- Anchor each native tool payload to its original assistant component/block index, not a global last-value-by-tool-ID map; later messages may reuse IDs. Unmatched declarations from a batch with duplicate IDs must not capture a later assistant batch's native components. Preserve block order for same-message tool/thinking/tool and tool/prose/tool, render each instance once, and retain a fallback location for tools with no declaration.
- Preserve Markdown themes, padding, transformers, message IDs/timestamps, custom tool renderers, result expansion semantics, foreground highlighting and links. Reuse native tool instances; create thinking-only assistant display copies with native thinking visible, without modifying the source hideThinkingBlock setting. Do not synthesize extra nested-tool rows or count nested events.
- Paint the header and every text/spacing row with the SAME semantic background snapshot. Strip nested tool/code/diff backgrounds and restore the group background after ANSI resets. Preserve native graphic protocol payloads and reserved rows byte-for-byte rather than corrupting images with text padding; graphic pixels are not repainted as text.
- No bounded fullscreen viewport or mouse controls. Long output uses regular-mode terminal scrollback. Native tool truncation/file pointers still apply; expansion cannot recover content absent from the stored tool result.
- The expansion flag is view-only: no new session entry/schema/context change. Reload follows the host's current flag; a fresh UI starts with its native collapsed default. Final model/provider diagnostics remain the existing concise notice, while explicitly expanded tool errors use the native result renderer.

## Comfortable collapsed layout (approved follow-up)

- The user selected THREE rows for a collapsed block: one same-background blank row, the single summary text row, then one same-background blank row. The user subsequently removed the horizontal insets: summary text starts at column zero and uses the full available width. Keep end-of-line background fill, but reserve no content columns for left/right padding. No border characters or half-line spacing.
- Add one unpainted empty row before each activity group in both collapsed and expanded mode, matching native ToolExecutionComponent's `Spacer(1)`. This is outside the surface and is not part of the three-row collapsed header. Compute the block position AFTER this separator; only the separator scrolling offscreen must not freeze the still-visible block. Add it once per group, never per tool or frame.
- Expanded layout INSIDE the surface remains unchanged: one header row and the existing native payload spacing. Do not stack the collapsed padding on top of native expanded spacers.
- The user explicitly selected keeping regular mode rather than migrating to fullscreen or enabling an experimental mouse bridge. Do not add mouse interception or per-group mouse expansion. Native Ctrl+O stays global.
- Spacing and expansion are view-only. The user later authorized enabling the package and replacing statistics persistence with raw-source reconstruction. Do not alter settings or force reload as part of this implementation.

## Full-width state background

Use the CURRENT Pi theme, not fixed RGB values. Pad all three collapsed rows to the available transcript width; use the same frozen semantic snapshot for padding and text. Expanded headers remain one row, with native payload rows added only when expanded. Keep counters subordinate with dim text and restore background/foreground after ANSI resets emitted by native truncation.

Priority:
1. A known top-level tool failure or final model request failure uses `toolErrorBg`.
2. Otherwise active segments, open tools, unknown state, user interruption and length-limited output use `toolPendingBg`.
3. A normally ended segment with no failure/open calls uses `toolSuccessBg`. Pure thinking counts as complete when its segment normally ends; this is not a judgement about reasoning correctness.

Prose starts a normal segment boundary; agent_settled ends the final current segment. A final model failure/abort/length limit only changes the current segment, not earlier closed groups. Transient retry errors must not paint a segment as a final model failure. Keep the existing single concise terminal notice.

## Rendering and freezing

- Background state and all numbers share ONE snapshot, throttled to at most one live update per 250ms. Never read live Group state separately when painting a frozen row.
- At a prose boundary or final settlement, flush the current row once even within 250ms ONLY when still safely redrawable; then freeze. Never delay prose.
- Automatic updates freeze summary blocks whose first row is above previousViewportTop, including color-only changes. Even if only the upper padding row is offscreen, freeze all three rows atomically. Calculate the body start from the actual rendered header height (and previous-frame height), never a hard-coded +1/-1 offset. Expanded payloads also keep their offscreen prefix unchanged; visible-tail appends are allowed when that prefix is identical. If an update would alter/shrink the protected prefix, retain the previous body until an explicit redraw/toggle. Internal state may advance.
- A manual global toggle explicitly authorizes height changes/history reflow: discard display snapshots and read the latest known state and original payloads. Pi may clear/rebuild scrollback for this action. Afterward automatic offscreen protection applies again. Never infer new counts or terminal evidence from expansion.
- Theme invalidation reapplies the current palette to the frozen semantic state; it does not unfreeze statistics/completion. Host-initiated resize/theme/reload can still redraw, so do not promise that Pi never clears its screen.
- Keep the isolated shape-checked Pi 1.5 private transcript bridge, native prose metadata/transformers and lifecycle cleanup. Fail open with one warning on unsupported versions/layouts/modes. Non-TUI is a quiet no-op.

## Raw-source reconstruction (approved replacement for persistence)

- The user explicitly selected the fullscreen-style source of truth: existing original thinking/tool entries, NOT extra plugin statistics. Remove all v1/v2 schema, save, incremental-commit, anchor-validation and migration code. Never append custom entries; the runtime ignores existing custom records and never treats them as artificial boundaries. The user subsequently authorized deleting old records across local sessions as a separate one-shot OFFLINE maintenance operation, without backups (explicitly requested) and with parent-link repair, not runtime migration/deletion code.
- Restore only the active branch's original assistant/toolResult messages using the same observation/result logic as live events. History gets concrete entry counts even without plugin metadata. Repeated deltas/results do not add entries. Missing results stay open; source absence never proves success.
- Original terminal messages preserve adjacent run boundaries. Tool-bearing stop/length responses continue through tool results; hidden boundary instructions can also continue a no-tool stop/length response. Defer replay settlement until continuation evidence or the next user/visible boundary/EOF is known. Transient error attempts may continue; only final error/interruption/length evidence creates a concise notice. EOF or all-successful tools alone is not normal-completion evidence.
- An abort before any assistant message has no reconstructible notice if the raw history contains no evidence. Preserve the live notice, but do not manufacture one on resume or restore plugin-only saved notices.
- Keep native payload placement by original block occurrence, including sequentially reused IDs. Fallback partitions must follow source order and not merge unknown entries across known activities; recalculate partitions when entries become known.
- Original messages, results, exports and model context remain unchanged. A frozen presentation may intentionally lag the raw state; Ctrl+O/reload refreshes it. This is the existing boundary/offscreen policy, not missing history statistics.

## Verification

Run `bun test` and `bun run typecheck`. Tests use synthetic fixtures/fake in-process providers, not actual user sessions or live model requests.

Cover three-row collapsed vertical padding with no horizontal insets (full content width, including tiny widths), same-background coverage on every padding cell, atomic offscreen freezing when only the top padding row is offscreen, variable header-height body geometry, unchanged expanded spacing, nonempty/empty thinking, repeated deltas, prose segmentation, top-level parallel/blocked calls, nested exclusion, model retry/continuation behavior, failure priority, pure-thinking completion, abort/length/final failure, light/dark themes, Unicode widths including 1/2/8/40/80, every cell's background, ANSI reset containment, atomic throttling/final flush/offscreen freeze, theme changes, exact compact grammar, raw-source history reconstruction, ignored old/corrupt plugin records, zero custom-entry writes, execution-before-declaration adoption, duplicate IDs, fallback source order, and active-branch isolation.

Keep native TUI and full InteractiveMode/AgentSession tests, including immediate commentary, collapsed error bodies, queued follow-ups and identical summary text/colors across reload/resume. Also cover real Ctrl+O key delivery, all-history toggling, tools created mid-stream, modal focus, expanded reload/fresh resume, native custom renderers, interleaved blocks/reused IDs/orphan tools, same-background payloads, native Kitty/iTerm image transport/fold cleanup, offscreen-prefix protection, visible-tail updates and manual snapshot refresh. Captured-terminal automation does not replace human visual acceptance in the user's terminal.
