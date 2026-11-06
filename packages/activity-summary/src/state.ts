import { clean, thoughtTheme } from './text.ts';

export const RECORD = 'pi-activity-summary/v2';
export const LEGACY_RECORD = 'pi-activity-summary/v1';
export type Outcome = 'ok' | 'err' | 'open';
export type Completion = 'active' | 'complete' | 'error' | 'incomplete' | 'unknown';
export interface Group {
  id: number; theme: string; thought: boolean; thoughts: number; tools: Map<string, Outcome>;
  unknown: boolean; closed: boolean; completion: Completion;
  anchors: { message: MessageState; index: number }[];
}
export interface MessageState { id?: string; groups: Map<number, Group>; seen: Set<number>; notice?: string; }
export interface SavedGroup { anchors: string[]; theme: string; thoughts: number; tools: [string, Outcome][]; completion: Completion; }
interface LegacyGroup { anchors: string[]; theme: string; models: number; tools: [string, Outcome][]; }
const newMessage = (): MessageState => ({ groups: new Map(), seen: new Set() });
const noticeText = (stop: string, aborted = false) => aborted || stop === 'aborted' ? '操作已中断' : stop === 'error' ? '模型请求失败' : stop === 'length' ? '模型输出已达长度上限' : '';
const ending = (stop: string, notice = ''): Completion => {
  if (notice === '操作已中断' || notice === '模型输出已达长度上限') return 'incomplete';
  if (notice === '模型请求失败') return 'error';
  return stop === 'error' ? 'error' : stop === 'aborted' || stop === 'length' ? 'incomplete' : stop === 'stop' ? 'complete' : 'unknown';
};
const isRecord = (e: any) => e.type === 'custom' && (
  e.customType === LEGACY_RECORD && (e.data?.version === undefined || e.data.version === 1) ||
  e.customType === RECORD && e.data?.version === 2
) && Array.isArray(e.data?.groups);

export class ActivityState {
  groups: Group[] = [];
  current?: Group;
  message?: MessageState;
  byObject = new WeakMap<object, MessageState>();
  byId = new Map<string, MessageState>();
  toolGroups = new Map<string, Group>();
  lastStop = '';
  notice = '';
  historical = false;
  private savedGroups = new Map<string, string>();
  private savedNotices = new Map<string, string>();
  orphanNotices: { id?: string; text: string }[] = [];

