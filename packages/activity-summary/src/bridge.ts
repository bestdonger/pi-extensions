import { AssistantMessageComponent, ToolExecutionComponent, type Theme } from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import { ActivityState, type Group } from './state.ts';
import { format, renderHeader, snapshot, type Stats, thoughtTheme } from './text.ts';
import { paintActivityLines } from './surface.ts';

// Deliberately isolated Pi 1.5 private ABI. No prototype patches or source-node writes.
type Container = Component & { children: Component[] };
const container = (v: any): v is Container => v && typeof v.render === 'function' && typeof v.invalidate === 'function' && Array.isArray(v.children);
interface Row {
  stats: Stats; at: number; frozen: boolean; position?: number; headerHeight: number;
  body?: { width: number; lines: string[] };
}
interface BlockView { view: AssistantMessageComponent; metadata: unknown[]; text?: string; streaming?: boolean; }
interface Section { group: Group; body: Component[]; }
type Part = Section | { lines: string[] };
interface Expansion {
  isExpanded(): boolean;
  paint(lines: string[], stats: Stats, width: number): string[];
}
export class Projection implements Component {
  private rows = new Map<Group, Row>();
  private blocks = new WeakMap<object, Map<number, BlockView>>();
  private unknown = new WeakMap<object, Map<number, Group>>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private lastState?: ActivityState;
  private lastExpanded = false;
  private orphanAnchors = new WeakMap<object, Component | undefined>();
  constructor(readonly source: Container, readonly state: () => ActivityState, readonly tui: TUI,
    readonly prefix: (width: number) => number, readonly dim: (s: string) => string,
    readonly supported: () => boolean, readonly fail: () => void, readonly now = () => performance.now(),
    readonly renderHeader: (stats: Stats, width: number, expanded: boolean) => string | string[] = (s, w) => format(s, w, dim),
    readonly expansion?: Expansion, readonly separateBlocks = false) {}
  invalidate() {
    // Host resize/theme invalidation may rebuild body layout, but preserves the
    // frozen semantic header state. Manual expand/collapse explicitly refreshes it.
    this.blocks = new WeakMap();
    for (const row of this.rows.values()) row.body = undefined;
    this.source.invalidate();
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.timer = undefined; }
  private wake(delay: number) {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (!this.disposed) this.tui.requestRender(); }, delay);
  }
  private blockView(node: any, message: any, index: number): AssistantMessageComponent {
    const block = message.content[index];
    let slots = this.blocks.get(node);
    if (!slots) { slots = new Map(); this.blocks.set(node, slots); }
    const metadata = [node.markdownTheme, node.outputPad, node.markdownTransformers, node.messageId, node.timestamp, block.type];
    let cached = slots.get(index);
    if (!cached || !metadata.every((v, i) => v === cached!.metadata[i])) {
      cached = { view: new AssistantMessageComponent(undefined, false, node.markdownTheme, '', node.outputPad,
        node.markdownTransformers, node.messageId, node.timestamp), metadata };
      slots.set(index, cached);
    }
    const text = block.type === 'thinking' ? block.thinking : block.text;
    // Neither prose nor thinking transformers rerun for unrelated tool updates.
    if (cached.text !== text || cached.streaming !== node.isStreaming) {
      cached.view.updateContent({ ...message, content: [{ ...block }], stopReason: 'stop', errorMessage: undefined }, node.isStreaming);
      cached.text = text; cached.streaming = node.isStreaming;
    }
    return cached.view;
  }
  render(width: number): string[] {
    if (this.disposed) return this.source.render(width);
    if (!this.supported()) { this.fail(); return this.source.render(width); }
    const state = this.state();
    const expanded = this.expansion?.isExpanded() ?? false;
    if (state !== this.lastState) {
      this.rows.clear(); this.blocks = new WeakMap(); this.unknown = new WeakMap();
      this.orphanAnchors = new WeakMap(); this.lastState = state;
    }
    if (expanded !== this.lastExpanded) {
      // User-authorized global layout change. Do not carry old viewport positions
      // or stale counters across a manual expansion/collapse.
      this.rows.clear(); clearTimeout(this.timer); this.timer = undefined;
      this.lastExpanded = expanded;
    }
    // Native tool components are appended after the assistant node. Place their
    // payload at the original toolCall block so interleaved thinking/prose/tools
    // keep message/block order rather than batching all thinking before all tools.
    const nativeTools = new Map<Component, Map<number, ToolExecutionComponent>>();
    if (expanded) {
      const declarations = new Map<string, { node: Component; index: number }>();
      for (const node of this.source.children) {
        if (node instanceof AssistantMessageComponent) {
          const content = Reflect.get(node, 'lastMessage')?.content;
          if (Array.isArray(content)) for (const [index, block] of content.entries()) {
            if (block.type === 'toolCall') declarations.set(block.id, { node, index });
          }
        } else if (node instanceof ToolExecutionComponent) {
          const id = Reflect.get(node, 'toolCallId'), declaration = declarations.get(id);
          if (!declaration) continue;
          let slots = nativeTools.get(declaration.node);
          if (!slots) { slots = new Map(); nativeTools.set(declaration.node, slots); }
          slots.set(declaration.index, node); declarations.delete(id);
        }
      }
    }
    const placedTools = new Set<Component>();
    const parts: Part[] = [];
    const sections = new Map<Group, Section>();
    const append = (lines: string[]) => parts.push({ lines });
    const collect = (g: Group, body?: Component) => {
      let section = sections.get(g);
      if (!section) { section = { group: g, body: [] }; sections.set(g, section); parts.push(section); }
      if (expanded && body) section.body.push(body);
    };
    for (const notice of state.orphanNotices) {
      if (!this.orphanAnchors.has(notice)) this.orphanAnchors.set(notice, this.source.children.at(-1));
    }
    let legacy: Group | undefined;
    const fallback = (node: object, index: number, theme: string): Group => {
      let slots = this.unknown.get(node);
      if (!slots) { slots = new Map(); this.unknown.set(node, slots); }
      let g = slots.get(index);
      if (!g) {
        g = legacy ?? { id: -1, theme: theme || '处理中', thought: false, thoughts: 0, tools: new Map(), unknown: true, closed: true, completion: 'unknown', anchors: [] };
        slots.set(index, g);
      }
      legacy = g;
      return g;
    };
    for (const component of this.source.children) {
      if (component instanceof AssistantMessageComponent) {
        const node = component as any;
        const message = node.lastMessage;
        if (!message) continue;
        if (!Array.isArray(message.content) || !Array.isArray(node.markdownTransformers) || typeof node.outputPad !== 'number') {
          this.fail(); return this.source.render(width);
        }
        const m = state.byObject.get(message) ?? state.byId.get(node.messageId);
        for (const [index, block] of message.content.entries()) {
          if (block.type === 'thinking' || block.type === 'toolCall') {
            if (block.type === 'thinking' && !block.thinking.trim()) continue;
            const g = m?.groups.get(index) ?? state.toolGroups.get(block.id) ?? fallback(node, index, block.type === 'thinking' ? thoughtTheme(block.thinking) : block.name);
            const payload = expanded ? block.type === 'thinking' ? this.blockView(node, message, index) : nativeTools.get(node)?.get(index) : undefined;
            collect(g, payload && !placedTools.has(payload) ? payload : undefined);
            if (payload instanceof ToolExecutionComponent) placedTools.add(payload);
          } else if (block.type === 'text' && block.text.trim()) {
            legacy = undefined;
            append(this.blockView(node, message, index).render(width));
          }
        }
        if (m?.notice) append([truncateToWidth(m.notice, width)]);
      } else if (component instanceof ToolExecutionComponent) {
        const node = component as any;
        // Reuse the real renderer (including custom tools). Pi itself owns its
        // expanded flag via Ctrl+O/getToolsExpanded; do not mutate the source node.
        // An orphan/no-message tool still has a display location here.
        if (!placedTools.has(component)) collect(state.toolGroups.get(node.toolCallId) ?? fallback(node, 0, node.toolName), component);
      } else {
        // Keep final model diagnostics concise even when tool details are open.
        if (component.constructor.name === 'ThemedText') {
          const build = Reflect.get(component, 'build');
          if (typeof build === 'function') {
            const value = build.call(component);
            if (typeof value === 'string') {
              const raw = stripTerminalSequences(value).trim();
              if (raw.startsWith('Error: Retry failed after ') || raw === 'If this looks like a pi bug, /bug sends a report to the developers.') continue;
            }
          }
        }
        const rendered = component.render(width);
        if (rendered.some(s => stripTerminalSequences(s).trim())) legacy = undefined;
        append(rendered);
        const notice = state.byId.get(Reflect.get(component, 'messageId'))?.notice;
        if (notice) append([truncateToWidth(notice, width)]);
      }
      for (const notice of state.orphanNotices) {
        if (this.orphanAnchors.get(notice) === component && !(notice.id && Reflect.get(component, 'messageId') === notice.id)) append([truncateToWidth(notice.text, width)]);
      }
    }
    for (const notice of state.orphanNotices) if (!this.orphanAnchors.get(notice)) append([truncateToWidth(notice.text, width)]);

    const lines: string[] = [];
    const base = this.prefix(width);
    const top = Reflect.get(this.tui, 'previousViewportTop') as number;
    for (const part of parts) {
      if ('lines' in part) { lines.push(...part.lines); continue; }
      // Match native ToolExecutionComponent's leading Spacer(1). This row is
      // OUTSIDE the painted block, and must not participate in its freeze boundary.
      if (this.separateBlocks && width > 0) lines.push('');
      const g = part.group;
      let r = this.rows.get(g);
      const time = this.now();
      const position = base + lines.length;
      const previousPosition = r?.position;
      const previousBodyStart = previousPosition === undefined ? undefined : previousPosition + r!.headerHeight;
      if (!r) { r = { stats: snapshot(g), at: time, frozen: g.closed, headerHeight: 0 }; this.rows.set(g, r); }
      else {
        if (r.position !== undefined && (r.position < top || position < top)) r.frozen = true;
        if (!r.frozen) {
          const next = snapshot(g);
          if (g.closed) {
            // Safe final flush; the offscreen check still takes precedence.
            r.stats = next; r.at = time; r.frozen = true;
            clearTimeout(this.timer); this.timer = undefined;
          } else if (JSON.stringify(next) !== JSON.stringify(r.stats)) {
            if (time - r.at >= 250) { r.stats = next; r.at = time; }
            else this.wake(250 - (time - r.at));
          }
        }
      }
      r.position = position;
      const renderedHeader = this.renderHeader(r.stats, width, expanded);
      const header = typeof renderedHeader === 'string' ? [renderedHeader] : renderedHeader;
      r.headerHeight = header.length;
      lines.push(...header);
      const bodyStart = position + header.length;
      if (expanded) {
        if (r.body?.width === width && previousBodyStart !== undefined &&
            Math.max(previousBodyStart, bodyStart) + r.body.lines.length <= top) {
          // The whole old payload is in scrollback: avoid rendering/painting it
          // on every keystroke. Manual toggles and host invalidation clear this cache.
          lines.push(...r.body.lines);
          continue;
        }
        const rendered = part.body.flatMap(component => component.render(width));
        let body = this.expansion!.paint(rendered, r.stats, width);
        if (r.body?.width === width) {
          // Allow new output at the visible tail of a tall block, but never
          // rewrite its offscreen prefix (including background-only changes).
          const protectedRows = Math.max(0, top - Math.min(previousBodyStart ?? bodyStart, bodyStart));
          const limit = Math.min(protectedRows, Math.max(body.length, r.body.lines.length));
          for (let i = 0; i < limit; i++) {
            if (body[i] !== r.body.lines[i]) { body = r.body.lines; break; }
          }
        }
        r.body = { width, lines: body };
        lines.push(...body);
      }
    }
    return lines;
  }
}

