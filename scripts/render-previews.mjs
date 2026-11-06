// Run with Bun. Renders real plugin components with synthetic, offline demo data.
// No model requests, user sessions, desktop capture, or Pi settings are used.
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.PI_PACKAGE_ROOT ?? join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { loadExtensions } = await import(`${host}/dist/core/extensions/loader.js`);
const { KeybindingsManager } = await import(`${host}/dist/core/keybindings.js`);
const { initTheme, getThemeByName } = await import(`${host}/dist/modes/interactive/theme/theme.js`);
const { Container, TuiMainScreen, visibleWidth, stripTerminalSequences } = await import(`${host}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const { AssistantMessageComponent, ToolExecutionComponent } = await import(`${host}/dist/index.js`);
initTheme('dark', false);
const theme = getThemeByName('dark');
const width = 100;
const output = join(root, 'docs/assets');
mkdirSync(output, { recursive: true });

// Convert the components' ANSI output to SVG without changing text or layout.
// Explicit cell positions preserve terminal column widths, including wide glyphs.
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const palette = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];
function indexed(n) {
  if (n < 16) return palette[n];
  if (n >= 232) return `rgb(${[8 + (n - 232) * 10].flatMap(v => [v, v, v]).join(',')})`;
  const k = n - 16, level = [0, 95, 135, 175, 215, 255];
  return `rgb(${[level[Math.floor(k / 36)], level[Math.floor(k / 6) % 6], level[k % 6]].join(',')})`;
}
function svg(name, title, raw) {
  const lines = [...raw];
  const empty = line => !stripTerminalSequences(line).trim() && !/\x1b\[(?:48|4[0-7]|10[0-7])(?:;|m)/.test(line);
  while (lines.length && empty(lines[0])) lines.shift();
  while (lines.length && empty(lines.at(-1))) lines.pop();
  const cell = 9, lineHeight = 23, padding = 28, top = 76;
  const w = width * cell + padding * 2, h = top + lines.length * lineHeight + padding;
  const body = [];
  for (const [row, line] of lines.entries()) {
    let column = 0, fg = '#d7dce2', bg, bold = false, italic = false, dim = false;
    const clean = line.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[(?![0-9;:]*m)[0-?]*[ -/]*[@-~]/g, '');
    for (const token of clean.match(/\x1b\[[0-9;:]*m|[^\x1b]+|\x1b/g) ?? []) {
      if (token.startsWith('\x1b[')) {
        const codes = token.slice(2, -1).split(';').map(Number);
        for (let i = 0; i < codes.length; i++) {
          const c = codes[i];
          if (c === 0) { fg = '#d7dce2'; bg = undefined; bold = italic = dim = false; }
          else if (c === 1) bold = true;
          else if (c === 2) dim = true;
          else if (c === 3) italic = true;
          else if (c === 22) bold = dim = false;
          else if (c === 23) italic = false;
          else if (c === 39) fg = '#d7dce2';
          else if (c === 49) bg = undefined;
          else if (c === 38 || c === 48) {
            let color;
            if (codes[i + 1] === 2) { color = `rgb(${codes.slice(i + 2, i + 5).join(',')})`; i += 4; }
            else if (codes[i + 1] === 5) { color = indexed(codes[i + 2]); i += 2; }
            if (color) { if (c === 38) fg = color; else bg = color; }
          } else if (c >= 30 && c <= 37) fg = palette[c - 30];
          else if (c >= 90 && c <= 97) fg = palette[c - 90 + 8];
          else if (c >= 40 && c <= 47) bg = palette[c - 40];
          else if (c >= 100 && c <= 107) bg = palette[c - 100 + 8];
        }
        continue;
      }
      const text = stripTerminalSequences(token).replace(/[\x00-\x1f\x7f]/g, '');
      const length = visibleWidth(text), x = padding + column * cell, y = top + row * lineHeight;
      if (bg && length) body.push(`<rect x="${x}" y="${y - 17}" width="${length * cell}" height="${lineHeight}" fill="${bg}"/>`);
      if (text.trim()) body.push(`<text x="${x}" y="${y}" fill="${fg}"${bold ? ' font-weight="700"' : ''}${italic ? ' font-style="italic"' : ''}${dim ? ' opacity="0.7"' : ''} textLength="${length * cell}" lengthAdjust="spacingAndGlyphs">${escape(text).replaceAll(' ', '&#160;')}</text>`);
      column += length;
    }
  }
  const result = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
<title id="title">${escape(title)}</title><desc id="desc">Actual Pi plugin component rendering with synthetic demo data. Not a desktop screenshot.</desc>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="12" fill="#171b23" stroke="#343d4d"/>
<path d="M1 46H${w - 1}" stroke="#343d4d"/>
<circle cx="25" cy="24" r="5" fill="#61738a"/><circle cx="43" cy="24" r="5" fill="#61738a"/><circle cx="61" cy="24" r="5" fill="#61738a"/>
<text x="${w / 2}" y="29" text-anchor="middle" fill="#a8b6c8" font-family="system-ui,sans-serif" font-size="13">${escape(title)}</text>
<g font-family="'SF Mono',SFMono-Regular,Menlo,Consolas,monospace" font-size="14" xml:space="preserve">${body.join('\n')}</g></svg>\n`;
  writeFileSync(join(output, `${name}.svg`), result);
  console.log(`${name}.svg: ${lines.length} rows`);
}

