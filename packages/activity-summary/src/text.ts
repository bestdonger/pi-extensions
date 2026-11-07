import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import type { Group } from './state.ts';

export function clean(text: string): string {
  return stripTerminalSequences(text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, ''))
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function thoughtTheme(text: string): string {
  const tail = text.slice(-8000);
  const headings = [...tail.matchAll(/(?:^|\n)\s*(?:\*\*([^\n]+?)\*\*|#{1,6}\s+([^\n]+))/gu)];
  const heading = headings.at(-1);
  const paragraph = tail.trim().split(/\n\s*\n/).at(-1)?.split('\n')[0];
  return truncateToWidth(clean(heading?.[1] ?? heading?.[2] ?? paragraph ?? 'Thinking'), 240);
}
export function toolTheme(name: string, args?: unknown): string {
  if (args && typeof args === 'object') for (const key of ['cmd', 'command', 'path', 'query', 'pattern']) {
    const value = Reflect.get(args, key);
    if (typeof value === 'string' && value.trim()) return truncateToWidth(clean(`${name}: ${value}`), 240);
  }
  return clean(name || 'Tool');
}
export type Background = 'toolPendingBg' | 'toolSuccessBg' | 'toolErrorBg';
export interface Stats { theme: string; steps: number; failed: number; background: Background; }
export function snapshot(g: Group): Stats {
  const outcomes = [...g.tools.values()], failed = outcomes.filter(s => s === 'err').length;
  const background: Background = failed || g.completion === 'error' ? 'toolErrorBg'
    : g.closed && g.completion === 'complete' && !outcomes.includes('open') ? 'toolSuccessBg' : 'toolPendingBg';
  return { theme: g.theme, steps: g.thoughts + g.tools.size, failed, background };
}

/** One grammar, as in collapse-transcript: status title · steps [· failed] chevron. */
export function format(s: Stats, width: number, dim: (s: string) => string = s => s, expanded = false): string {
  if (width <= 0) return '';
  const chevron = expanded ? '⌄' : '›';
  if (width <= 2) return chevron;
  const marker = s.background === 'toolErrorBg' ? '×' : s.background === 'toolSuccessBg' ? '•' : '●';
  const meta = `${s.steps} ${s.steps === 1 ? 'step' : 'steps'}${s.failed ? ` · ${s.failed} failed` : ''}`;
  return `${truncateToWidth(`${marker} ${clean(s.theme)}${dim(` · ${meta}`)}`, width - 2, '…')}${dim(` ${chevron}`)}`;
}

/** Paint semantic state from the SAME frozen snapshot as the header. */
export function renderSummary(s: Stats, width: number, theme: Theme, expanded = false): string {
  if (width <= 0) return '';
  const line = format(s, width, text => theme.fg('dim', text), expanded);
  const fg = theme.getFgAnsi('text'), bg = theme.getBgAnsi(s.background);
  // Native truncation emits SGR 0: restore the group's colors after inner resets.
  const padded = truncateToWidth(line, width, '…', true)
    .replace(/\x1b\[(?:0)?m/g, reset => `${reset}${fg}${bg}`)
    .replaceAll('\x1b[49m', `\x1b[49m${bg}`)
    .replaceAll('\x1b[39m', `\x1b[39m${fg}`)
    .replaceAll('\x1b[22;39m', `\x1b[22;39m${fg}`);
  return theme.style(padded, { fg: 'text', bg: s.background });
}
export function renderHeader(s: Stats, width: number, theme: Theme, expanded: boolean): string[] {
  if (width <= 0) return [];
  const header = renderSummary(s, width, theme, expanded);
  if (expanded) return [header];
  const blank = theme.style(' '.repeat(width), { fg: 'text', bg: s.background });
  return [blank, header, blank];
}