export function mount(tui: TUI, state: () => ActivityState, dim: (s: string) => string, warning: () => void,
  theme?: () => Theme, expanded: () => boolean = () => false): (() => void) | undefined {
  const host = tui as any;
  const document = host.children?.[0];
  if (host.mode !== 'regular' || !Number.isFinite(host.previousViewportTop) || !container(document) ||
      document.children.length !== 3 || !document.children.every(container)) return undefined;
  const source = document.children[2] as Container;
  let released = false;
  let projection: Projection;
  const release = () => {
    if (released) return;
    released = true; projection.dispose();
    if (document.children[2] === projection) document.children[2] = source;
  };
  const supported = () => host.mode === 'regular' && host.children?.[0] === document && document.children.length === 3 &&
    container(document.children[0]) && container(document.children[1]) && document.children[2] === projection;
  projection = new Projection(source, state, tui,
    w => document.children[0]!.render(w).length + document.children[1]!.render(w).length,
    dim, supported, () => { release(); warning(); }, undefined,
    theme ? (stats, width, expanded) => renderHeader(stats, width, theme(), expanded) : undefined,
    { isExpanded: expanded, paint: (lines, stats, width) => theme ? paintActivityLines(lines, width, stats.background, theme()) : lines }, true);
  (document.children as Component[])[2] = projection;
  tui.requestRender();
  return release;
}
