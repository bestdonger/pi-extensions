import { test } from "node:test";
import assert from "node:assert/strict";
import { abortable, QuestionnaireQueue, waitForRetry } from "../questionnaire-lifecycle.ts";
import { waitForInlineSlot, mustYieldInlineSlot } from "../presentation.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("queue is FIFO and releasing twice does not admit overlapping requests", async () => {
	const q = new QuestionnaireQueue(), signal = new AbortController().signal;
	const first = await q.acquire(signal);
	let second = false, third = false;
	const p2 = q.acquire(signal).then(release => { second = true; return release; });
	const p3 = q.acquire(signal).then(release => { third = true; return release; });
	await tick(); assert.equal(second, false);
	first!(); first!(); const release2 = await p2;
	assert.equal(third, false); release2!(); (await p3)!(); assert.equal(third, true);
});
test("queued abort removes the waiter and leaves later requests usable", async () => {
	const q = new QuestionnaireQueue(), first = await q.acquire(new AbortController().signal);
	const c = new AbortController(), pending = q.acquire(c.signal);
	c.abort(); assert.equal(await pending, undefined);
	first!(); (await q.acquire(new AbortController().signal))!();
});
test("pre-aborted request never reserves the slot", async () => {
	const c = new AbortController(); c.abort();
	const q = new QuestionnaireQueue(); assert.equal(await q.acquire(c.signal), undefined);
	(await q.acquire(new AbortController().signal))!();
});
test("abortable load cancels promptly and absorbs a late load rejection", async () => {
	const c = new AbortController(); let reject!: (error: Error) => void;
	const pending = abortable(() => new Promise<number>((_, r) => { reject = r; }), c.signal, 0);
	c.abort(); assert.equal(await pending, 0); reject(new Error("late")); await tick();
});
test("pre-abort does not invoke action, throws propagate otherwise", async () => {
	const c = new AbortController(); c.abort();
	assert.equal(await abortable(async () => { throw Error("should not start"); }, c.signal, null), null);
	await assert.rejects(abortable(() => { throw Error("load failed"); }, new AbortController().signal, null), /load failed/);
});
test("capturing overlay blocks; dismissal permits an inline question", async () => {
	let overlay = true, ready = false;
	const tui = { terminal: {}, getTopmostVisibleOverlay: () => overlay ? {} : undefined };
	const pending = waitForInlineSlot(tui, new AbortController().signal).then(value => { ready = value; });
	await tick(); assert.equal(ready, false); overlay = false;
	await pending; assert.equal(ready, true);
});
test("overlay wait cancels without waiting for overlay dismissal", async () => {
	const c = new AbortController();
	const pending = waitForInlineSlot({ terminal: {}, hasOverlay: () => true }, c.signal);
	c.abort(); assert.equal(await pending, false);
});
test("noncapturing HUD does not block; old host fallback is conservative", () => {
	assert.equal(mustYieldInlineSlot({ terminal: {}, hasOverlay: () => true, getTopmostVisibleOverlay: () => undefined } as any), false);
	assert.equal(mustYieldInlineSlot({ terminal: {}, hasOverlay: () => true }), true);
});
test("cancellation removes a long overlay retry timer", async () => {
	const c = new AbortController(), wait = waitForRetry(c.signal, 60000);
	c.abort(); await wait;
});
