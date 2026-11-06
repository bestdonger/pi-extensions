# pi-activity-summary — approved design

The user explicitly confirmed this revision after a design interview and authorized implementation and testing. Target remains this machine's Pi 1.5.0, regular TUI. Do not upgrade Pi, change global settings, enable the old fullscreen plugin, or force a reload of the user's running session.

## Transcript and counting

- Consecutive nonempty thinking blocks and top-level tools occupy ONE summary block. All assistant prose, including commentary, streams immediately and separates activity groups. User messages and meaningful content also separate runs.
- Pure prose and empty thinking blocks do not create summary rows.
- Adopt fullscreen's activity-entry counting: `steps = nonempty thinking blocks + top-level tool calls`. A nonempty block counts once per message/block index; each tool call counts once per ID. Streaming updates and tool results do not add steps.
- Model requests themselves, continuations, provider/agent retries and nested tools add no steps. A retry that produces a new thinking block or top-level tool counts that actual content.
- `tools = ok + err + open` counts TOP-LEVEL tools only, matching steps. Ignore events carrying parentToolCallId, without inferring nesting from ID spelling. Nested calls must not change counters, theme or background. A codemode call that catches an inner failure and succeeds is a successful top-level tool.
- Results marked isError count err; calls without terminal results remain open. Do not guess missing results. Blocked calls with error results count err.
- Keep the existing thinking-title/short-paragraph preference, with tool-name fallback. No additional model request for summaries.
- Keep the one-line header format: `▸ 检查配置 | 10 steps | tools 7 (ok 5, err 1, open 1)` (`▾` when expanded). Truncate the title first, then abbreviate statistics, then steps/ellipsis on very narrow screens. Use Pi's terminal-column helpers and sanitize untrusted terminal sequences.
- Default to collapsed. The user subsequently requested global Ctrl+O expansion and explicitly authorized manual history reflow. This supersedes the original no-expansion requirement. Preserve original messages, tool results, exports and model context; do not introduce animations or fullscreen behavior.

## Global expansion (approved follow-up)

- Reuse Pi's native `app.tools.expand` action (Ctrl+O by default) and `ctx.ui.getToolsExpanded()`. No competing shortcut registration or raw-input listener. Honor native focus/modal behavior and user-remapped keys.
- Toggle ALL activity groups, including history and groups created while expanded. Display the summary followed by the original thinking Markdown and native top-level ToolExecutionComponent payloads, as in the fullscreen reference. Ordinary prose remains outside the surface and streams without waiting for completion.
- Anchor each native tool payload to its original assistant component/block index, not a global last-value-by-tool-ID map; later messages may reuse IDs. Preserve block order for same-message tool/thinking/tool and tool/prose/tool, render each instance once, and retain a fallback location for tools with no declaration.
- Preserve Markdown themes, padding, transformers, message IDs/timestamps, custom tool renderers, result expansion semantics, foreground highlighting and links. Reuse native tool instances; create thinking-only assistant display copies with native thinking visible, without modifying the source hideThinkingBlock setting. Do not synthesize extra nested-tool rows or count nested events.
- Paint the header and every text/spacing row with the SAME semantic background snapshot. Strip nested tool/code/diff backgrounds and restore the group background after ANSI resets. Preserve native graphic protocol payloads and reserved rows byte-for-byte rather than corrupting images with text padding; graphic pixels are not repainted as text.
- No bounded fullscreen viewport or mouse controls. Long output uses regular-mode terminal scrollback. Native tool truncation/file pointers still apply; expansion cannot recover content absent from the stored tool result.
- The expansion flag is view-only: no new session entry/schema/context change. Reload follows the host's current flag; a fresh UI starts with its native collapsed default. Final model/provider diagnostics remain the existing concise notice, while explicitly expanded tool errors use the native result renderer.

## Comfortable collapsed layout (approved follow-up)

