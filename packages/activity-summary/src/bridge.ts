import { AssistantMessageComponent, ToolExecutionComponent, type Theme } from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, type TuiMouseEvent, MouseRegion, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import { ActivityState, newGroup, type Group, type Tool } from './state.ts';
import { clean, format, renderHeader, snapshot, type Stats, thoughtTheme, toolTheme } from './text.ts';
import { paintActivityLines } from './surface.ts';

// Isolated private document layout; compatibility is structural, not version-based. No prototype patches or history writes.
type Container = Component & { children: Component[] };
type FocusHost = TUI & {
  getFocusedComponent(): Component | null;
  retargetOverlayPreFocus(entry: { component: Component; preFocus: Component | null }): void;
};
const container = (v: any): v is Container => v && typeof v.render === 'function' && typeof v.invalidate === 'function' && Array.isArray(v.children);
const supportsFocus = (v: any): v is FocusHost => typeof v.getFocusedComponent === 'function' && typeof v.retargetOverlayPreFocus === 'function';
interface Row {
  stats: Stats; at: number; frozen: boolean; closed: boolean; position?: number; headerHeight: number;
  body?: { width: number; lines: string[] };
}
// Optional semantic title exposed by custom/native activity renderers. Never use
// arbitrary result text as a heading, and tolerate unsupported renderer shapes.
function activityLabel(root: any, seen = new Set<object>()): string | undefined {
  if (!root || typeof root !== 'object' || seen.has(root) || seen.size >= 64) return;
  seen.add(root);
  try {
    const label = root.getActivityLabel?.();
    if (typeof label === 'string' && label.trim()) return truncateToWidth(clean(label).replace(/^[^\p{L}\p{N}$]+/u, ''), 240);
    if (Array.isArray(root.children)) for (const child of root.children) {
      const label = activityLabel(child, seen); if (label) return label;
    }
  } catch { /* Custom renderers need not implement the optional title protocol. */ }
}
interface BlockView { view: AssistantMessageComponent; metadata: unknown[]; text?: string; streaming?: boolean; }
interface Section { group: Group; body: Component[]; }
type Part = Section | { lines: string[]; component?: Component };
type MouseTarget = { top: number; height: number } & ({ group: Group } | { component: Component; group?: Group });
interface Expansion {
  isExpanded(): boolean;
  paint(lines: string[], stats: Stats, width: number): string[];
}
export class Projection implements Component {
  private rows = new Map<Group, Row>();
  private blocks = new WeakMap<object, Map<number, BlockView>>();
  private fallbackEntries = new WeakMap<object, Map<number, { group: Group; tool?: Tool }>>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private lastState?: ActivityState;
  private lastExpanded = false;
  private orphanAnchors = new WeakMap<object, Component | undefined>();
  private lastMode?: TUI['mode'];
  private localExpansion = new Map<Group, boolean>();
  private localTools = new Map<ToolExecutionComponent, Group>();
  private bodyFocus = new Map<Component, { group: Group; previous: Component | null }>();
  private mouseTargets: MouseTarget[] = [];
  private pressedGroup?: Group;
  constructor(readonly source: Container, readonly state: () => ActivityState, readonly tui: TUI,
    readonly prefix: (width: number) => number, readonly dim: (s: string) => string,
    readonly supported: () => boolean, readonly fail: () => void, readonly now = () => performance.now(),
    readonly renderHeader: (stats: Stats, width: number, expanded: boolean) => string | string[] = (s, w, expanded) => format(s, w, dim, expanded),
    readonly expansion?: Expansion, readonly separateBlocks = false) {}
  invalidate() {
    // Host resize/theme invalidation may rebuild body layout, but preserves the
    // frozen semantic header state. Manual expand/collapse explicitly refreshes it.
    this.blocks = new WeakMap(); this.mouseTargets = []; this.pressedGroup = undefined;
    for (const row of this.rows.values()) row.body = undefined;
    this.source.invalidate();
  }
  private restoreTools(group?: Group) {
    const expanded = this.expansion?.isExpanded() ?? false;
    for (const [tool, owner] of this.localTools) if (!group || owner === group) {
      tool.setExpanded(expanded); this.localTools.delete(tool);
    }
  }
  private focused(): Component | null {
    return (this.tui as FocusHost).getFocusedComponent();
  }
  private unlinkFocus(component: Component, previous: Component | null) {
    for (const other of this.bodyFocus.values()) if (other.previous === component) other.previous = previous;
    this.bodyFocus.delete(component);
  }
  private restoreFocus(group?: Group) {
    for (const [component, entry] of this.bodyFocus) if (!group || entry.group === group) {
      // Repair both visible-body return chains and Pi's saved overlay preFocus,
      // without stealing a currently focused overlay or another visible body.
      this.unlinkFocus(component, entry.previous);
      (this.tui as FocusHost).retargetOverlayPreFocus({ component, preFocus: entry.previous });
      if (this.focused() === component) this.tui.setFocus(entry.previous);
    }
  }
  private isExpanded(group: Group, global: boolean): boolean {
    return this.tui.mode === 'fullscreen' ? this.localExpansion.get(group) ?? global : global;
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer); this.timer = undefined;
    this.restoreFocus(); this.restoreTools(); this.localExpansion.clear(); this.mouseTargets = []; this.pressedGroup = undefined;
  }
  handleMouse(event: TuiMouseEvent) {
    if (this.disposed || this.tui.mode !== 'fullscreen' || !this.supported()) return;
    const target = this.mouseTargets.find(t => event.y >= t.top && event.y < t.top + t.height);
    if (!target) return;
    if ('component' in target) {
      const previous = this.focused();
      const result = new MouseRegion(target.component, () => undefined)
        .handleMouse({ ...event, y: event.y - target.top, height: target.height });
      // Pi sends later release/click events directly to a handled press target.
      // Remember its return focus now, even if it requests focus only later.
      if (target.group && result && 'target' in result && (event.type === 'press' || result.focus)) {
        const next = result.focusTarget ?? result.target.component;
        if (next !== previous) {
          const old = this.bodyFocus.get(next);
          if (old) this.unlinkFocus(next, old.previous);
          this.bodyFocus.set(next, { group: target.group, previous });
        }
      }
      return result;
    }
    // Shift-drag remains available for native selection of a summary; body text,
    // wheel scrolling, hyperlinks and modal focus stay entirely with Pi.
    if (event.button !== 'left' || event.shift || event.alt || event.ctrl) return;
    if (event.type === 'press') { this.pressedGroup = target.group; return { handled: true, render: false }; }
    if (event.type === 'click') {
      if (this.pressedGroup !== target.group) return;
      this.pressedGroup = undefined;
      const expanded = !this.isExpanded(target.group, this.expansion?.isExpanded() ?? false);
      if (!expanded) { this.restoreFocus(target.group); this.restoreTools(target.group); }
      this.localExpansion.set(target.group, expanded);
      this.rows.delete(target.group);
      this.tui.requestRender();
      return { handled: true };
    }
  }
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
    const fullscreen = this.tui.mode === 'fullscreen';
    if (state !== this.lastState || this.tui.mode !== this.lastMode) {
      this.restoreFocus(); this.restoreTools(); this.localExpansion.clear(); this.mouseTargets = []; this.pressedGroup = undefined;
      this.rows.clear(); this.blocks = new WeakMap(); this.fallbackEntries = new WeakMap();
      this.orphanAnchors = new WeakMap(); this.lastState = state; this.lastMode = this.tui.mode;
    }
    if (expanded !== this.lastExpanded) {
      // User-authorized global layout change. Do not carry old viewport positions
      // or stale counters across a manual expansion/collapse.
      if (!expanded) this.restoreFocus();
      this.restoreTools(); this.localExpansion.clear(); this.pressedGroup = undefined;
      this.rows.clear(); clearTimeout(this.timer); this.timer = undefined;
      this.lastExpanded = expanded;
    }
    // Native tool components are appended after the assistant node. Place their
    // payload at the original toolCall block so interleaved thinking/prose/tools
    // keep message/block order rather than batching all thinking before all tools.
    const nativeTools = new Map<Component, Map<number, ToolExecutionComponent>>();
    {
      const declarations = new Map<string, { node: Component; index: number }[]>();
      for (const node of this.source.children) {
        if (node instanceof AssistantMessageComponent) {
          // Native tool rows belong to the preceding assistant batch. Duplicate
          // IDs can leave unmatched declarations; never carry those into a new batch.
          declarations.clear();
          const content = Reflect.get(node, 'lastMessage')?.content;
          if (Array.isArray(content)) for (const [index, block] of content.entries()) {
            if (block.type === 'toolCall') {
              const queue = declarations.get(block.id) ?? [];
              queue.push({ node, index }); declarations.set(block.id, queue);
            }
          }
        } else if (node instanceof ToolExecutionComponent) {
          const id = Reflect.get(node, 'toolCallId'), declaration = declarations.get(id)?.shift();
          if (!declaration) continue;
          let slots = nativeTools.get(declaration.node);
          if (!slots) { slots = new Map(); nativeTools.set(declaration.node, slots); }
          slots.set(declaration.index, node);
        }
      }
    }
    const placedTools = new Set<Component>();
    const parts: Part[] = [];
    const sections = new Map<Group, Section>();
    const append = (lines: string[], component?: Component) => parts.push({ lines, component });
    const collect = (g: Group, body?: Component) => {
      let section = sections.get(g);
      if (!section) { section = { group: g, body: [] }; sections.set(g, section); parts.push(section); }
      if (body) section.body.push(body);
    };
    for (const notice of state.orphanNotices) {
      if (!this.orphanAnchors.has(notice)) this.orphanAnchors.set(notice, this.source.children.at(-1));
    }
    let fallbackGroup: Group | undefined;
    const fallback = (node: object, index: number, block: any, native?: any): Group => {
      let slots = this.fallbackEntries.get(node);
      if (!slots) { slots = new Map(); this.fallbackEntries.set(node, slots); }
      let entry = slots.get(index);
      if (!entry) {
        const group = { ...newGroup(), completion: 'unknown' as const };
        const tool = block.type === 'thinking' ? undefined : { id: block.id, title: toolTheme(block.name, block.arguments) };
        entry = { group, tool }; slots.set(index, entry);
      }
      // Cache identities, not old partitions: unknown entries may become known.
      if (!fallbackGroup) {
        fallbackGroup = entry.group; fallbackGroup.thoughts = 0; fallbackGroup.tools.clear();
      }
      const group = fallbackGroup, { tool } = entry;
      if (tool) {
        tool.title = toolTheme(block.name, block.arguments);
        group.tools.set(tool, native?.result && !native.isPartial ? native.result.isError ? 'err' : 'ok' : 'open');
      } else group.thoughts++;
      group.theme = tool ? activityLabel(native?.resultRendererComponent) || tool.title : thoughtTheme(block.thinking);
      group.latestTool = tool; fallbackGroup = group;
      return group;
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
            const native = nativeTools.get(node)?.get(index);
            const known = m?.groups.get(index);
            if (known) fallbackGroup = undefined;
            const g = known ?? fallback(node, index, block, native);
            if (native && g.latestTool && g.latestTool === m?.tools.get(index))
              g.theme = activityLabel(Reflect.get(native, 'resultRendererComponent')) || g.latestTool.title;
            const payload = block.type === 'thinking'
              ? this.isExpanded(g, expanded) ? this.blockView(node, message, index) : undefined
              : native;
            collect(g, payload && !placedTools.has(payload) ? payload : undefined);
            if (native) placedTools.add(native);
          } else if (block.type === 'text' && block.text.trim()) {
            fallbackGroup = undefined;
            const view = this.blockView(node, message, index);
            append(view.render(width), view);
          }
        }
        if (m?.notice) append([truncateToWidth(m.notice, width)]);
      } else if (component instanceof ToolExecutionComponent) {
        const node = component as any;
        // Reuse the real renderer (including custom tools). Pi owns the global
        // expansion flag; fullscreen may override only the native view's flag.
        // An orphan/no-message tool still has a display location here.
        if (!placedTools.has(component)) {
          const known = state.toolGroups.get(node.toolCallId);
          if (known) fallbackGroup = undefined;
          collect(known ?? fallback(node, 0, { id: node.toolCallId, name: node.toolName, arguments: node.args }, node), component);
        }
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
        if (rendered.some(s => stripTerminalSequences(s).trim())) fallbackGroup = undefined;
        append(rendered, component);
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
    // Fullscreen owns and can redraw its complete transcript. The regular-only
    // scrollback protection must not freeze fullscreen rows as they scroll away.
    const top = fullscreen ? -Infinity : Reflect.get(this.tui, 'previousViewportTop') as number;
    this.mouseTargets = [];
    for (const part of parts) {
      if ('lines' in part) {
        if (part.component) this.mouseTargets.push({ top: lines.length, height: part.lines.length, component: part.component });
        lines.push(...part.lines); continue;
      }
      // Match native ToolExecutionComponent's leading Spacer(1). This row is
      // OUTSIDE the painted block, and must not participate in its freeze boundary.
      if (this.separateBlocks && width > 0) lines.push('');
      const g = part.group;
      const groupExpanded = this.isExpanded(g, expanded);
      let r = this.rows.get(g);
      const time = this.now();
      const position = base + lines.length;
      const previousPosition = r?.position;
      const previousBodyStart = previousPosition === undefined ? undefined : previousPosition + r!.headerHeight;
      if (!r) { r = { stats: snapshot(g), at: time, frozen: g.closed, closed: g.closed, headerHeight: 0 }; this.rows.set(g, r); }
      else {
        if (fullscreen) r.frozen = false;
        if (r.position !== undefined && (r.position < top || position < top)) r.frozen = true;
        if (!r.frozen) {
          const next = snapshot(g);
          if (g.closed && (!fullscreen || !r.closed)) {
            // Flush a new boundary once. Late fullscreen results still use the
            // normal throttle; regular offscreen protection takes precedence.
            r.stats = next; r.at = time; r.frozen = true;
            // The shared wake may still be needed by another group's late result.
          } else if (JSON.stringify(next) !== JSON.stringify(r.stats)) {
            if (time - r.at >= 250) { r.stats = next; r.at = time; }
            else this.wake(250 - (time - r.at));
          }
        }
      }
      r.closed = g.closed; r.position = position;
      const renderedHeader = this.renderHeader(r.stats, width, groupExpanded);
      const header = typeof renderedHeader === 'string' ? [renderedHeader] : renderedHeader;
      r.headerHeight = header.length;
      this.mouseTargets.push({ top: lines.length, height: header.length, group: g });
      lines.push(...header);
      const bodyStart = position + header.length;
      if (groupExpanded) {
        if (r.body?.width === width && previousBodyStart !== undefined &&
            Math.max(previousBodyStart, bodyStart) + r.body.lines.length <= top) {
          // The whole old payload is in scrollback: avoid rendering/painting it
          // on every keystroke. Manual toggles and host invalidation clear this cache.
          lines.push(...r.body.lines);
          continue;
        }
        const rendered: string[] = [];
        for (const component of part.body) {
          // Apply a local opening once per tool, including tools arriving later.
          // Subsequent native result clicks own their expansion until the next
          // group/global toggle; do not undo them on every render.
          if (fullscreen && this.localExpansion.get(g) === true && component instanceof ToolExecutionComponent && !this.localTools.has(component)) {
            this.localTools.set(component, g); component.setExpanded(true);
          }
          const body = component.render(width);
          this.mouseTargets.push({ top: lines.length + rendered.length, height: body.length, component, group: g });
          rendered.push(...body);
        }
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
  if (!['regular', 'fullscreen'].includes(host.mode) ||
      (host.mode === 'fullscreen' && !supportsFocus(host)) ||
      (host.mode === 'regular' && !Number.isFinite(host.previousViewportTop)) || !container(document) ||
      document.children.length !== 3 || !document.children.every(container)) return undefined;
  const source = document.children[2] as Container;
  let released = false;
  let projection: Projection;
  const release = () => {
    if (released) return;
    released = true; projection.dispose();
    if (document.children[2] === projection) document.children[2] = source;
  };
  const supported = () => ['regular', 'fullscreen'].includes(host.mode) &&
    (host.mode !== 'fullscreen' || supportsFocus(host)) && host.children?.[0] === document && document.children.length === 3 &&
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
