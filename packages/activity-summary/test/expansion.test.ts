import { test, expect } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { AssistantMessageComponent, ToolExecutionComponent, getPackageDir, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, TuiMainScreen, visibleWidth, Text, getCapabilities, setCapabilities, getCellDimensions, setCellDimensions } from '@earendil-works/pi-tui';
import { ActivityState } from '../src/state.ts';
import { mount } from '../src/bridge.ts';
import { paintActivityLines } from '../src/surface.ts';

initTheme('dark', false);
const { getThemeByName } = await import(`${getPackageDir()}/dist/modes/interactive/theme/theme.js`);
const thought = (name = 'Inspect', body = 'THOUGHT_BODY') => ({ type: 'thinking', thinking: `**${name}**\n\n${body}` });
const prose = (text: string) => ({ type: 'text', text });
const call = (id = 't') => ({ type: 'toolCall', id, name: 'probe', arguments: { path: 'file.ts' } });
const message = (content: any[], stopReason = 'stop'): any => ({ role: 'assistant', content, stopReason, timestamp: 1000 });
class Terminal {
  columns = 90; rows = 14; output = '';
  start() {} stop() {} write(s: string) { this.output += s; }
  hideCursor() {} showCursor() {} moveBy() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {}
}
class QuietTui extends TuiMainScreen { requestRender() {} }
function fixture() {
  const terminal = new Terminal(), tui = new QuietTui(terminal as any), state = new ActivityState();
  const document = new Container(), source = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(source); tui.addChild(document);
  let expanded = false, theme = getThemeByName('dark')!;
  const release = mount(tui, () => state, text => theme.fg('dim', text), () => { throw new Error('unexpected fail-open'); }, () => theme, () => expanded)!;
  const render = (width = 90) => document.render(width);
  return { state, terminal, tui, document, source, release, render,
    plain: () => Bun.stripANSI(render().join('\n')),
    setExpanded(value: boolean) {
      expanded = value;
      // Mirrors the native host action; the projection itself must not call setters.
      for (const child of source.children) if (child instanceof ToolExecutionComponent) child.setExpanded(value);
    },
    setTheme(name: string) { theme = getThemeByName(name)!; document.invalidate(); },
    assistant(m: any, id = 'a', transformers: any[] = []) {
      state.start(m); state.bind(id);
      const node = new AssistantMessageComponent(m, true, undefined, '', 2, transformers, id, '2026-01-01T00:00:00.000Z');
      source.addChild(node); return node;
    },
    tool(id = 't', text = 'TOOL_BODY', error = false, definition?: any) {
      const node = new ToolExecutionComponent('probe', id, { path: 'file.ts' }, { outputPad: 2, showImages: true }, definition, tui, '/tmp');
      node.setExpanded(expanded); node.updateResult({ content: [prose(text)], isError: error });
      state.tool(id, 'probe', undefined, error ? 'err' : 'ok'); source.addChild(node); return node;
    },
  };
}

// Validate the actual background of every visible cell, not just a leading ANSI code.
function expectPainted(line: string, theme: any, bgName: string, width: number) {
  const expected = theme.getBgAnsi(bgName).slice(2, -1);
  let background: string | undefined;
  for (const token of line.match(/\x1b\[[0-9;:]*m|[^\x1b]+/g) ?? []) {
    if (!token.startsWith('\x1b')) { if (visibleWidth(token)) expect(background).toBe(expected); continue; }
    const codes = token.slice(2, -1).split(';');
    for (let i = 0; i < codes.length; i++) {
      const code = Number(codes[i]!.split(':')[0] || 0);
      if (code === 0 || code === 49) background = undefined;
      else if (code === 38 || code === 48 || code === 58) {
        const skip = codes[i]!.includes(':') ? 0 : codes[i + 1] === '2' ? 4 : 2;
        if (code === 48) background = codes.slice(i, i + skip + 1).join(';');
        i += skip;
      } else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) background = codes[i];
    }
  }
  expect(background).toBeUndefined(); expect(visibleWidth(line)).toBe(width);
}

