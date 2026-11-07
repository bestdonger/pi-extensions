import { UserMessageComponent } from '@earendil-works/pi-coding-agent';

// Pi 1.5.0 private ABI is deliberately confined to this file. No prototypes,
// installation files, process.stdout, editor, or user/model messages are changed.
const OWNER = Symbol.for('pi-rex-prompt-navigation/bridge/v1');
const ZONES = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const PROMPT = /\x1b\]133;A(?:\x07|\x1b\\)/g;
const SGR_RESET = '\x1b[0m';
const STATES = new Set(['idle', 'working', 'blocked', 'done', 'error', 'clear']);
// OSC 7501 lifetime rules: A drops working/blocked and MAY drop idle.
// done/error survive prompts; resending them would refresh completion timestamps
// and produce redundant program_status_changed events. clear must not be replayed.
const PROMPT_SENSITIVE_STATES = new Set(['idle', 'working', 'blocked']);
export interface Status {
  state: string; app?: string; kind?: string; message?: string;
}
export type FormatStatus = (status: any) => string;
interface Terminal {
  write(data: string): void;
  setProgramStatus(status: Status): void;
  programStatusSupported: boolean;
  programStatus?: Status;
}
export interface Host {
  mode: string;
  terminal: Terminal;
  render(width: number): string[];
  doRender(): void;
  requestRender(force?: boolean): void;
  [OWNER]?: Bridge;
}
export interface Bridge {
  readonly active: boolean;
  readonly reason: string;
  readonly promptsWritten: number;
  dispose(): void;
}
/** Pi 1.5 hands widgets a stable forwarding Proxy. Its method getter invokes
 * inherited valueOf on the CURRENT renderer, which gives us the real instance.
 * Defining properties on the proxy itself would patch an unused empty object. */
export function unwrapTui(reference: object): Host {
  const host = reference.valueOf();
  if (!host || typeof host !== 'object') throw new Error('无法取得当前 Pi TUI');
  return host as Host;
}
export function isRex(env: Record<string, string | undefined>): boolean {
  // Require the Rex pane context, not just a substring in TERM or inherited PATH.
  // Multiplexers may not forward OSCs to the intended terminal.
  return !!env.REX_SESSION && !!env.REX_BLOCK && !env.TMUX && !env.STY;
}
function validStatus(value: unknown): value is Status | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const s = value as Status;
  return STATES.has(s.state) && ['app', 'kind', 'message'].every(k =>
    (s as any)[k] === undefined || typeof (s as any)[k] === 'string');
}

/** A tiny streaming observer. Never buffers/rewrites host data other than inserting
 * a status immediately AFTER a complete A marker (including markers split at the
 * host's 1 MiB write boundary). In particular, never splits an unrelated OSC/APC. */
export class StatusReplay {
  private tail = '';
  prompts = 0;
  apply(data: string, report: string): string {
    const prior = this.tail.length;
    const scan = this.tail + data;
    this.tail = scan.slice(-9); // longest A marker is 9 UTF-16 code units
    PROMPT.lastIndex = 0;
    let out = '', from = 0, match: RegExpExecArray | null;
    while ((match = PROMPT.exec(scan))) {
      const end = match.index + match[0].length - prior;
      if (end <= 0) continue; // entirely in the previous chunk: already handled
      this.prompts++;
      out += data.slice(from, end) + report;
      from = end;
    }
    return from ? out + data.slice(from) : data;
  }
}

