# Local Ask patch

Base: `@juicesharp/rpiv-ask-user-question` 2.15.0
Maintained package: `@bestdonger/pi-ask-user-question` **0.1.0**
Historical pre-repository version: `2.15.0-local.rex.2` (superseded; retained for provenance only)
Implemented: 2026-11-05

## Loading and updates

Maintenance home: `https://github.com/bestdonger/pi-extensions`, under
`packages/ask-user-question`. Local working copy:
`~/Projects/pi-extensions/packages/ask-user-question`.
The old `~/.pi/agent/local-packages/rpiv-ask-user-question` directory is retained
only as a migration backup; make future changes in this repository.

Normal installation uses `pi install git:github.com/bestdonger/pi-extensions`.
The root workspace manifest declares all three extension entries and installs
`@juicesharp/rpiv-config` pinned to 2.15.0 using the committed lockfile. Host modules
remain peers. Remove old local package declarations before switching sources.
Use `pi update git:github.com/bestdonger/pi-extensions` to update the managed copy;
keep development in this repository, not in Pi's managed git checkout.

Do not casually run npm install/update here: dependency changes and upstream
upgrades must be reviewed manually. Pi/TypeBox APIs still come from the host, so
a future Pi upgrade can require a compatibility adjustment. No Pi or Rex installed
program files, notification preferences, or permissions were changed.

## 1. Rex native notifications and one authoritative waiting state

- Visible questionnaires always use inline `ctx.ui.custom()` with
  `blocked: { kind: "question", message: "Pi 正在等待你回答" }`.
- Pi owns the main OSC 7501 state and its restoration. The plugin does not write
  root/child status sequences, send desktop notifications, or ring a bell in Rex.
- The previous `rex-attention.ts` / test were removed. No osascript, foreground
  process query, per-question child record, notification polling or retry remains.
- Rex owns notification appearance, eligibility, sound, muting, deduplication,
  click-to-tab behavior and read/seen appearance. This intentionally replaces the
  v1 plugin-managed "silent, background-only, once" policy.
- Rex settings: Notifications → Program Activity → Show activity in tabs /
  Show system notifications / Blocked. Settings are not changed automatically.
  Native macOS notifications still depend on Rex/macOS settings and Focus.
- Terminal bell behavior outside Rex is preserved. RPC hosts use their own dialogs.

Reference: https://www.superlogical.com/rex/docs/reference/mac-settings#program-activity

## 2. Serial inline lifecycle

`questionnaire-lifecycle.ts` implements a per-registration FIFO queue. One visible
Ask dialog at a time; a cancelled queued request is removed without flashing UI.

When an existing capturing overlay owns focus, the asynchronous component factory
waits before returning a component to Pi. No hidden inline dialog or Ask overlay
is mounted. It checks every 50 ms only while blocked by that overlay, and removes
the timer on cancellation. The upstream feature-detected topmost capturing-overlay
query excludes nonCapturing HUDs; older hosts fall back conservatively to hasOverlay.
This is UI-availability checking, not status or notification polling.

Tool cancellation and session shutdown settle active/queued questionnaires. Loading
can be cancelled without waiting for a late import. Answers received externally
still win through the shared first-answer-wins gate. All paths release the queue
and remove signal listeners in finally. RPC select/input calls receive cancellation
signals and do not continue to later questions after abort.

The existing rpiv prompt/blocked events remain for external mirrors. They cover
outstanding calls, including queue/load time; they are not Rex status signals.
The visible dialog alone controls Pi's root blocked state.

## 3. Question limit

- Up to **10 questions** per call; option count stays **2–4 per question**.
- `MAX_QUESTIONS`, parameter schema, runtime error text, generated model guidance,
  README and schema documentation agree.
- The tab bar keeps the active tab and Submit visible in narrow terminals with
  horizontal windowing, preserving the existing two-row layout contract.

## 4. Review fixes: width, collapsed input, and cursor scrolling

- Error receipts wrap at render time; collapsed and preview hints clip to their
  available columns. The hidden-line count fits inside the preview's bottom border.
- Collapsed questionnaires ignore text, paste, editing and confirmation instead of
  forwarding ignored keys into the hidden custom-answer editor. Expand and cancel
  still work.
- Overflowing custom answers follow the cursor, including single-select, multi-select
  and preview questions. Short editor blocks still stay visible as a whole; notes
  keep priority while their editor is open.

## Validation

`npm test` runs 32 passing tests as of this patch:
- FIFO/concurrency, queued/active/pre-load cancellation, shutdown and failure cleanup;
- capturing-overlay wait/dismiss/cancel and noncapturing HUD compatibility;
- installed Pi loader, real QuestionnaireSession rendering/keyboard input,
  ProgramStatusReporter transitions and external answers;
- schema/runtime boundaries 0, 1, 4, 5, 10, 11; option bounds unchanged;
- all ten questions and Submit at widths 20/40/80/160; ten RPC answers;
- long Unicode error receipts in the native tool shell, preview hints/borders and
  collapsed hints after resize; collapsed input immutability and cancellation;
- long Unicode custom answers with visible cursor, start/end movement and resize in
  single-select, multi-select and preview layouts; submitted text remains intact.

The integration tests intentionally use the installed Pi package (default
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`, override with
`PI_PACKAGE_ROOT`). No tests make model API requests.

Actual Rex/Pi checks used dedicated background test tabs and the real Ask tool/UI,
not a standalone status writer. Both the 1-question and 10-question dialogs exposed
one root blocked/question record, no ask-* children. In the 10-question run it stayed
blocked through Q10 and Submit, then returned idle with all ten answers after submit.
Test tabs were closed. Those command-triggered checks have no model turn; automated
reporter tests separately cover returning to working during an active run.
Native notification banner appearance was not visually verified; user acceptance
still needs to check Rex's native display on their own desktop.

## Activation

Run `/reload` in each existing Pi session or start a new one. The current session's
already-declared tool schema can remain at 4 until reload; the new loader declares 10.

## Rollback

The previous complete local plugin (script notifications, max 4) is backed up at:
`~/.pi/agent/backups/ask-native-20261105/rpiv-ask-user-question/`
Restore that directory into the local-package path and reload to revert this patch.
The adjacent `native-probe.ts` is a test-only extension, not loaded by normal Pi.

To return to upstream instead, replace the local path in settings.json with
`npm:@juicesharp/rpiv-ask-user-question` and reload. This re-enables upstream updates.
Original pre-local settings: `~/.pi/agent/backups/ask-rex-20261105/settings.json`.
Prefer changing just the package entry instead of restoring a stale entire settings file.
