import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Background } from './text.ts';

/** Preserve native foregrounds, Markdown and links, but give the whole group ONE background. */
function uniformBackground(line: string, foreground: string, background: string): string {
  return line.replace(/\x1b\[([0-9;:]*)m/g, (_sequence, parameters: string) => {
    const parts = parameters.split(';');
    let output = '';
    for (let i = 0; i < parts.length; i++) {
      const value = parts[i]!;
      const code = Number(value.split(':')[0] || 0);
      // Extended colors are a single operation: their RGB zeroes are NOT SGR resets.
      if (code === 38 || code === 48 || code === 58) {
        const count = value.includes(':') ? 0 : parts[i + 1] === '2' ? 4 : parts[i + 1] === '5' ? 2 : 0;
        if (code !== 48) output += `\x1b[${parts.slice(i, i + count + 1).join(';')}m`;
        i += count;
      } else if (code === 7 || code === 27 || code === 49 || code >= 40 && code <= 47 || code >= 100 && code <= 107) {
        // Remove native backgrounds, background resets and reverse-video (which
        // would turn a foreground color into a second background).
      } else if (code === 0) output += `\x1b[0m${foreground}${background}`;
      else if (code === 39) output += `\x1b[39m${foreground}`;
      else output += `\x1b[${value}m`;
    }
    return output;
  });
}

/** Native graphic payloads/reserved rows are protocol data, not text to pad or truncate. */
function imageRows(lines: readonly string[]): Set<number> {
  const result = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const kitty = line.match(/\x1b_G([^;]*);/);
    if (kitty) {
      result.add(index);
      const rows = Number(kitty[1]!.match(/(?:^|,)r=(\d+)(?:,|$)/)?.[1] ?? 1);
      for (let i = index + 1; i < Math.min(lines.length, index + rows) && !visibleWidth(lines[i]!) && !lines[i]!.includes('\x1b_G'); i++) result.add(i);
    } else if (line.includes('\x1b]1337;File=')) {
      result.add(index);
      const rows = Number(line.match(/\x1b\[(\d+)A/)?.[1] ?? 0);
      for (let i = index - 1; i >= Math.max(0, index - rows) && !visibleWidth(lines[i]!); i--) result.add(i);
    }
  }
  return result;
}

export function paintActivityLines(lines: readonly string[], width: number, background: Background, theme: Theme): string[] {
  if (width <= 0) return [];
  const graphicRows = imageRows(lines);
  const fg = theme.getFgAnsi('text'), bg = theme.getBgAnsi(background);
  return lines.map((line, index) => {
    if (graphicRows.has(index)) return line;
    // A thinking-only native assistant view adds shell prompt markers. Inside a
    // painted group they are no longer line prefixes, so remove them explicitly.
    const content = line.replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, '');
    const fitted = truncateToWidth(content, width, '…');
    // Padding should not inherit a custom renderer's unterminated underline/bold.
    const padded = `${fitted}\x1b[0m${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}`;
    return theme.style(uniformBackground(padded, fg, bg), { fg: 'text', bg: background });
  });
}
