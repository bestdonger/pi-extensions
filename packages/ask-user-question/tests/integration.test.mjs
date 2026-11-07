import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// These tests deliberately use the locally installed Pi loader, theme and status reporter.
const host = process.env.PI_PACKAGE_ROOT ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const { loadExtensions } = await import(`${host}/dist/core/extensions/loader.js`);
const { validateToolArguments } = await import(`${host}/node_modules/@earendil-works/pi-ai/dist/utils/validation.js`);
const { visibleWidth, stripTerminalSequences, CURSOR_MARKER } = await import(`${host}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const { ToolExecutionComponent } = await import(`${host}/dist/modes/interactive/components/tool-execution.js`);
const { initTheme, getThemeByName } = await import(`${host}/dist/modes/interactive/theme/theme.js`);
const { KeybindingsManager } = await import(`${host}/dist/core/keybindings.js`);
const { ProgramStatusReporter } = await import(`${host}/dist/modes/interactive/program-status-reporter.js`);
initTheme('dark', false);
const root = fileURLToPath(new URL('../', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
	for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
	assert.fail('Timed out waiting for UI');
}
const question = (i = 1) => ({ question: `Question ${i}?`, header: `Q${i}`, options: [
	{ label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Cancel' },
] });

async function fixture({ columns = 100, rows = 40 } = {}) {
	const bus = new EventEmitter(), events = [], shown = [], states = [];
	bus.on('rpiv:ask-user:blocked', event => events.push(event));
	const loaded = await loadExtensions([`${root}index.ts`], root, bus);
	assert.deepEqual(loaded.errors, []);
	const ext = loaded.extensions[0], tool = ext.tools.get('ask_user_question').definition;
	let capturing = false, current, fail = false;
	const reporter = new ProgramStatusReporter(() => ({ setProgramStatus: s => states.push(s) }), () => 'test');
	reporter.handleEvent({ type: 'agent_start' });
	const tui = { terminal: { columns, rows }, requestRender() {},
		getTopmostVisibleOverlay: () => capturing ? {} : undefined };
	const ctx = { hasUI: true, mode: 'tui', cwd: root, isProjectTrusted: () => true,
		ui: { notify() {}, custom(factory, options) {
			assert.equal(options.overlay, false);
			assert.deepEqual(options.blocked, { kind: 'question', message: 'Pi 正在等待你回答' });
			return new Promise((resolve, reject) => {
				let closed = false, entry;
				const done = result => {
					if (closed) return; closed = true;
					if (current === entry && entry) { current = undefined; reporter.setBlocked('test-dialog', undefined); }
					resolve(result);
				};
				if (fail) { reject(new Error('factory failed')); return; }
				Promise.resolve(factory(tui, getThemeByName('dark'), KeybindingsManager.create(root), done)).then(component => {
					if (closed) return;
					assert.equal(current, undefined, 'two questionnaires mounted at once');
					entry = { component, done }; current = entry; shown.push(entry);
					reporter.setBlocked('test-dialog', options.blocked);
				}, reject);
			});
		} },
	};
	const execute = (id, signal, questions = [question()]) => tool.execute(id, { questions }, signal, () => {}, ctx);
	return { bus, events, shown, states, tool, ctx, tui, execute,
		setOverlay: value => { capturing = value; }, setFailure: value => { fail = value; },
		shutdown: async () => { for (const handler of ext.handlers.get('session_shutdown') ?? []) await handler({}, ctx); },
	};
}

test('real questionnaire renders, root remains blocked, Esc restores working', async () => {
	const f = await fixture(), result = f.execute('normal');
	await until(() => f.shown.length === 1);
	assert.match(f.shown[0].component.render(100).join('\n'), /Question 1/);
	assert.equal(f.states.at(-1).state, 'blocked'); await tick();
	assert.equal(f.states.at(-1).kind, 'question');
	f.shown[0].component.handleInput('\x1b');
	assert.equal((await result).details.cancelled, true); assert.equal(f.states.at(-1).state, 'working');
	assert.deepEqual(f.events.map(e => e.active), [true, false]);
});
test('two concurrent calls render serially; normal answer advances queue', async () => {
	const f = await fixture(), a = f.execute('a'), b = f.execute('b');
	await until(() => f.shown.length === 1); await tick(); assert.equal(f.shown.length, 1);
	f.shown[0].component.handleInput('\r'); assert.equal((await a).details.cancelled, false);
	await until(() => f.shown.length === 2); f.shown[1].component.handleInput('\x1b'); await b;
	assert.equal(f.states.at(-1).state, 'working');
});
test('abort a queued question; it never flashes and the next request runs', async () => {
	const f = await fixture(), a = f.execute('active'); await until(() => f.shown.length === 1);
	const c = new AbortController(), b = f.execute('queued', c.signal); c.abort();
	assert.equal((await b).details.cancelled, true); assert.equal(f.shown.length, 1);
	f.shown[0].component.handleInput('\x1b'); await a;
	const next = f.execute('next'); await until(() => f.shown.length === 2);
	f.shown[1].component.handleInput('\x1b'); await next;
});
test('active tool abort closes the UI and root blocked state', async () => {
	const f = await fixture(), c = new AbortController(), result = f.execute('abort', c.signal);
	await until(() => f.shown.length === 1); c.abort();
	assert.equal((await result).details.cancelled, true); assert.equal(f.states.at(-1).state, 'working');
});
test('pre-aborted tool does not load a questionnaire', async () => {
	const f = await fixture(), c = new AbortController(); c.abort();
	assert.equal((await f.execute('preabort', c.signal)).details.cancelled, true); assert.equal(f.shown.length, 0);
});
test('capturing overlay delays mounting, cancellation leaves no late question', async () => {
	const f = await fixture(); f.setOverlay(true);
	const c = new AbortController(), result = f.execute('overlay-cancel', c.signal);
	await new Promise(r => setTimeout(r, 70)); assert.equal(f.shown.length, 0);
	c.abort(); assert.equal((await result).details.cancelled, true); f.setOverlay(false);
	await new Promise(r => setTimeout(r, 70)); assert.equal(f.shown.length, 0);
});
test('closing capturing overlay shows a normal inline questionnaire', async () => {
	const f = await fixture(); f.setOverlay(true); const result = f.execute('overlay-wait');
	await new Promise(r => setTimeout(r, 70)); assert.equal(f.shown.length, 0);
	f.setOverlay(false); await until(() => f.shown.length === 1);
	f.shown[0].component.handleInput('\x1b'); await result;
});
test('UI failure releases queue and paired events', async () => {
	const f = await fixture(); f.setFailure(true);
	await assert.rejects(f.execute('failure'), /factory failed/);
	assert.deepEqual(f.events.map(e => e.active), [true, false]); f.setFailure(false);
	const result = f.execute('recovered'); await until(() => f.shown.length === 1);
	f.shown[0].component.handleInput('\x1b'); await result;
});
test('shutdown cancels active and queued questions', async () => {
	const f = await fixture(), a = f.execute('shutdown-a'), b = f.execute('shutdown-b');
	await until(() => f.shown.length === 1); await f.shutdown();
	assert.equal((await a).details.cancelled, true); assert.equal((await b).details.cancelled, true);
	assert.equal(f.shown.length, 1); assert.equal(f.states.at(-1).state, 'working');
});
test('RPC cancellation passes a signal and does not open subsequent dialogs', async () => {
	const f = await fixture(), c = new AbortController(); let calls = 0;
	f.ctx.mode = 'rpc';
	f.ctx.ui.select = (_title, _options, opts) => { calls++; assert.ok(opts.signal); return new Promise(() => {}); };
	f.ctx.ui.input = async () => undefined;
	const result = f.execute('rpc', c.signal, [question(1), question(2)]);
	await until(() => calls === 1); c.abort();
	assert.equal((await result).details.cancelled, true); assert.equal(calls, 1);
});

test('schema and model guidance advertise 1–10 questions, options still 2–4', async () => {
	const f = await fixture(), schema = f.tool.parameters.properties.questions;
	assert.equal(schema.minItems, 1); assert.equal(schema.maxItems, 10);
	assert.match(schema.description, /1-10/); assert.match(f.tool.promptSnippet, /up to 10/);
	assert.ok(f.tool.promptGuidelines.some(text => text.includes('up to 10')));
	assert.equal(schema.items.properties.options.minItems, 2);
	assert.equal(schema.items.properties.options.maxItems, 4);
	for (const count of [1, 4, 5, 10]) {
		const arguments_ = { questions: Array.from({ length: count }, (_, i) => question(i + 1)) };
		assert.equal(validateToolArguments(f.tool, { id: 'schema', name: f.tool.name, arguments: arguments_ }).questions.length, count);
	}
	for (const count of [0, 11]) {
		assert.throws(() => validateToolArguments(f.tool, { id: 'invalid', name: f.tool.name,
			arguments: { questions: Array.from({ length: count }, (_, i) => question(i + 1)) } }), /Validation failed/);
	}
});
test('runtime rejects zero or eleven questions before opening UI', async () => {
	const f = await fixture();
	assert.equal((await f.execute('zero', undefined, [])).details.error, 'no_questions');
	const result = await f.execute('eleven', undefined, Array.from({ length: 11 }, (_, i) => question(i + 1)));
	assert.equal(result.details.error, 'too_many_questions');
	assert.match(result.content[0].text, /10/); assert.equal(f.shown.length, 0);
});
test('all ten real UI tabs and Submit remain visible and answerable in narrow terminals', async () => {
	const f = await fixture(), questions = Array.from({ length: 10 }, (_, i) => question(i + 1));
	const result = f.execute('ten', undefined, questions); await until(() => f.shown.length === 1);
	const component = f.shown[0].component;
	for (let i = 0; i < 10; i++) {
		for (const width of [20, 40, 80, 160]) {
			const lines = component.render(width);
			assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow: question ${i + 1} width ${width}`);
			assert.match(lines[1], new RegExp(`Q${i + 1}\\b`), `active tab ${i + 1} hidden at width ${width}`);
		}
		component.handleInput('\r');
	}
	assert.match(component.render(40)[1], /Submit/);
	component.handleInput('\r');
	const response = await result;
	assert.equal(response.details.cancelled, false); assert.equal(response.details.answers.length, 10);
	assert.deepEqual(response.details.answers.map(a => a.questionIndex), Array.from({ length: 10 }, (_, i) => i));
});
test('external answer to queued question skips its UI without starving the next call', async () => {
	const f = await fixture(), active = f.execute('active-external'); await until(() => f.shown.length === 1);
	const queued = f.execute('external');
	f.bus.emit('rpiv:ask-user:answer', { toolCallId: 'external', answers: [{ questionIndex: 0, optionIndexes: [0] }] });
	assert.equal((await queued).details.cancelled, false); assert.equal(f.shown.length, 1);
	f.shown[0].component.handleInput('\x1b'); await active;
	const next = f.execute('next-external'); await until(() => f.shown.length === 2);
	f.shown[1].component.handleInput('\x1b'); await next;
});
test('ten questions also work with RPC dialog primitives', async () => {
	const f = await fixture(); f.ctx.mode = 'rpc'; let count = 0;
	f.ctx.ui.select = async (_title, options) => { count++; return options[0]; };
	f.ctx.ui.input = async () => undefined;
	const result = await f.execute('rpc-ten', undefined, Array.from({ length: 10 }, (_, i) => question(i + 1)));
	assert.equal(count, 10); assert.equal(result.details.answers.length, 10);
});