// Ask: use the same extension loader and UI factory as the integration tests.
const loaded = await loadExtensions([join(root, 'packages/ask-user-question/index.ts')], root, new EventEmitter());
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const tool = loaded.extensions[0].tools.get('ask_user_question').definition;
let component;
const controller = new AbortController();
const task = tool.execute('readme-demo', { questions: [
  { header: 'Approach', question: 'How should we improve this project?', options: [
    { label: 'Focused patch', description: 'Keep the change small and easy to review.', preview: '### Focused patch\n\n```text\nREADME.md\ndocs/\n  assets/\n  development.md\n```\n\nKeep runtime behavior unchanged.' },
    { label: 'Full redesign', description: 'Revisit the structure and interaction model.', preview: '### Full redesign\n\nReview the package layout, UI and documentation together.' },
    { label: 'Explore first', description: 'Compare a few approaches before editing.' },
  ] },
  { header: 'Validation', question: 'Which checks should we run?', multiSelect: true, options: [
    { label: 'Unit tests', description: 'Check plugin behavior.' },
    { label: 'Visual review', description: 'Inspect the rendered interface.' },
  ] },
] }, controller.signal, () => {}, {
  hasUI: true, mode: 'tui', cwd: root, isProjectTrusted: () => true,
  ui: { notify() {}, custom(factory) { return new Promise((done, reject) => {
    const tui = { terminal: { columns: width, rows: 44 }, requestRender() {}, getTopmostVisibleOverlay: () => undefined };
    Promise.resolve(factory(tui, theme, KeybindingsManager.create(root), done)).then(value => { component = value; }, reject);
  }); } },
});
try {
  for (let i = 0; i < 200 && !component; i++) await new Promise(r => setTimeout(r, 10));
  if (!component) throw new Error('Questionnaire did not render');
  svg('ask-user-question', 'Ask User Question · options + preview', component.render(width));
} finally { controller.abort(); await task; }

// Activity: use real native message/tool components and the actual projection.
const activityRoot = process.env.ACTIVITY_PACKAGE_ROOT ?? join(root, 'packages/activity-summary');
const { ActivityState } = await import(join(activityRoot, 'src/state.ts'));
const { mount } = await import(join(activityRoot, 'src/bridge.ts'));
class Terminal {
  columns = width; rows = 50;
  start() {} stop() {} write() {} hideCursor() {} showCursor() {}
  moveBy() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {}
}
class QuietTui extends TuiMainScreen { requestRender() {} }
const tui = new QuietTui(new Terminal());
const document = new Container(), source = new Container(), state = new ActivityState();
document.addChild(new Container()); document.addChild(new Container()); document.addChild(source); tui.addChild(document);
let expanded = false;
const release = mount(tui, () => state, text => theme.fg('dim', text), () => { throw new Error('Projection unavailable'); }, () => theme, () => expanded);
if (!release) throw new Error('Unsupported Pi host');
try {
  const message = { role: 'assistant', content: [
    { type: 'thinking', thinking: '**Check configuration**\n\nInspect the defaults and validate the configuration schema.' },
    { type: 'toolCall', id: 'demo-check', name: 'bash', arguments: { command: 'npm run check:config' } },
  ], stopReason: 'toolUse', timestamp: 1000 };
  state.start(message); state.bind('demo-assistant');
  source.addChild(new AssistantMessageComponent(message, true));
  const toolNode = new ToolExecutionComponent('bash', 'demo-check', { command: 'npm run check:config' }, { outputPad: 2, showImages: false }, undefined, tui, '/demo');
  toolNode.updateResult({ content: [{ type: 'text', text: 'Schema is valid.\nDefaults are consistent.' }], isError: false });
  state.tool('demo-check', 'bash', undefined, 'ok'); source.addChild(toolNode);
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'Configuration looks good. Ready for the next step.' }], stopReason: 'stop', timestamp: 1001 };
  state.start(answer); source.addChild(new AssistantMessageComponent(answer)); state.settle(false);
  svg('activity-collapsed', 'Activity Summary · collapsed', document.render(width));
  expanded = true; toolNode.setExpanded(true);
  svg('activity-expanded', 'Activity Summary · expanded with Ctrl+O', document.render(width));
} finally { release(); }
