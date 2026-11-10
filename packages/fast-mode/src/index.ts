import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installServiceTierPricing } from "./provider-pricing.ts";

const STATE_TYPE = "openai-fast-mode";
const OPENAI_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"openai-completions",
]);
const ACTIONS = [
	{ value: "on", label: "on", description: "开启 Fast（priority，费用或额度消耗更高）" },
	{ value: "off", label: "off", description: "关闭 Fast（default）" },
	{ value: "status", label: "status", description: "查看当前 Fast 状态" },
];

function isGPT(id: string): boolean {
	return /(?:^|\/)gpt-/i.test(id);
}

function supportsFast(model: ExtensionContext["model"]): boolean {
	return model !== undefined && OPENAI_APIS.has(model.api) && isGPT(model.id);
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	const wrappedProviders = new WeakSet<object>();
	const restorePricing: Array<() => void> = [];

	function installPricing(ctx: ExtensionContext) {
		if (!ctx.model || !supportsFast(ctx.model)) return;
		const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
		if (!provider || wrappedProviders.has(provider)) return;
		restorePricing.push(installServiceTierPricing(provider));
		wrappedProviders.add(provider);
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const active = enabled && supportsFast(ctx.model);
		const label = `fast:${enabled ? "on" : "off"}${enabled && !active ? "(GPT-only)" : ""}`;
		ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg(active ? "accent" : "dim", label));
	}

	function restoreState(ctx: ExtensionContext) {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				enabled = (entry.data as { enabled: boolean }).enabled;
			}
		}
		installPricing(ctx);
		updateStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("turn_start", (_event, ctx) => installPricing(ctx));
	pi.on("cache_warming_decision", (_event, ctx) => installPricing(ctx));
	pi.on("session_shutdown", () => {
		for (const restore of restorePricing.reverse()) restore();
	});
	pi.on("model_select", (_event, ctx) => {
		installPricing(ctx);
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!supportsFast(ctx.model)) return;
		const payload = event.payload as { model: string; [key: string]: unknown };
		if (!isGPT(payload.model)) return;

		// Set an explicit standard tier on off, including when models.json sets priority.
		return { ...payload, service_tier: enabled ? "priority" : "default" };
	});

	pi.registerCommand("fast", {
		description: "切换 GPT Fast 模式；/fast [on|off|status]",
		getArgumentCompletions(prefix) {
			const matches = ACTIONS.filter((action) => action.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "" && !ACTIONS.some((item) => item.value === action)) {
				if (ctx.hasUI) ctx.ui.notify("用法：/fast [on|off|status]", "warning");
				return;
			}

			if (action !== "status") {
				const next = action === "" ? !enabled : action === "on";
				if (next !== enabled) {
					pi.appendEntry(STATE_TYPE, { enabled: next });
					enabled = next;
				}
			}

			updateStatus(ctx);
			if (!ctx.hasUI) return;
			const state = enabled ? "已开启（priority，费用或额度消耗更高）" : "已关闭（default）";
			const scope = supportsFast(ctx.model)
				? "后续 GPT 请求生效，不改变思考等级。"
				: "当前模型不适用；切回 OpenAI 协议的 GPT 模型后生效。";
			ctx.ui.notify(`Fast ${state}。${scope}`, "info");
		},
	});
}