function assertFits(component, width) {
	const lines = component.render(width);
	assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at width ${width}`);
	return lines;
}

test('long error receipts wrap inside the native tool shell after resize', async () => {
	const f = await fixture(), args = { questions: [question()] };
	for (const isError of [true, false]) {
		const text = `Error: ${'加载失败🙂'.repeat(40)}`;
		const result = { content: [{ type: 'text', text: `${text}\nPRIVATE_STACK` }],
			details: { answers: [], cancelled: true, error: 'session_load_failed' }, isError };
		const component = new ToolExecutionComponent('ask_user_question', 'error', args, {}, f.tool, f.tui, root);
		component.updateResult(result);
		for (const width of [80, 20, 40, 160]) {
			const lines = assertFits(component, width).map(stripTerminalSequences);
			assert.ok(lines.join('').replace(/\s/g, '').includes(text.replace(/\s/g, '')), 'error text lost');
			assert.ok(!lines.join('').includes('PRIVATE_STACK'));
		}
	}
});

test('collapsed custom input ignores text, paste, editing and confirmation; expand and cancel still work', async t => {
	const f = await fixture(); t.after(() => f.shutdown());
	const result = f.execute('collapsed-input'); await until(() => f.shown.length === 1);
	const component = f.shown[0].component;
	component.handleInput('3'); component.handleInput('safe'); component.handleInput('\x1d');
	for (const key of ['XYZ', '\x7f', '\x1b[D', '\x1b[200~PASTE\x1b[201~', '\r', '\x15']) component.handleInput(key);
	component.handleInput('\x1d'); component.handleInput('!'); component.handleInput('\r');
	assert.equal((await result).details.answers[0].answer, 'safe!');
	const cancelled = f.execute('collapsed-cancel'); await until(() => f.shown.length === 2);
	f.shown[1].component.handleInput('\x1d'); f.shown[1].component.handleInput('\x1b');
	assert.equal((await cancelled).details.cancelled, true);
});

test('collapsed hint stays one row within the terminal width after resize', async t => {
	const f = await fixture(); t.after(() => f.shutdown());
	const result = f.execute('collapsed-width'); await until(() => f.shown.length === 1);
	const component = f.shown[0].component; component.handleInput('\x1d');
	for (const width of [80, 20, 1, 40, 80]) assert.equal(assertFits(component, width).length, 1);
	assert.match(stripTerminalSequences(component.render(80)[0]), /Ctrl\+\] to expand/);
	component.handleInput('\x1b'); await result;
});

for (const preview of ['中文预览🙂', Array.from({ length: 30 }, (_, i) => `line ${i} 中文🙂`).join('\n')]) {
	test(`preview hints and hidden-line border fit narrow terminals (${preview.includes('\n') ? 'long' : 'short'})`, async t => {
		const f = await fixture({ columns: 20, rows: 80 }); t.after(() => f.shutdown());
		const q = question(); q.options = q.options.map(option => ({ ...option, preview }));
		const result = f.execute('preview-width', undefined, [q]); await until(() => f.shown.length === 1);
		const component = f.shown[0].component;
		for (const width of [20, 40, 80, 160, 20]) {
			f.tui.terminal.columns = width;
			const lines = assertFits(component, width).map(stripTerminalSequences);
			assert.ok(lines.some(line => /└.*┘/.test(line)), 'preview bottom border lost');
			if (width === 80 && preview.includes('\n')) assert.match(lines.join('\n'), /\d+ lines hidden/);
		}
		component.handleInput('n'); component.handleInput('备注'); component.handleInput('\r');
		assertFits(component, 20); // The saved-note hint is longer than the add-note hint.
		component.handleInput('\x1b'); await result;
	});
}

for (const variant of ['single', 'preview', 'multi']) {
	test(`long ${variant} custom answer follows its cursor through editing and resize`, async t => {
		const f = await fixture({ columns: 40, rows: 24 }); t.after(() => f.shutdown());
		const q = question();
		if (variant === 'preview') q.options = q.options.map(option => ({ ...option, preview: 'Preview' }));
		if (variant === 'multi') q.multiSelect = true;
		const result = f.execute('cursor', undefined, [q]); await until(() => f.shown.length === 1);
		const component = f.shown[0].component, answer = `HEAD${'中文🙂abc'.repeat(100)}TAIL`;
		component.handleInput('3');
		for (const char of answer) component.handleInput(char);
		const checkCursor = (width, text) => {
			f.tui.terminal.columns = width;
			const lines = assertFits(component, width);
			assert.ok(lines.length <= 16, 'inline row budget exceeded');
			assert.ok(lines.some(line => line.includes(CURSOR_MARKER)), 'cursor scrolled out of view');
			assert.ok(lines.map(stripTerminalSequences).join('').replace(/\s/g, '').includes(text));
		};
		for (const width of [40, 20, 80, 40]) checkCursor(width, 'TAIL');
		component.handleInput('\x01'); checkCursor(40, 'HEAD'); // Ctrl+A: beginning of logical line.
		component.handleInput('\x05'); checkCursor(40, 'TAIL'); // Ctrl+E: end of logical line.
		component.handleInput('\r');
		assert.equal((await result).details.answers[0].answer, answer);
	});
}