  userBoundary() { this.boundary(); this.message = undefined; this.lastStop = ''; }
  boundary(completion: Completion = this.historical ? 'unknown' : 'complete') {
    if (this.current) { this.current.closed = true; this.current.completion = completion; }
    this.current = undefined;
  }
  start(message: any) {
    this.notice = '';
    this.message = newMessage();
    this.observe(message);
  }
  private activity(index: number): Group {
    const m = this.message!;
    const existing = m.groups.get(index);
    if (existing) return existing;
    if (!this.current) {
      this.current = { id: this.groups.length, theme: '处理中', thought: false, thoughts: 0,
        tools: new Map(), unknown: this.historical, closed: false, completion: 'active', anchors: [] };
      this.groups.push(this.current);
    }
    const g = this.current;
    m.groups.set(index, g); g.anchors.push({ message: m, index });
    return g;
  }
  observe(message: any) {
    if (!this.message) return;
    this.byObject.set(message, this.message);
    for (const [i, b] of message.content.entries()) {
      if (b.type === 'text' && b.text.trim()) {
        // Prose is a normal segment boundary, not the end of the whole agent run.
        if (!this.message.seen.has(i)) this.boundary('complete');
        this.message.seen.add(i);
      } else if (b.type === 'thinking' && b.thinking.trim()) {
        const first = !this.message.groups.has(i);
        const g = this.activity(i);
        if (first) g.thoughts++;
        const theme = thoughtTheme(b.thinking);
        if (theme) { g.theme = theme; g.thought = true; }
      } else if (b.type === 'toolCall' && b.id) {
        const g = this.activity(i);
        this.toolGroups.set(b.id, g);
        // A declared top-level call without a terminal result is open.
        if (!g.tools.has(b.id)) g.tools.set(b.id, 'open');
        if (!g.thought && b.name) g.theme = clean(b.name);
      }
    }
    this.lastStop = message.stopReason;
  }
  bind(id: string) {
    if (!this.message) return;
    this.message.id = id; this.byId.set(id, this.message);
  }
  tool(id: string, name: string, parent?: string, outcome?: Outcome) {
    // Nested calls are not transcript entries. Even a nested failure must not
    // change the outer call's outcome, title, counters, or background.
    if (parent !== undefined) return;
    let g = this.toolGroups.get(id);
    if (!g) {
      if (!this.message) this.message = newMessage();
      g = this.activity(-1);
    }
    this.toolGroups.set(id, g);
    if (!g.tools.has(id)) g.tools.set(id, 'open');
    if (outcome) g.tools.set(id, outcome);
    if (!g.thought) g.theme = clean(name);
  }
  settle(aborted: boolean, fallbackId?: string) {
    this.notice = noticeText(this.lastStop, aborted);
    // Only the current segment is affected. Earlier prose/offscreen rows keep
    // their frozen state. Replaying EOF is not proof of a successful run.
    this.boundary(this.notice ? ending(this.lastStop, this.notice) : this.historical ? 'unknown' : 'complete');
    if (this.message) this.message.notice = this.notice;
    else if (this.notice) {
      this.orphanNotices.push({ id: fallbackId, text: this.notice });
      if (fallbackId) this.byId.set(fallbackId, { ...newMessage(), id: fallbackId, notice: this.notice });
    }
  }
  saveNotices(): [string, string][] {
    return [...this.byId].filter(([, m]) => !!m.notice).map(([id, m]) => [id, m.notice!]);
  }
  private saved(g: Group): SavedGroup {
    return { anchors: g.anchors.map(a => `${a.message.id}:${a.index}`), theme: g.theme,
      thoughts: g.thoughts, tools: [...g.tools], completion: g.completion };
  }
  save(): SavedGroup[] {
    return this.groups.filter(g => !g.unknown && g.closed && g.anchors.length && g.anchors.every(a => a.message.id)).map(g => this.saved(g));
  }
  pendingRecord() {
    const groups = this.save().filter(g => this.savedGroups.get(g.anchors[0]!) !== JSON.stringify(g));
    const notices = this.saveNotices().filter(([id, text]) => this.savedNotices.get(id) !== text);
    return { version: 2, groups, notices };
  }
  committed(data: { groups: SavedGroup[]; notices: [string, string][] }) {
    for (const g of data.groups) this.savedGroups.set(g.anchors[0]!, JSON.stringify(g));
    for (const [id, text] of data.notices) this.savedNotices.set(id, text);
  }
  restore(branch: readonly any[]) {
    const blocks = new Map<string, any>();
    this.historical = true;
    for (const e of branch) {
      if (e.type === 'message') {
        const m = e.message;
        if (m.role === 'assistant') {
          this.start(m); this.bind(e.id);
          for (const [i, block] of m.content.entries()) blocks.set(`${e.id}:${i}`, block);
        } else if (m.role === 'toolResult') {
          // Counts may remain unknown, but an observed top-level failure is
          // still direct evidence for the background. Never create new groups.
          this.toolGroups.get(m.toolCallId)?.tools.set(m.toolCallId, m.isError ? 'err' : 'ok');
        } else if (m.role !== 'system') {
          this.settle(false); this.userBoundary();
          this.byId.set(e.id, { ...newMessage(), id: e.id });
        }
      } else if (isRecord(e)) {
        // Custom records preserve adjacent settled-run boundaries. For v1,
        // only an explicit terminal reason/prose boundary can prove completion.
        const notice = Array.isArray(e.data.notices) ? e.data.notices.find((n: any) => Array.isArray(n) && n[0] === this.message?.id)?.[1] : '';
        this.boundary(ending(this.lastStop, notice));
      } else if (e.type === 'custom_message' && e.display || e.type === 'compaction' || e.type === 'branch_summary') this.boundary();
    }
    this.settle(false); this.message = undefined; this.historical = false;
    const anchors = new Map<string, Group>(this.groups.flatMap(g => g.anchors.map(a => [`${a.message.id}:${a.index}`, g] as const)));
    for (const e of branch) {
      if (!isRecord(e)) continue;
      if (Array.isArray(e.data.notices)) for (const n of e.data.notices) {
        if (!Array.isArray(n) || n.length !== 2 || !['操作已中断', '模型请求失败', '模型输出已达长度上限'].includes(n[1])) continue;
        const m = this.byId.get(n[0]); if (m) { m.notice = n[1]; this.savedNotices.set(n[0], n[1]); }
      }
      const legacy = e.customType === LEGACY_RECORD;
      for (const s of e.data.groups) {
        if (!validSaved(s, legacy)) continue;
        // v1 anchored empty thinking too. It is safe to ignore only blocks
        // actually present and empty, never missing/unverifiable anchors.
        const effective = s.anchors.filter((a: string) => !(legacy && blocks.get(a)?.type === 'thinking' && !blocks.get(a).thinking.trim()));
        const g = anchors.get(effective[0]);
        if (!g || effective.length !== g.anchors.length || !effective.every((a: string) => anchors.get(a) === g)) continue;
        const savedTools = new Map<string, Outcome>(s.tools);
        const ids = [...g.tools.keys()];
        if (!ids.every(id => savedTools.has(id) && (g.tools.get(id) === 'open' || g.tools.get(id) === savedTools.get(id)))) continue;
        if (!legacy && (s.thoughts !== g.thoughts || savedTools.size !== ids.length)) continue;
        // Legacy tool-only titles could have been overwritten by nested calls.
        // Keep the title rebuilt from raw top-level activity when migrating v1.
        if (!legacy) g.theme = clean(s.theme);
        // The source message defines top-level membership, NOT ID spelling or
        // v1's models/tools totals. Extra v1 tools are nested and excluded.
        g.tools = new Map(ids.map(id => [id, savedTools.get(id)!]));
        g.unknown = false;
        if (!legacy) g.completion = s.completion;
        // Cache the migrated in-memory form without rewriting historical entries.
        const saved = this.saved(g);
        this.savedGroups.set(saved.anchors[0]!, JSON.stringify(saved));
      }
    }
  }
}
function validSaved(s: any, legacy: boolean): s is SavedGroup & LegacyGroup {
  return s && Array.isArray(s.anchors) && s.anchors.length > 0 && s.anchors.every((a: any) => typeof a === 'string') &&
    new Set(s.anchors).size === s.anchors.length && typeof s.theme === 'string' && Array.isArray(s.tools) &&
    s.tools.every((t: any) => Array.isArray(t) && t.length === 2 && typeof t[0] === 'string' && ['ok','err','open'].includes(t[1])) &&
    new Set(s.tools.map((t: any) => t[0])).size === s.tools.length &&
    (legacy ? Number.isSafeInteger(s.models) && s.models >= 0 : Number.isSafeInteger(s.thoughts) && s.thoughts >= 0 &&
      ['complete', 'error', 'incomplete', 'unknown'].includes(s.completion));
}