test('collapsed renders no payload; expanded restores native thinking/tool content once in one surface', () => {
  const f = fixture();
  try {
    const m = message([thought(), call()]); const before = JSON.stringify(m);
    const assistant = f.assistant(m), tool = f.tool(); f.state.settle(false);
    let calls = 0; const nativeRender = tool.render.bind(tool); tool.render = width => { calls++; return nativeRender(width); };
    expect(f.plain()).not.toContain('THOUGHT_BODY'); expect(f.plain()).not.toContain('TOOL_BODY'); expect(calls).toBe(0);
    expect(f.plain()).toContain('›');
    f.setExpanded(true);
    const open = f.plain(); expect(open).toContain('⌄'); expect(open).toContain('THOUGHT_BODY'); expect(open).toContain('file.ts');
    expect(open.match(/TOOL_BODY/g)).toHaveLength(1); expect(open.match(/\bstep(?:s)?\b/g)).toHaveLength(1);
    expect(f.render()[0]).toBe('');
    for (const line of f.render().slice(1)) expectPainted(line, getThemeByName('dark'), 'toolSuccessBg', 90);
    expect(f.render().join('')).not.toContain('\x1b]133;');
    expect(JSON.stringify(m)).toBe(before); expect((assistant as any).hideThinkingBlock).toBe(true);
    const renderedCalls = calls; f.setExpanded(false);
    expect(f.plain()).not.toContain('THOUGHT_BODY'); expect(f.plain()).not.toContain('TOOL_BODY'); expect(calls).toBe(renderedCalls);
  } finally { f.release(); }
});

