import { thoughtTheme, toolTheme } from './text.ts';

export type Outcome = 'ok' | 'err' | 'open';
export type Completion = 'active' | 'complete' | 'error' | 'incomplete' | 'unknown';
export interface Tool { id: string; title: string; declared?: boolean; }
export interface Group {
  theme: string; thoughts: number; tools: Map<Tool, Outcome>;
  latestTool?: Tool; closed: boolean; completion: Completion;
}
export interface MessageState { groups: Map<number, Group>; tools: Map<number, Tool>; seen: Set<number>; notice?: string; }
const newMessage = (): MessageState => ({ groups: new Map(), tools: new Map(), seen: new Set() });
export const newGroup = (): Group => ({ theme: 'Working', thoughts: 0, tools: new Map(), closed: false, completion: 'active' });
const noticeText = (stop: string, aborted: boolean) => aborted || stop === 'aborted' ? '操作已中断' : stop === 'error' ? '模型请求失败' : stop === 'length' ? '模型输出已达长度上限' : '';
const ending = (stop: string, aborted = false): Completion => aborted || stop === 'aborted' || stop === 'length' ? 'incomplete' : stop === 'error' ? 'error' : stop === 'stop' ? 'complete' : 'unknown';

/** In-memory projection of original messages/events. No custom session metadata. */
export class ActivityState {
  groups: Group[] = [];
  current?: Group;
  message?: MessageState;
  byObject = new WeakMap<object, MessageState>();
  byId = new Map<string, MessageState>();
  toolGroups = new Map<string, Group>();
  private toolEntries = new Map<string, Tool | null>();
  lastStop = '';
  notice = '';
  orphanNotices: { id?: string; text: string }[] = [];

  userBoundary() {
    // Queued input can arrive before agent_settled. Settle the preceding message
    // once; an existing notice (even '') means it already settled, possibly aborted.
    if (this.message && this.message.notice === undefined) this.settle(false, undefined, ending(this.lastStop));
    this.message = undefined; this.lastStop = '';
  }
  boundary(completion: Completion = 'complete') {
    if (this.current) { this.current.closed = true; this.current.completion = completion; }
    this.current = undefined;
  }
  start(message: any) { this.notice = ''; this.message = newMessage(); this.observe(message); }
  private activity(index: number): Group {
    const existing = this.message!.groups.get(index);
    if (existing) return existing;
    if (!this.current) { this.current = newGroup(); this.groups.push(this.current); }
    this.message!.groups.set(index, this.current);
    return this.current;
  }
  observe(message: any) {
    if (!this.message) return;
    this.byObject.set(message, this.message);
    for (const [i, block] of message.content.entries()) {
      if (block.type === 'text' && block.text.trim()) {
        if (!this.message.seen.has(i)) this.boundary();
        this.message.seen.add(i);
      } else if (block.type === 'thinking' && block.thinking.trim()) {
        const first = !this.message.groups.has(i), g = this.activity(i);
        if (first) g.thoughts++;
        g.theme = thoughtTheme(block.thinking) || 'Thinking'; g.latestTool = undefined;
      } else if (block.type === 'toolCall' && block.id) {
        const g = this.activity(i);
        let tool = this.message.tools.get(i);
        if (!tool) {
          const concurrent = [...this.message.tools.values()].some(entry => entry.id === block.id);
          const provisional = this.toolEntries.get(block.id);
          tool = provisional && !provisional.declared ? provisional : { id: block.id, title: '' };
          const previous = this.toolGroups.get(block.id);
          const outcome = previous?.tools.get(tool) ?? 'open';
          if (previous && previous !== g && previous.tools.delete(tool) && !previous.thoughts && !previous.tools.size)
            this.groups = this.groups.filter(group => group !== previous);
          // Only duplicate declarations in this message share a concurrent batch.
          // A new message may reuse an old unresolved ID; retain the old occurrence
          // but associate subsequent results with the new one.
          const ambiguous = concurrent && (provisional === null || provisional && previous?.tools.get(provisional) === 'open');
          tool.declared = true; this.message.tools.set(i, tool); g.tools.set(tool, outcome);
          this.toolEntries.set(block.id, ambiguous ? null : tool);
        }
        tool.title = toolTheme(block.name, block.arguments);
        g.theme = tool.title; g.latestTool = tool;
        this.toolGroups.set(block.id, g);
      }
    }
    this.lastStop = message.stopReason;
  }
  bind(id: string) {
    if (this.message) this.byId.set(id, this.message);
  }
  tool(id: string, name: string, parent?: string, outcome?: Outcome, args?: unknown) {
    if (parent !== undefined || this.toolEntries.get(id) === null) return;
    let g = this.toolGroups.get(id), tool = this.toolEntries.get(id);
    if (!g || !tool) {
      this.message ??= newMessage(); g = this.activity(-1);
      tool = { id, title: toolTheme(name, args) }; g.tools.set(tool, 'open');
      g.theme = tool.title; g.latestTool = tool;
      this.toolGroups.set(id, g); this.toolEntries.set(id, tool);
    }
    // An earlier parallel tool finishing must not replace the latest activity title.
    if (outcome) g.tools.set(tool, outcome);
  }
  result(message: any) {
    if (this.toolEntries.get(message.toolCallId))
      this.tool(message.toolCallId, message.toolName, message.parentToolCallId, message.isError ? 'err' : 'ok');
  }
  settle(aborted: boolean, fallbackId?: string,
    completion: Completion = noticeText(this.lastStop, aborted) ? ending(this.lastStop, aborted) : 'complete') {
    this.notice = noticeText(this.lastStop, aborted);
    this.boundary(completion);
    if (this.message) this.message.notice = this.notice;
    else if (this.notice) {
      this.orphanNotices.push({ id: fallbackId, text: this.notice });
      if (fallbackId) this.byId.set(fallbackId, { ...newMessage(), notice: this.notice });
    }
  }
  restore(branch: readonly any[]) {
    let terminal = false, continuation = false;
    for (const entry of branch) {
      if (entry.type === 'message') {
        const m = entry.message;
        if (m.role === 'assistant') {
          if (terminal && !continuation) this.settle(false, undefined, ending(this.lastStop));
          this.start(m); this.bind(entry.id);
          // Tool calls continue even on length. A no-tool stop/length may also
          // continue if a boundary hook appends a hidden model instruction. Defer
          // its settlement until the next assistant or a user boundary/EOF.
          const hasTools = m.content.some((block: any) => block.type === 'toolCall');
          terminal = ['stop', 'length'].includes(m.stopReason) && !hasTools;
          continuation = false;
          if (m.stopReason === 'aborted') this.settle(false, undefined, ending(this.lastStop));
        } else if (m.role === 'toolResult') {
          this.result(m);
        } else if (m.role !== 'system') {
          this.userBoundary(); terminal = false; continuation = false;
        }
      } else if (entry.type === 'custom_message' && !entry.display) {
        continuation = true;
      } else if (entry.type === 'custom_message' && entry.display || entry.type === 'compaction' || entry.type === 'branch_summary') {
        this.userBoundary(); terminal = false; continuation = false;
      }
      // All custom entries (including old activity-summary v1/v2) are irrelevant.
    }
    this.settle(false, undefined, ending(this.lastStop)); this.message = undefined; this.lastStop = '';
  }
}