- The user selected THREE rows for a collapsed block: one same-background blank row, the single summary text row, then one same-background blank row. Add two columns of left/right padding to the summary text; at tiny widths reduce padding symmetrically so at least one content column remains. No border characters or half-line spacing.
- Add one unpainted empty row before each activity group in both collapsed and expanded mode, matching native ToolExecutionComponent's `Spacer(1)`. This is outside the surface and is not part of the three-row collapsed header. Compute the block position AFTER this separator; only the separator scrolling offscreen must not freeze the still-visible block. Add it once per group, never per tool or frame.
- Expanded layout INSIDE the surface remains unchanged: one header row and the existing native payload spacing. Do not stack the collapsed padding on top of native expanded spacers.
- The user explicitly selected keeping regular mode rather than migrating to fullscreen or enabling an experimental mouse bridge. Do not add mouse interception or per-group mouse expansion. Native Ctrl+O stays global.
- This is view-only; counting, saved metadata and original messages remain unchanged. The package is currently disabled via `extensions: []` at the user's request; implementing spacing does not authorize enabling it or reloading the running session.

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

## Persistence and compatibility

- Append incremental `pi-activity-summary/v2` CUSTOM entries at agent_settled, never custom_message. Store stable message/block anchors, thinking count, top-level outcomes, theme, completion and terminal notices. They do not enter model context.
- Restore only the active branch. Check exact anchor coverage, thinking count and top-level ID membership before trusting v2 records.
- Read existing v1 records without rewriting them. With complete raw messages and matching metadata, count nonempty raw thinking blocks and identify top-level IDs from actual toolCall blocks. Filter v1's stored tool outcomes to those IDs. Never reuse the old models total as a thinking count or treat all saved tools as top-level. Rebuild v1 titles from raw top-level activity too, since nested calls could overwrite tool-only titles in v1.
- v1 empty thinking anchors may be dropped only when the raw block exists and is verifiably empty. Missing/inconsistent anchors or outcomes remain unknown rather than partially trusting a record.
- Without trusted metadata (including interrupted/unpersisted history), keep counters `—`. Unknown state is neutral, but directly observed top-level error results or a final model error still win over count uncertainty and use the failure background. Do not trust metadata that contradicts saved terminal tool results. Replayed EOF/closed flags are not proof of normal completion. For v1, use explicit terminal/prose evidence; when counts are recoverable but completion is not, keep the background neutral.
- Cache the normalized in-memory form after restore so a later run does not rewrite all historical records merely to migrate versions.

## Verification

Run `bun test` and `bun run typecheck`. Tests use synthetic fixtures/fake in-process providers, not actual user sessions or live model requests.

Cover three-row collapsed padding and two-column insets (shrinking at tiny widths), same-background coverage on every padding cell, atomic offscreen freezing when only the top padding row is offscreen, variable header-height body geometry, unchanged expanded spacing, nonempty/empty thinking, repeated deltas, prose segmentation, top-level parallel/blocked calls, nested exclusion, model retry/continuation behavior, failure priority, pure-thinking completion, abort/length/final failure, light/dark themes, Unicode widths including 1/2/8/40/80, every cell's background, ANSI reset containment, atomic throttling/final flush/offscreen freeze, theme changes, incremental v2 records, trusted v1 migration, unknown/corrupt history and active-branch isolation.

Keep native TUI and full InteractiveMode/AgentSession tests, including immediate commentary, collapsed error bodies, queued follow-ups and identical summary text/colors across reload/resume. Also cover real Ctrl+O key delivery, all-history toggling, tools created mid-stream, modal focus, expanded reload/fresh resume, native custom renderers, interleaved blocks/reused IDs/orphan tools, same-background payloads, native Kitty/iTerm image transport/fold cleanup, offscreen-prefix protection, visible-tail updates and manual snapshot refresh. Captured-terminal automation does not replace human visual acceptance in the user's terminal.