test('prose stays outside grouped backgrounds and tools/thinking retain their order', () => {
  const f = fixture();
  try {
    f.assistant(message([thought('One', 'FIRST_THOUGHT'), prose('MIDDLE_PROSE'), call()]));
    f.tool('t', 'FAILED_TOOL_BODY', true);
    f.assistant(message([thought('Two', 'SECOND_THOUGHT'), prose('FINAL_PROSE')]), 'b'); f.state.settle(false);
    f.setExpanded(true);
    const plain = f.plain();
    const positions = ['FIRST_THOUGHT', 'MIDDLE_PROSE', 'FAILED_TOOL_BODY', 'SECOND_THOUGHT', 'FINAL_PROSE'].map(s => plain.indexOf(s));
    expect(positions.every(n => n >= 0)).toBe(true); expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(plain.match(/\bstep(?:s)?\b/g)).toHaveLength(2);
    const rows = f.render();
    for (const marker of ['MIDDLE_PROSE', 'FINAL_PROSE']) expect(rows.find(row => row.includes(marker))).not.toMatch(/\x1b\[48[;:]/);
    expectPainted(rows.find(row => row.includes('FIRST_THOUGHT'))!, getThemeByName('dark'), 'toolSuccessBg', 90);
    expectPainted(rows.find(row => row.includes('FAILED_TOOL_BODY'))!, getThemeByName('dark'), 'toolErrorBg', 90);
    expectPainted(rows.find(row => row.includes('SECOND_THOUGHT'))!, getThemeByName('dark'), 'toolErrorBg', 90);
  } finally { f.release(); }
});

test('same-message tool/thinking/tool payloads follow their original block order exactly once', () => {
  const f = fixture();
  try {
    f.assistant(message([call('a'), thought('Between', 'BETWEEN_THOUGHT'), call('b')]));
    f.tool('a', 'RESULT_A'); f.tool('b', 'RESULT_B'); f.state.settle(false); f.setExpanded(true);
    const text = f.plain();
    expect(text.indexOf('RESULT_A')).toBeLessThan(text.indexOf('BETWEEN_THOUGHT'));
    expect(text.indexOf('BETWEEN_THOUGHT')).toBeLessThan(text.indexOf('RESULT_B'));
    expect(text.match(/RESULT_A/g)).toHaveLength(1); expect(text.match(/RESULT_B/g)).toHaveLength(1);
    expect(text).toContain('3 steps');
  } finally { f.release(); }
});

test('same-message tool/prose/tool streaming separates surfaces without moving prose into a block', () => {
  const f = fixture();
  try {
    const m = message([call('a')]); const native = f.assistant(m); f.tool('a', 'RESULT_A');
    f.setExpanded(true); expect(f.plain()).toContain('RESULT_A');
    m.content.push(prose('LIVE_MIDDLE')); f.state.observe(m); native.updateContent(m, true);
    const middle = f.plain(); expect(middle).toContain('LIVE_MIDDLE'); expect(middle).not.toContain('RESULT_B');
    m.content.push(call('b')); f.state.observe(m); native.updateContent(m, true); f.tool('b', 'RESULT_B'); f.state.settle(false);
    const text = f.plain();
    expect(text.match(/\bstep(?:s)?\b/g)).toHaveLength(2);
    expect(text.indexOf('RESULT_A')).toBeLessThan(text.indexOf('LIVE_MIDDLE'));
    expect(text.indexOf('LIVE_MIDDLE')).toBeLessThan(text.indexOf('RESULT_B'));
    expect(f.render().find(row => row.includes('LIVE_MIDDLE'))).not.toMatch(/\x1b\[48[;:]/);
    f.setExpanded(false); expect(f.plain()).toContain('LIVE_MIDDLE'); expect(f.plain()).not.toContain('RESULT_A');
    f.setExpanded(true); expect(f.plain()).toContain('RESULT_B');
  } finally { f.release(); }
});

test('reused call IDs in later messages never steal a prior message’s native tool payload', () => {
  const f = fixture();
  try {
    f.assistant(message([call('same')])); f.tool('same', 'EARLY_RESULT');
    f.assistant(message([prose('BETWEEN_MESSAGES')]), 'b');
    f.assistant(message([call('same')]), 'c'); f.tool('same', 'LATE_RESULT'); f.state.settle(false);
    f.setExpanded(true); const text = f.plain();
    expect(text.match(/EARLY_RESULT/g)).toHaveLength(1); expect(text.match(/LATE_RESULT/g)).toHaveLength(1);
    expect(text.indexOf('EARLY_RESULT')).toBeLessThan(text.indexOf('BETWEEN_MESSAGES'));
    expect(text.indexOf('BETWEEN_MESSAGES')).toBeLessThan(text.indexOf('LATE_RESULT'));
  } finally { f.release(); }
});

test('a native tool without an assistant declaration still expands exactly once', () => {
  const f = fixture();
  try {
    const native = new ToolExecutionComponent('orphan', 'orphan-id', {}, {}, undefined, f.tui, '/tmp');
    native.updateResult({ content: [prose('ORPHAN_PAYLOAD')], isError: false }); f.source.addChild(native);
    f.setExpanded(true); const text = f.plain();
    expect(text).toContain('1 step'); expect(text.match(/ORPHAN_PAYLOAD/g)).toHaveLength(1);
    f.setExpanded(false); expect(f.plain()).not.toContain('ORPHAN_PAYLOAD');
  } finally { f.release(); }
});

test('custom native renderers receive expanded=true and are not replaced with plain JSON', () => {
  const f = fixture(); const seen: boolean[] = [];
  try {
    f.assistant(message([call()]));
    f.tool('t', 'ignored by custom renderer', false, {
      renderCall(_args: any, theme: any) { return new Text(theme.fg('accent', 'CUSTOM_CALL'), 0, 0); },
      renderResult(_result: any, options: any) { seen.push(options.expanded); return new Text(options.expanded ? 'FULL_CUSTOM_RESULT' : 'PREVIEW_CUSTOM_RESULT', 0, 0); },
    });
    f.state.settle(false); f.setExpanded(true);
    expect(f.plain()).toContain('CUSTOM_CALL'); expect(f.plain()).toContain('FULL_CUSTOM_RESULT'); expect(seen.at(-1)).toBe(true);
    expect(f.plain()).not.toContain('ignored by custom renderer');
  } finally { f.release(); }
});

test('latest tool uses a sanitized semantic renderer label, with safe argument fallback', () => {
  const f = fixture(); let throws = false;
  try {
    f.assistant(message([thought('older thinking'), call()]));
    f.tool('t', 'ignored', false, {
      renderResult() {
        const result = new Container();
        result.addChild(Object.assign(new Text('PRIVATE_RESULT_BODY', 0, 0), {
          getActivityLabel() { if (throws) throw new Error('unsupported label'); return '\x1b]52;c;SECRET\x07\x1b[32m✓ semantic command\x1b[0m'; },
        }));
        return result;
      },
    });
    f.state.settle(false);
    expect(f.plain()).toContain('• semantic command · 2 steps ›');
    expect(f.plain()).not.toContain('SECRET'); expect(f.plain()).not.toContain('PRIVATE_RESULT_BODY');
    throws = true; f.setExpanded(true); f.plain(); f.setExpanded(false);
    expect(f.plain()).toContain('probe: file.ts · 2 steps ›');
  } finally { f.release(); }
});

test('expanded fallback tools show long results past the native collapsed preview', () => {
  const f = fixture();
  try {
    f.assistant(message([call()])); f.tool('t', Array.from({ length: 35 }, (_, i) => `ROW_${i}`).join('\n'));
    f.setExpanded(true); expect(f.plain()).toContain('ROW_34'); expect(f.plain()).not.toContain('more lines,');
  } finally { f.release(); }
});

test('thinking Markdown transformers keep metadata and do not rerun for unrelated frames', () => {
  const f = fixture(); const seen: any[] = [];
  try {
    f.assistant(message([thought()]), 'metadata-id', [(text: string, context: any) => { seen.push(context); return text + '\n\nTRANSFORMED'; }]);
    f.setExpanded(true); expect(f.plain()).toContain('TRANSFORMED');
    expect(seen.at(-1)).toMatchObject({ messageType: 'assistant-thinking', messageId: 'metadata-id', timestamp: '2026-01-01T00:00:00.000Z' });
    const count = seen.length; for (let i = 0; i < 10; i++) f.render(); expect(seen).toHaveLength(count);
  } finally { f.release(); }
});

test('history without plugin metadata expands original content with rebuilt counts', () => {
  const f = fixture();
  try {
    const m = message([thought(), call()]);
    f.state.restore([{ type: 'message', id: 'old', message: m }]);
    f.source.addChild(new AssistantMessageComponent(m, true, undefined, '', 1, [], 'old'));
    const native = new ToolExecutionComponent('probe', 't', {}, {}, undefined, f.tui, '/tmp');
    native.updateResult({ content: [prose('OLD_TOOL_BODY')], isError: false }); f.source.addChild(native);
    f.setExpanded(true); expect(f.plain()).toContain('2 steps'); expect(f.plain()).toContain('THOUGHT_BODY'); expect(f.plain()).toContain('OLD_TOOL_BODY');
  } finally { f.release(); }
});

test('all themes and narrow widths keep expanded text in one background, including native nested backgrounds', () => {
  const colored = '\x1b[31mred\x1b[0m normal \x1b[48;2;1;2;3mforeign\x1b[49m \x1b[44mblue\x1b[0m 中文👨‍👩‍👧‍👦';
  for (const name of ['dark', 'light']) for (const background of ['toolPendingBg', 'toolSuccessBg', 'toolErrorBg'] as const) {
    const theme = getThemeByName(name)!;
    for (const width of [1, 2, 8, 40, 90]) for (const row of paintActivityLines([colored, '', '\x1b[38;2;0;255;0;48;5;22mextended\x1b[0m', '\x1b[48:2::0:0:255mcolon\x1b[39m'], width, background, theme)) {
      expectPainted(row, theme, background, width); expect(row).not.toMatch(/[\r\n]/);
      expect(row).not.toContain('\x1b[48;2;1;2;3m'); expect(row).not.toContain('\x1b[44m');
    }
    const [row] = paintActivityLines(['\x1b[31mred\x1b[0m'], 20, background, theme);
    expect(row).toContain('\x1b[31m'); // Semantic foreground/syntax highlighting survives.
  }
});

test('paint preserves OSC8 links while removing nested shell-prompt markers', () => {
  const theme = getThemeByName('dark')!;
  const [row] = paintActivityLines(['\x1b]133;A\x07\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\\x1b]133;B\x07'], 20, 'toolPendingBg', theme);
  expect(row).toContain('\x1b]8;;https://example.invalid'); expect(row).not.toContain('\x1b]133;'); expect(visibleWidth(row)).toBe(20);
});

// Valid deterministic PNG large enough to exercise multi-chunk Kitty transport.
function pngFixture(): string {
  const width = 32, height = 128, pixels = Buffer.alloc((width * 3 + 1) * height);
  let random = 123456789;
  for (let row = 0; row < height; row++) for (let col = 1; col <= width * 3; col++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    pixels[row * (width * 3 + 1) + col] = random & 255;
  }
  const chunk = (type: string, bytes: Buffer) => {
    const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(type, 4); bytes.copy(result, 8);
    let crc = -1;
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ -1) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

for (const protocol of ['kitty', 'iterm2'] as const) test(`native ${protocol} Image → ToolExecution → projection → regular terminal preserves graphics and folds safely`, () => {
  const capabilities = getCapabilities(), cells = getCellDimensions(), f = fixture();
  try {
    setCapabilities({ images: protocol, trueColor: true, hyperlinks: true }); setCellDimensions({ widthPx: 8, heightPx: 16 });
    f.assistant(message([call()])); const native = f.tool();
    native.updateResult({ content: [{ type: 'image', data: pngFixture(), mimeType: 'image/png' }], isError: false });
    f.state.settle(false); f.setExpanded(true);
    const prefix = protocol === 'kitty' ? '\x1b_G' : '\x1b]1337;File=';
    const nativeRows = native.render(90), nativeImage = nativeRows.find(row => row.includes(prefix))!;
    expect(nativeImage).toBeDefined(); expect(f.render().find(row => row.includes(prefix))).toBe(nativeImage);
    expect(nativeRows.filter(row => row === '').length).toBeGreaterThan(1);
    if (protocol === 'kitty') expect(nativeImage.match(/\x1b_G/g)!.length).toBeGreaterThan(1);
    (f.tui as any).doRender(); expect(f.terminal.output).toContain(prefix);
    expect((f.tui as any).previousViewportTop).toBeGreaterThan(0);
    f.terminal.output = ''; f.setExpanded(false); (f.tui as any).doRender();
    expect(f.render().some(row => row.includes(prefix))).toBe(false);
    if (protocol === 'kitty') expect(f.terminal.output).toContain('a=d,d=I,i=');
    f.setExpanded(true); (f.tui as any).doRender(); expect(f.render().some(row => row.includes(prefix))).toBe(true);
  } finally { f.release(); setCapabilities(capabilities); setCellDimensions(cells); }
});

test('Kitty/iTerm image protocol lines and reserved empty rows are preserved byte-for-byte', () => {
  const kitty = '\x1b_Ga=T,f=100,r=3,i=1;AA==\x1b\\';
  const iterm = '\x1b[2A\x1b]1337;File=inline=1:AA==\x07';
  const input = [kitty, '', '', 'between', '', '', iterm];
  const painted = paintActivityLines(input, 20, 'toolPendingBg', getThemeByName('dark')!);
  for (const i of [0, 1, 2, 4, 5, 6]) expect(painted[i]).toBe(input[i]);
  expectPainted(painted[3]!, getThemeByName('dark'), 'toolPendingBg', 20);
});

test('manual toggle refreshes frozen counters and payload; later automatic updates cannot rewrite offscreen text', () => {
  const f = fixture();
  try {
    f.assistant(message([call()])); const native = f.tool('t', 'OLD_RESULT');
    f.setExpanded(true); const old = f.render(); (f.tui as any).previousViewportTop = old.length;
    native.updateResult({ content: [prose('NEW_FAILURE')], isError: true }); f.state.tool('t', 'probe', undefined, 'err');
    expect(f.render()).toEqual(old);
    f.setExpanded(false); expect(f.plain()).toContain('1 failed');
    f.setExpanded(true); expect(f.plain()).toContain('NEW_FAILURE'); expect(f.plain()).not.toContain('OLD_RESULT');
  } finally { f.release(); }
});

test('a tall live block may append visible tail content without changing its offscreen prefix', () => {
  const f = fixture();
  try {
    const m = message([thought('Live', Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n\n'))]);
    const native = f.assistant(m); f.setExpanded(true); const old = f.render();
    (f.tui as any).previousViewportTop = 10;
    m.content[0].thinking += '\n\nVISIBLE_TAIL'; f.state.observe(m); native.updateContent(m, true);
    const updated = f.render(); expect(updated.slice(0, 10)).toEqual(old.slice(0, 10)); expect(Bun.stripANSI(updated.join('\n'))).toContain('VISIBLE_TAIL');
  } finally { f.release(); }
});

test('background-only terminal changes do not recolor offscreen expanded payloads', () => {
  const f = fixture();
  try {
    f.assistant(message([thought()])); f.setExpanded(true); const old = f.render();
    (f.tui as any).previousViewportTop = old.length; f.state.boundary();
    expect(f.render()).toEqual(old);
    f.setExpanded(false); f.render(); f.setExpanded(true);
    expect(f.render()[0]).toBe('');
    for (const row of f.render().slice(1)) expectPainted(row, getThemeByName('dark'), 'toolSuccessBg', 90);
  } finally { f.release(); }
});

test('theme invalidation repaints frozen expanded surfaces using the current palette', () => {
  const f = fixture();
  try {
    f.assistant(message([thought(), call()])); f.tool(); f.state.settle(false); f.setExpanded(true);
    const dark = f.render(); f.setTheme('light'); const light = f.render();
    expect(Bun.stripANSI(light.join('\n'))).toBe(Bun.stripANSI(dark.join('\n')));
    expect(light[0]).toBe('');
    for (const row of light.slice(1)) expectPainted(row, getThemeByName('light'), 'toolSuccessBg', 90);
  } finally { f.release(); }
});

test('real regular terminal: manual global reflow is allowed; automatic offscreen changes do not clear history', () => {
  const f = fixture();
  try {
    f.assistant(message([thought(), call()])); const native = f.tool('t', 'ORIGINAL_TOOL_PAYLOAD');
    f.assistant(message([prose(Array.from({ length: 40 }, (_, i) => `answer ${i}`).join('\n\n'))]), 'b');
    const draw = () => (f.tui as any).doRender();
    draw(); expect((f.tui as any).previousViewportTop).toBeGreaterThan(0);
    f.terminal.output = ''; f.setExpanded(true); draw();
    expect(f.terminal.output).toContain('ORIGINAL_TOOL_PAYLOAD');
    expect(f.terminal.output).toContain('\x1b[3J'); // User-approved height/history change.
    const before = f.render(); f.terminal.output = '';
    native.updateResult({ content: [prose('DELAYED_FAILURE')], isError: true }); f.state.tool('t', 'probe', undefined, 'err');
    draw(); expect(f.render()).toEqual(before); expect(f.terminal.output).not.toContain('\x1b[3J');
    expect(f.terminal.output).not.toContain('DELAYED_FAILURE');
    f.setExpanded(false); draw(); f.setExpanded(true); draw();
    expect(f.plain()).toContain('DELAYED_FAILURE'); expect(f.plain()).toContain('1 failed');
  } finally { f.release(); }
});

test('offscreen native tool rendering is cached until an explicit toggle', () => {
  const f = fixture();
  try {
    f.assistant(message([call()])); const native = f.tool();
    let calls = 0; const render = native.render.bind(native); native.render = width => { calls++; return render(width); };
    f.setExpanded(true); const old = f.render(); const count = calls;
    (f.tui as any).previousViewportTop = old.length;
    for (let i = 0; i < 10; i++) f.render(); expect(calls).toBe(count);
    f.setExpanded(false); f.render(); f.setExpanded(true); f.render(); expect(calls).toBe(count + 1);
  } finally { f.release(); }
});

test('reverse video and unterminated native styles cannot replace/leak the activity background', () => {
  const [row] = paintActivityLines(['\x1b[7;4;31mreverse underline'], 40, 'toolSuccessBg', getThemeByName('dark')!);
  expect(row).not.toContain('\x1b[7m'); expect(row).toContain('\x1b[31m'); expect(row).toContain('\x1b[4m');
  expectPainted(row, getThemeByName('dark'), 'toolSuccessBg', 40);
});

test('final model errors remain concise while explicitly expanded tool errors are visible', () => {
  const f = fixture();
  try {
    const m = { ...message([thought()], 'error'), errorMessage: 'PRIVATE_PROVIDER_STACK' };
    f.assistant(m); f.state.settle(false); f.setExpanded(true);
    expect(f.plain()).toContain('THOUGHT_BODY'); expect(f.plain()).toContain('模型请求失败'); expect(f.plain()).not.toContain('PRIVATE_PROVIDER_STACK');
  } finally { f.release(); }
});