export function mount(host: Host, version: string, formatStatus: FormatStatus,
  warn: (reason: string) => void, currentHost: () => Host = () => host): Bridge {
  if (version !== '1.5.0') throw new Error(`未验证的 Pi 版本 ${version}（仅验证 1.5.0）`);
  if (host.mode !== 'regular') throw new Error('仅支持 regular TUI');
  if (host[OWNER]) throw new Error('当前 TUI 已挂载 Rex prompt bridge');
  const terminal = host.terminal;
  if (!terminal || typeof terminal.write !== 'function' || typeof terminal.setProgramStatus !== 'function' ||
      typeof terminal.programStatusSupported !== 'boolean' || !validStatus(terminal.programStatus) ||
      typeof host.render !== 'function' || typeof host.requestRender !== 'function' ||
      typeof host.doRender !== 'function') throw new Error('Pi TUI/终端内部接口不兼容');
  // The real CLI is bundled/minified. Match the verified filter structurally,
  // allowing its bundled variable suffix, rather than relying on source paths.
  const rendererSource = Function.prototype.toString.call(host.doRender);
  if (!/this\.render\(width\)\.map\(/.test(rendererSource) ||
      !/\.replace\(OSC133_ZONE_PREFIX\d*,\s*""\)/.test(rendererSource)) {
    throw new Error('普通模式渲染器已变化，需重新验证标记过滤行为');
  }
  if (formatStatus({ state: 'working', app: 'pi' }) !== '\x1b]7501;state=working:app=pi\x1b\\') {
    throw new Error('程序状态编码接口已变化');
  }
  const originalRender = host.render, originalWrite = terminal.write;
  const renderDescriptor = Object.getOwnPropertyDescriptor(host, 'render');
  const writeDescriptor = Object.getOwnPropertyDescriptor(terminal, 'write');
  const replay = new StatusReplay();
  let active = true, reason = '已启用';
  function restore(object: any, key: string, wrapper: unknown, descriptor?: PropertyDescriptor) {
    // Do not clobber a later extension. Our retained wrapper becomes a no-op.
    if (object[key] !== wrapper) return;
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else delete object[key];
  }
  function dispose() {
    if (!active) return;
    active = false;
    if (reason === '已启用') reason = '已手动停用';
    restore(host, 'render', render, renderDescriptor);
    restore(terminal, 'write', write, writeDescriptor);
    if (host[OWNER] === bridge) delete host[OWNER];
  }
  function fail(message: string) {
    if (!active) return;
    reason = message;
    dispose();
    // Never change UI children or start another render while in a render frame.
    queueMicrotask(() => warn(message));
  }
  function healthy() {
    try {
      return currentHost() === host && host.mode === 'regular' && host.terminal === terminal &&
        host.render === render && terminal.write === write &&
        typeof terminal.programStatusSupported === 'boolean' && validStatus(terminal.programStatus);
    } catch { return false; }
  }
  function render(this: Host, width: number) {
    // Let errors in the original renderer propagate normally (never render twice).
    if (!active) return originalRender.call(this, width);
    if (!healthy()) {
      fail('运行时接口变化，已恢复 Pi 原生渲染');
      return originalRender.call(this, width);
    }
    // Both user AND assistant components carry native 133 markers. Shield only
    // real user components, for the duration of this synchronous render. Never
    // infer roles from text/background colors or patch a shared prototype.
    const restores: Array<() => void> = [];
    const visited = new Set<object>();
    const visit = (node: any) => {
      if (!node || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);
      if (node instanceof UserMessageComponent) {
        const original = node.render;
        const descriptor = Object.getOwnPropertyDescriptor(node, 'render');
        const shield = function (this: UserMessageComponent, width: number) {
          return original.call(this, width).map(line => ZONES.test(line) ? SGR_RESET + line : line);
        };
        Object.defineProperty(node, 'render', { configurable: true, writable: true, value: shield });
        restores.push(() => restore(node, 'render', shield, descriptor));
        return;
      }
      if (Array.isArray(node.children)) for (const child of node.children) visit(child);
      // Transparent projection components (including Activity Summary) retain
      // their native container as source. Do not walk arbitrary application data.
      if (node.source && typeof node.source.render === 'function') visit(node.source);
    };
    try { visit(this); }
    catch {
      for (const undo of restores.reverse()) undo();
      fail('用户消息组件不可适配，已恢复 Pi 原生渲染');
      return originalRender.call(this, width);
    }
    try {
      // Stable, zero-width decoration: native differential rendering stays in
      // charge of all positioning, scrollback, resize, and overlay compositing.
      return originalRender.call(this, width);
    } finally { for (const undo of restores.reverse()) undo(); }
  }
  function write(this: Terminal, data: string) {
    if (!active) return originalWrite.call(this, data);
    if (typeof data !== 'string') {
      fail('终端输出类型变化，已停止标记增强');
      return originalWrite.call(this, data);
    }
    if (!healthy()) {
      fail('终端输出接口变化，已停止标记增强');
      return originalWrite.call(this, data.replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, ''));
    }
    let report: string;
    try {
      // Reuse Pi's REAL current status only when the prompt can clear it.
      // Persistent done/error records already survive A: leave their timestamps
      // and event stream untouched. No parallel state machine or forced support.
      const status = terminal.programStatus;
      report = terminal.programStatusSupported && status && PROMPT_SENSITIVE_STATES.has(status.state)
        ? formatStatus(status) : '';
    } catch {
      fail('程序状态编码失败，已停止标记增强');
      // This frame may already contain shielded markers. Strip those before
      // writing so failure cannot clear an otherwise valid native program status.
      return originalWrite.call(this, data.replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, ''));
    }
    return originalWrite.call(this, replay.apply(data, report));
  }
  const bridge: Bridge = {
    get active() { return active; },
    get reason() { return reason; },
    get promptsWritten() { return replay.prompts; },
    dispose,
  };
  // Install transactionally; frozen/non-writable hosts fail without half a patch.
  try {
    Object.defineProperty(terminal, 'write', { configurable: true, writable: true, value: write });
    Object.defineProperty(host, 'render', { configurable: true, writable: true, value: render });
    Object.defineProperty(host, OWNER, { configurable: true, value: bridge });
  } catch (e) { dispose(); throw e; }
  try { host.requestRender(); }
  catch (e) { dispose(); throw e; }
  return bridge;
}
