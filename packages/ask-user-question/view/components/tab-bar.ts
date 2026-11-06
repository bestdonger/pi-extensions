import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.ts";

/**
 * Per-tick projection of TabBar state. The selector
 * (`selectTabBarProps`) hoists every render-time derivation
 * (`allAnswered`, `answered`, `isActive`, `submitActive`) into props so
 * `render()` is pure styling.
 */
export interface TabBarProps {
	/** One per author-defined question, in order. */
	tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean }>;
	/** Submit-tab state. `allAnswered` drives the success/dim color picker. */
	submit: { active: boolean; allAnswered: boolean };
}

export class TabBar implements StatefulView<TabBarProps> {
	private props: TabBarProps;

	constructor(private readonly theme: Theme) {
		this.props = { tabs: [], submit: { active: false, allAnswered: false } };
	}

	setProps(props: TabBarProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const segments = this.props.tabs.map((tab) => {
			const raw = ` ${tab.answered ? "■" : "□"} ${tab.label} `;
			return tab.active
				? this.theme.bg("selectedBg", this.theme.fg("text", raw))
				: this.theme.fg(tab.answered ? "success" : "muted", raw);
		});
		const submit = " ✓ Submit ";
		segments.push(this.props.submit.active
			? this.theme.bg("selectedBg", this.theme.fg("text", submit))
			: this.theme.fg(this.props.submit.allAnswered ? "success" : "dim", submit));

		const full = ` ← ${segments.join(" ")} →`;
		if (visibleWidth(full) <= width) return [full, ""];

		// Keep the active question (or Submit) visible instead of truncating it off
		// the right edge. Retain exactly two rows for DialogView's height contract.
		const active = this.props.submit.active
			? this.props.tabs.length
			: Math.max(0, this.props.tabs.findIndex((tab) => tab.active));
		let left = active, right = active;
		const line = (from: number, to: number) =>
			` ← ${from > 0 ? "… " : ""}${segments.slice(from, to + 1).join(" ")}${to < segments.length - 1 ? " …" : ""} →`;
		for (;;) {
			let expanded = false;
			if (left > 0 && visibleWidth(line(left - 1, right)) <= width) {
				left--; expanded = true;
			}
			if (right < segments.length - 1 && visibleWidth(line(left, right + 1)) <= width) {
				right++; expanded = true;
			}
			if (!expanded) break;
		}
		const visible = line(left, right);
		if (visibleWidth(visible) <= width) return [visible, ""];
		// Extremely narrow terminals: spend the available columns on the active tab.
		return [truncateToWidth(segments[active] ?? "", Math.max(0, width), ""), ""];
	}
}
