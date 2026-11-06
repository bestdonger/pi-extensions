import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Group } from './state.ts';

export function clean(text: string): string {
  // Strip OSC/DCS/CSI first, then remaining C0/C1 and bidi display controls.
  return stripTerminalSequences(text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, ''))
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function thoughtTheme(text: string): string {
  const headings = [...text.matchAll(/^(?:#{1,6}\s+(.+)|\*\*([^*\n]+)\*\*\s*|__([^_\n]+)__\s*)$/gm)];
  const heading = headings.at(-1);
  const paragraphs = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const theme = heading ? heading[1] ?? heading[2] ?? heading[3] : paragraphs.at(-1) ?? '';
  return truncateToWidth(clean(theme.replace(/^#+\s*|\*\*/g, '')), 100);
}
export type Background = 'toolPendingBg' | 'toolSuccessBg' | 'toolErrorBg';
export interface Stats { theme: string; steps: string; tools: string; ok: string; err: string; open: string; background: Background; }
export function snapshot(g: Group): Stats {
  const outcomes = [...g.tools.values()];
  const ok = outcomes.filter(s => s === 'ok').length;
  const err = outcomes.filter(s => s === 'err').length;
  const open = outcomes.filter(s => s === 'open').length;
  const n = (v: number) => g.unknown ? '—' : String(v);
  const background: Background = err > 0 || g.completion === 'error' ? 'toolErrorBg'
    : !g.unknown && g.closed && g.completion === 'complete' && !open ? 'toolSuccessBg' : 'toolPendingBg';
  return { theme: g.theme, steps: n(g.thoughts + g.tools.size), tools: n(g.tools.size),
    ok: n(ok), err: n(err), open: n(open), background };
}

/** Paint semantic state from the SAME frozen snapshot as the counters. */
export function renderSummary(s: Stats, width: number, theme: Theme, expanded?: boolean, padding = 0): string {
  if (width <= 0) return '';
  // Give back horizontal padding on tiny terminals, always leaving a content column.
  const inset = Math.min(padding, Math.floor((width - 1) / 2));
  const innerWidth = width - 2 * inset, spaces = ' '.repeat(inset);
  const line = format(s, innerWidth, text => theme.fg('dim', text), expanded === undefined ? '·' : expanded ? '▾' : '▸');
  const fg = theme.getFgAnsi('text'), bg = theme.getBgAnsi(s.background);
  // Pi's truncation helper surrounds ellipses with SGR 0. theme.style() only
  // wraps, so explicitly restore the row's colors after inner style resets.
  const padded = `${spaces}${truncateToWidth(line, innerWidth, '…', true)}${spaces}`
    .replace(/\x1b\[(?:0)?m/g, reset => `${reset}${fg}${bg}`)
    .replaceAll('\x1b[49m', `\x1b[49m${bg}`)
    .replaceAll('\x1b[39m', `\x1b[39m${fg}`)
    .replaceAll('\x1b[22;39m', `\x1b[22;39m${fg}`);
  return theme.style(padded, { fg: 'text', bg: s.background });
}
/** Comfortable collapsed block; expanded native payload spacing remains unchanged. */
export function renderHeader(s: Stats, width: number, theme: Theme, expanded: boolean): string[] {
  if (width <= 0) return [];
  if (expanded) return [renderSummary(s, width, theme, true)];
  const blank = theme.style(' '.repeat(width), { fg: 'text', bg: s.background });
  return [blank, renderSummary(s, width, theme, false, 2), blank];
}

export function format(s: Stats, width: number, dim: (s: string) => string = s => s, marker = '·'): string {
  if (width <= 0) return '';
  const suffix = `${s.steps} steps | tools ${s.tools} ${dim(`(ok ${s.ok}, err ${s.err}, open ${s.open})`)}`;
  if (visibleWidth(suffix) <= width) {
    const room = width - visibleWidth(suffix) - 5;
    return room > 0 ? `${marker} ${truncateToWidth(clean(s.theme), room)} | ${suffix}` : suffix;
  }
  const small = `${s.steps}s t${s.tools} ${dim(`(✓${s.ok} !${s.err} ?${s.open})`)}`;
  if (visibleWidth(small) <= width) return small;
  const steps = `${s.steps} steps`;
  if (visibleWidth(steps) <= width) return steps;
  return truncateToWidth(`${s.steps}s`, width, '…');
}
