// dsh-usage — browser half.
//
// 侧边栏底部用量卡片（注册进 `sidebar.footer.action` 槽位，独占一行，位于
// Cordis 面板按钮下方）。每 30 秒心跳一次：重算悬浮说明里的剩余时间并重新拉取
// 宿主路由 `/api/deepseek-usage`（见 lib/index.js），因此余额、档单价与峰谷指示灯
// 都随心跳更新，跨过峰谷切换点后最多滞后一次心跳；点击卡片任意位置可立即刷新；
// 还没拿到余额（宿主刚重启/接口刚起来）时按 QUICK_RETRY_MS 阶梯快速补几次请求，
// 卡片几秒内收敛。
// 两种形态：
//   · 侧边栏展开——完整卡片：余额（放大显示，符号随币种）或订阅制的 D 形仪表盘阵列
//     （5 小时 / 周 / 月并排，灰色弧是已用量、绿色弧是剩余量，剩余量在已用 ≥ 80%
//     时变红，周期徽章嵌在底部缺口里），加当前模型档单价（输入/输入缓存/输出，
//     图标 + 数字，位于卡片右下角）+ 计费区间指示灯（右上角，只有颜色；悬浮说明
//     给出距下次切换的剩余时间）。指示灯只在宿主给出计费区间时出现：DeepSeek 的
//     峰谷、其它 provider 的高峰/优惠时段；全天一价的模型只有单价行。
//   · 侧边栏折叠——36px 图标栏里只有计费区间指示灯（见下方 `if (!wide)` 分支）。
//
// 设计约束（用户只关心"我还能花多少、这会儿什么价"）：
//   · 插件的内部信息——取价路径、模型改名、放假日期来源——一律不出现在 UI 上
//     （历史上圆点的 title 里塞过这些，已删除）。
//   · 唯一的交互是「点击卡片刷新」；没有可切换的提示态。
//   · 只有余额类错误（未配置 Key / 余额接口或网络失败）才置空卡片说明原因。
//   · 档单价来自宿主的取价结果：宿主按 provider + 模型查 PRICE_TABLES（DeepSeek 只是
//     其中一条，见 lib/pricing.js）；表里没有的模型 known=false，单价行与指示灯整组
//     隐藏，卡片只留余额。
//   · 没有数据时不编数字：余额与单价显示「—」，而不是 0.00 / 0。
// 另外在设置面板注册一项「DeepSeek 用量」（`settings.section`）：provider 映射编辑器 +
// 其下方的 OAuth 令牌填写区，本来放在插件详情页/行配置页，现在统一收到设置页里。
// 样式仅使用 `--dsw-*` 主题变量（含兜底值），跟随明暗主题。
window.__ModuleLoader__.load({
	id: "dsh-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } = react;
		const h = react.createElement;

		// ---- constants -------------------------------------------------
		// 卡片心跳：每 30 秒重算一次倒计时并重新取一次数（余额 + 当前档单价）。
		// 峰谷切换也因此不需要额外的检测逻辑——每次心跳都重新取数，切换后最多 30 秒翻正。
		const POLL_MS = 30 * 1000;
		const USAGE_PATH = "/api/deepseek-usage";
		// 放假日期：宿主路由（见 lib/index.js），浏览器启动时读一次，覆盖内置镜像表；
		// 读不到就继续用内置表（两边都是同一份国务院办公厅日期表）。
		const HOLIDAYS_PATH = "/api/deepseek-usage/holidays";
		// 常态卡片高度：上下 padding 8+12 + 金额行 minHeight 28 + 边框 2 = 50。
		// 无头 Chromium 实测常态卡片 50px，异常态用同一个 minHeight 兜住，侧边栏不跳动。
		const CARD_MIN_HEIGHT = 50;
		// 卡片还没拿到余额时的快速重试节奏（宿主刚重启、接口刚起来、或本次请求失败）：
		// 让空卡片在几秒内收敛，而不必等满下一次心跳。
		const QUICK_RETRY_MS = [4000, 8000, 15000, 30000];
		// 宿主错误文案的长度上限：上游异常文本可能很长，卡片高度不应被它撑开。
		const ERROR_MAX_CHARS = 120;

		// ---- i18n（DSH locale 服务；zh 用中文词典，其它语言一律英文）----
		// 注意：卡片上的文字只在两处悬浮说明里——单价行（单位「每百万 token 价格」+ 三个
		// 档位 + 计费币种）与倒计时/指示灯（离贵/便宜的那档价还有多久）。指示灯本身没有
		// 可见文字、只有颜色；倒计时统一用英文单位（d/h/m）且不带前缀，中英界面完全一致
		// ——插件内部的取价路径等一概不进 UI。
		const NS = "dsh-usage";
		const ZH = {
			"price.input": "输入",
			"price.cache": "输入缓存",
			"price.output": "输出",
			"price.perMillion": "每百万 token 价格",
			"currency.CNY": "元",
			"currency.USD": "美元",
			"hint.peak": "距离峰价还剩",
			"hint.idle": "距离谷价还剩",
			"hint.switching": "即将切换价格",
			"status.peak": "高峰时段",
			"status.idle": "空闲时段",
			"status.error": "余额读取失败",
			"status.unavailable": "该提供商不支持查询",
			"status.mapAction": "去映射",
			"card.label": "账户用量，点击刷新",
			"sidebar.label": "账户用量",
			"error.refresh": "刷新失败，请稍后重试",
			"accounts.window.5h": "5 小时",
			"accounts.window.7d": "7 天",
			"accounts.window.7d-opus": "Opus 7 天",
			"accounts.window.30d": "30 天",
			"accounts.window.cycle": "当前周期",
			"settings.nav": "DeepSeek 用量",
			"settings.title": "DeepSeek 用量",
			"settings.intro": "在这里把第三方插件注册的 provider id 映射到本插件支持的提供商，并填写 Claude Code / OpenAI Codex 的订阅令牌。",
			"alias.title": "提供商映射",
			"alias.intro": "把第三方插件注册的 provider id 映射到本插件支持的提供商。映射只决定本插件用哪个账户口径查询，不改变 DSH 的模型路由。",
			"alias.empty": "还没有添加映射。只有能力表里的提供商可查。",
			"alias.provider": "provider id",
			"alias.providerPlaceholder": "例如 dsh-opencode-go",
			"alias.capability": "映射到",
			"alias.capabilityPlaceholder": "选择提供商",
			"alias.refs": "凭据引用（可选）",
			"alias.refsHint": "多个引用用逗号分隔。留空时先试该 provider 的派生引用，再试目标提供商的默认引用。",
			"alias.oauthHint": "保存映射后，下方会出现「订阅令牌」填写区；这里不需要凭据引用。",
			"alias.add": "添加映射",
			"alias.remove": "删除",
			"alias.save": "保存",
			"alias.saved": "已保存",
			"alias.saveFailed": "保存失败，已刷新，请重试",
			"alias.detected": "检测到但未识别",
			"alias.detectedHint": "这些路由没有内置的账户查询接口；选择要映射到的提供商后保存。",
			"alias.providerRequired": "provider id 不能为空",
			"alias.duplicate": "provider id 重复",
			"alias.builtin": "该 id 已被内置支持，映射不会生效",
			"alias.capabilityRequired": "请选择要映射到的提供商",
			"alias.loading": "读取配置中…",
			"alias.readonly": "当前配置只读。",
			"alias.unavailable": "当前宿主不提供配置表单。",
			"alias.yamlHint": "可以在 profile 的 cordis.patch.yml 里手动配置 providerAliases；格式见 README。",
			"token.title": "订阅令牌",
			"token.intro": "粘贴 Claude Code / Codex 的 OAuth 令牌后，侧边栏卡片即可显示订阅余量。令牌只保存在本机凭据里，不会离开这台机器。",
			"token.unavailable": "无法读取 OAuth 提供商列表。",
			"token.placeholder": "粘贴 OAuth 令牌",
			"token.accountPlaceholder": "账号 ID（可选，Codex 的 ChatGPT-Account-Id）",
			"token.save": "保存",
			"token.clear": "清除",
			"token.configured": "已填写",
			"token.missing": "未填写",
			"token.saved": "已保存",
			"token.cleared": "已清除",
			"token.failed": "保存失败",
			"token.source.claude": "在装有 Claude Code 的机器上运行 claude setup-token 之外的登录流程：从 ~/.claude/.credentials.json 的 claudeAiOauth.accessToken 复制（macOS 在钥匙串 Claude Code-credentials 里）。setup-token 产的令牌只能读 5 小时与 7 天两个窗口。",
			"token.source.codex": "从 ~/.codex/auth.json 的 tokens.access_token 复制，并把 tokens.account_id 填进账号 ID 一栏。",
			"badge.official": "Official",
			"badge.proxy": "Proxy",
			"badge.oauth": "OAuth",
			"badge.account": "Account",
			"badge.sharedPool": "共享额度",
			"badge.unknownPool": "额度归属未知",
			"badge.stale": "缓存过期",
			"status.unsupported": "不支持查询",
			"status.unknown": "未知",
			"status.unconfigured": "未配置",
			"status.failed": "查询失败",
			"status.unauthorized": "权限不足",
			"status.rateLimited": "请求限流",
			"display.title": "UI 展示与仪表盘设置",
			"display.intro": "控制侧边栏监控展示哪些模型、使用哪种表盘样式与预警阈值。修改此处仅影响监控 UI，绝不改变 DSH 实际模型路由。",
			"display.mode": "监控模式",
			"display.mode.auto": "自动模式（跟随当前 DSH 模型）",
			"display.mode.fixed": "固定模式（监控指定单模型）",
			"display.mode.multi": "多模型模式（同时展示多个模型）",
			"display.gaugeStyle": "默认表盘样式",
			"display.gauge.d-gauge": "原始 D 形表盘",
			"display.gauge.ring": "圆环表盘",
			"display.gauge.semicircle": "半圆表盘",
			"display.gauge.compact": "紧凑额度卡片",
			"display.gauge.detailed": "详细额度卡片",
			"display.percentMode": "百分比计算模式",
			"display.percent.remaining": "剩余百分比",
			"display.percent.used": "已使用百分比",
			"display.warnThreshold": "注意阈值 (%)",
			"display.alertThreshold": "预警阈值 (%)",
			"display.refreshInterval": "自动刷新周期",
			"display.groupByProvider": "按供应商分组展示",
			"display.showModelId": "显示模型 ID",
			"display.showProvider": "显示供应商与来源标记",
			"display.showAccountAlias": "显示账户来源",
			"display.save": "保存展示设置",
			"display.reset": "恢复默认",
			"proxy.title": "反向代理额度配置",
			"proxy.intro": "为自定义网关（OneAPI / NewAPI / LiteLLM 等）绑定额度查询适配器。兼容推理不代表兼容余额接口，未知反代将诚实显示不支持查询。",
			"proxy.add": "添加反代配置",
			"proxy.save": "保存反代配置",
			"routing.title": "DSH 路由模型管理",
			"routing.intro": "独立查看和配置 DSH 实际使用的路由模型、Base URL 与凭据引用，或测试目标模型连通性。",
			"routing.current": "当前实际路由",
			"routing.switch": "切换默认路由",
			"routing.test": "测试连通性",
			"routing.openNative": "打开 DSH 原生模型设置",
			"routing.export": "导出非敏感配置",
			"overview.title": "模型监控概览与额度分组",
			"overview.activeRoute": "当前路由模型",
			"overview.monitoredModel": "当前监控模型",
			"overview.monitoringTarget": "监控目标",
			"overview.provider": "当前 Provider",
			"overview.accountAlias": "账户别名",
			"overview.updatedAt": "更新时间",
			"overview.status": "查询状态",
			"overview.refresh": "刷新额度",
			"overview.windowUnavailable": "未返回 / 不支持",
			"overview.accountsTitle": "账户列表与状态",
			"overview.accountInUse": "当前使用",
			"overview.accountConnected": "已连接",
			"overview.accountSwitch": "切换账号",
			"sidebar.expand": "展开详情",
			"sidebar.collapse": "收起详情",
			"sidebar.refresh": "刷新",
			"sidebar.pool": "额度池",
			"sidebar.source": "数据来源",
			"sidebar.updatedAt": "上次刷新",
			"sidebar.diagnostics": "归属诊断",
			"settings.pageHeading": "AI 模型额度监控与设置",
			"settings.pageSubtitle": "实时监控当前模型与供应商额度窗口，支持多模型仪表盘与路由调度。",
			"settings.deepseekNotice": "DeepSeek 官方 API 余额按真实充值额度实时查询；若使用账号登录，凭据由 DSH 凭证服务统一管理。高峰时段（工作日 09:00–24:00）全价，空闲时段与法定节假日自动享受半价折扣。",
			"advanced.title": "高级设置",
			"advanced.intro": "第三方非标准 Provider 映射与 OAuth 订阅令牌管理（大多数官方模型与反代已自动精准识别，无需手动配置）。",
			"advanced.expand": "展开高级配置",
			"advanced.collapse": "收起高级配置",
		};
		const EN = {
			"price.input": "Input",
			"price.cache": "Input cache",
			"price.output": "Output",
			"price.perMillion": "Price per 1M tokens",
			"currency.CNY": "CNY",
			"currency.USD": "USD",
			"hint.peak": "Peak pricing in",
			"hint.idle": "Off-peak pricing in",
			"hint.switching": "Price change imminent",
			"status.peak": "Peak hours",
			"status.idle": "Off-peak hours",
			"status.error": "Balance unavailable",
			"status.unavailable": "This provider has no query API",
			"status.mapAction": "Set up mapping",
			"card.label": "Account usage, click to refresh",
			"sidebar.label": "Account usage",
			"error.refresh": "Refresh failed, please try again.",
			"accounts.window.5h": "5-hour",
			"accounts.window.7d": "7-day",
			"accounts.window.7d-opus": "Opus 7-day",
			"accounts.window.30d": "30-day",
			"accounts.window.cycle": "Current cycle",
			"settings.nav": "DeepSeek Usage",
			"settings.title": "DeepSeek Usage",
			"settings.intro": "Map provider ids registered by third-party plugins to the providers this plugin supports, and paste Claude Code / OpenAI Codex subscription tokens here.",
			"alias.title": "Provider mappings",
			"alias.intro": "Map a provider id registered by a third-party plugin to a provider this plugin supports. A mapping only decides which account is queried; it does not change DSH's model routing.",
			"alias.empty": "No mappings yet. Only the built-in providers are queryable.",
			"alias.provider": "Provider id",
			"alias.providerPlaceholder": "e.g. dsh-opencode-go",
			"alias.capability": "Maps to",
			"alias.capabilityPlaceholder": "Choose a provider",
			"alias.refs": "Credential refs (optional)",
			"alias.refsHint": "Separate refs with commas. When empty, the route's derived ref is tried first, then the target provider's default refs.",
			"alias.oauthHint": "Save the mapping and a token field appears in the Subscription token section below; no credential refs here.",
			"alias.add": "Add mapping",
			"alias.remove": "Remove",
			"alias.save": "Save",
			"alias.saved": "Saved",
			"alias.saveFailed": "Could not save; reloaded, please retry",
			"alias.detected": "Detected, unrecognized",
			"alias.detectedHint": "These routes have no built-in account API. Choose a provider to map them to, then save.",
			"alias.providerRequired": "Provider id is required",
			"alias.duplicate": "Duplicate provider id",
			"alias.builtin": "This id is already supported natively; the mapping would not apply",
			"alias.capabilityRequired": "Choose a provider to map to",
			"alias.loading": "Reading configuration…",
			"alias.readonly": "This configuration is read-only.",
			"alias.unavailable": "This host does not provide a configuration form.",
			"alias.yamlHint": "You can configure providerAliases by hand in the profile's cordis.patch.yml; see the README for the format.",
			"token.title": "Subscription token",
			"token.intro": "Paste a Claude Code or Codex OAuth token and the sidebar card starts reporting subscription quota. The token stays in this machine's credential store and never leaves it.",
			"token.unavailable": "The OAuth provider list could not be read.",
			"token.placeholder": "Paste the OAuth token",
			"token.accountPlaceholder": "Account ID (optional, Codex's ChatGPT-Account-Id)",
			"token.save": "Save",
			"token.clear": "Clear",
			"token.configured": "Saved",
			"token.missing": "Not saved",
			"token.saved": "Saved",
			"token.cleared": "Cleared",
			"token.failed": "Could not save",
			"token.source.claude": "On a machine signed in to Claude Code, copy claudeAiOauth.accessToken from ~/.claude/.credentials.json (on macOS: the Claude Code-credentials keychain item). A claude setup-token token reads the 5-hour and 7-day windows only.",
			"token.source.codex": "Copy tokens.access_token from ~/.codex/auth.json and put tokens.account_id in the account ID field.",
			"badge.official": "Official",
			"badge.proxy": "Proxy",
			"badge.oauth": "OAuth",
			"badge.account": "Account",
			"badge.sharedPool": "Shared Quota",
			"badge.unknownPool": "Pool Unknown",
			"badge.stale": "Stale Cache",
			"status.unsupported": "Unsupported",
			"status.unknown": "Unknown",
			"status.unconfigured": "Unconfigured",
			"status.failed": "Query Failed",
			"status.unauthorized": "Unauthorized",
			"status.rateLimited": "Rate Limited",
			"display.title": "UI Display & Gauge Settings",
			"display.intro": "Configure which models to monitor in the sidebar, gauge styles, and warning thresholds. Changes here only affect the monitoring UI and never alter DSH model routing.",
			"display.mode": "Monitor mode",
			"display.mode.auto": "Auto (follow current DSH model)",
			"display.mode.fixed": "Fixed (monitor one specific model)",
			"display.mode.multi": "Multi-model (monitor selected models)",
			"display.gaugeStyle": "Default gauge style",
			"display.gauge.d-gauge": "Original D-shaped gauge",
			"display.gauge.ring": "Ring gauge",
			"display.gauge.semicircle": "Semicircle gauge",
			"display.gauge.compact": "Compact quota card",
			"display.gauge.detailed": "Detailed quota card",
			"display.percentMode": "Percentage mode",
			"display.percent.remaining": "Remaining %",
			"display.percent.used": "Used %",
			"display.warnThreshold": "Warning threshold (%)",
			"display.alertThreshold": "Alert threshold (%)",
			"display.refreshInterval": "Auto refresh interval",
			"display.groupByProvider": "Group by provider",
			"display.showModelId": "Show model ID",
			"display.showProvider": "Show provider & source badge",
			"display.showAccountAlias": "Show account source",
			"display.save": "Save display settings",
			"display.reset": "Reset defaults",
			"proxy.title": "Reverse Proxy Quota Configuration",
			"proxy.intro": "Bind proxy routes (OneAPI / NewAPI / LiteLLM, etc.) to quota adapters. Supporting chat completions does not imply supporting billing APIs.",
			"proxy.add": "Add proxy route",
			"proxy.save": "Save proxy routes",
			"routing.title": "DSH Routing Model Management",
			"routing.intro": "Inspect and configure active DSH routing models, Base URLs, credential refs, and test target model connectivity.",
			"routing.current": "Current active route",
			"routing.switch": "Apply default route",
			"routing.test": "Test connectivity",
			"routing.openNative": "Open native DSH Models settings",
			"routing.export": "Export non-sensitive config",
			"overview.title": "Model Monitoring Overview & Quota Groups",
			"overview.activeRoute": "Active Route Model",
			"overview.monitoredModel": "Monitored Model",
			"overview.monitoringTarget": "Monitoring Target",
			"overview.provider": "Current Provider",
			"overview.accountAlias": "Account Alias",
			"overview.updatedAt": "Last Updated",
			"overview.status": "Query Status",
			"overview.refresh": "Refresh Quota",
			"overview.windowUnavailable": "Not returned / Unsupported",
			"overview.accountsTitle": "Accounts & Connection Status",
			"overview.accountInUse": "In Use",
			"overview.accountConnected": "Connected",
			"overview.accountSwitch": "Use Account",
			"sidebar.expand": "Expand details",
			"sidebar.collapse": "Collapse details",
			"sidebar.refresh": "Refresh",
			"sidebar.pool": "Quota Pool",
			"sidebar.source": "Data Source",
			"sidebar.updatedAt": "Last Updated",
			"sidebar.diagnostics": "Attribution Diagnostics",
			"settings.pageHeading": "AI Model Quota & Monitoring Settings",
			"settings.pageSubtitle": "Monitor real-time model quota windows and manage DSH routing.",
			"settings.deepseekNotice": "DeepSeek official balance queries live balance from upstream. Peak hours (weekdays 09:00-24:00) bill at normal rate; off-peak and statutory holidays enjoy 50% discount.",
			"advanced.title": "Advanced Settings",
			"advanced.intro": "Third-party custom provider mappings and OAuth subscription tokens (built-in providers and proxies are auto-detected).",
			"advanced.expand": "Expand Advanced Settings",
			"advanced.collapse": "Collapse Advanced Settings",
		};

		/**
		 * DSH 语言设置 → 本插件使用的语言：中文（zh、zh-CN、zh-Hans…）用中文，
		 * 其它任何语言一律英文。
		 */
		function uiLang(active) {
			return typeof active === "string" && active.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
		}

		/** 没有 DSH locale 服务时的兜底：按浏览器语言走同一规则，取不到就是英文。 */
		function browserLang() {
			try {
				return uiLang(String(navigator.language || ""));
			} catch (e) {
				return "en";
			}
		}

		/** 指定语言的词典文案（词典里没有就原样返回 key）。 */
		function textOf(key, lang) {
			return (lang === "zh" ? ZH : EN)[key] || key;
		}

		/** 当前语言：优先读 DSH locale 快照，读不到用浏览器语言。 */
		function currentLang(ctx) {
			try {
				const locale = ctx && ctx.locale;
				if (locale && typeof locale.getSnapshot === "function") {
					return uiLang(locale.getSnapshot().active);
				}
			} catch (e) { /* locale 服务不可用，走浏览器语言 */ }
			return browserLang();
		}

		// locale 服务缺失时的回退快照：必须是同一个对象，否则 useSyncExternalStore
		// 会把每次渲染都当成快照变化，触发无限重渲染。
		const FALLBACK_LOCALE_SNAPSHOT = { active: browserLang(), locales: [], revision: 0 };

		// ---- 峰谷规则（必须与 lib/pricing.js 里 DeepSeek 快照的 schedule
		// （peakWindows / peakDays / holidays）与 HOLIDAY_RANGES 保持一致；浏览器侧
		// 无法 import 宿主模块，只能镜像。2026 年起官方口径：法定节假日全天、调休上班
		// 的周末都是空闲时段，所以放假日期必须一起镜像，否则中秋/国庆白天会被误显示成
		// 高峰价）----
		const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		const PEAK_WEEKDAYS_ONLY = true;
		/** 可能的切换时刻（北京时间整点）：高峰窗口的起止整点，nextChange 逐日枚举它们。 */
		const BOUNDARY_HOURS = [...new Set(PEAK_WINDOWS.flat())].sort((a, b) => a - b);
		// 放假日期（含起止，闭区间）：国务院办公厅 2026 年节假日安排。
		const HOLIDAY_RANGES = [
			['2026-01-01', '2026-01-03'],
			['2026-02-15', '2026-02-23'],
			['2026-04-04', '2026-04-06'],
			['2026-05-01', '2026-05-05'],
			['2026-06-19', '2026-06-21'],
			['2026-09-25', '2026-09-27'],
			['2026-10-01', '2026-10-07'],
		];
		const DAY_MS = 24 * 60 * 60 * 1000;

		/** 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`）。 */
		function expandHolidayRanges(ranges) {
			const set = new Set();
			for (const [from, to] of ranges) {
				if (typeof from !== "string" || typeof to !== "string") continue;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
				const start = Date.parse(from + 'T00:00:00Z');
				const end = Date.parse(to + 'T00:00:00Z');
				if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
				// 解析结果必须与输入同一天，否则输入本身不是合法日期（已滚动到别的日子）。
				if (new Date(start).toISOString().slice(0, 10) !== from) continue;
				if (new Date(end).toISOString().slice(0, 10) !== to) continue;
				for (let t = start; t <= end; t += DAY_MS) set.add(new Date(t).toISOString().slice(0, 10));
			}
			return set;
		}

		/** 内置镜像表：宿主不可达时的兜底，也是 isPeak/nextChange 的缺省集合。 */
		const BUILTIN_HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

		/** 该时刻所在北京时间日历日是否为法定节假日（放假日期）。 */
		function isHoliday(ms, days) {
			return days.has(new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10));
		}

		/**
		 * 某时刻是否为高峰时段（按北京时间；节假日全天与周末恒为空闲）。与 lib/pricing.js 的 isPeak 等价。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 isPeak 同一口径。
		 */
		function isPeak(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			if (isHoliday(now, days)) return false;
			const d = new Date(now + SHANGHAI_OFFSET_MS);
			if (PEAK_WEEKDAYS_ONLY) {
				const dow = d.getUTCDay();
				if (dow === 0 || dow === 6) return false;
			}
			const h = d.getUTCHours();
			return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
		}

		/**
		 * 距下一个计费时段边界的剩余时间；与 lib/pricing.js 的 nextChange 等价。
		 * 候选时刻是 PEAK_WINDOWS 起止整点落在各天的那些点，逐日枚举取第一个让 isPeak
		 * 翻转的，因此返回精确时刻（上限 32 天，覆盖春节长假 → 假期后首个工作日早晨）。
		 * 找不到切换点时 at 为 null——调用方据此显示「—」，不要当成"此刻在切换"。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 nextChange 同一口径。
		 */
		function nextChange(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			const current = isPeak(now, days);
			const hourMs = 60 * 60 * 1000;
			const dayStart = Date.parse(new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) + 'T00:00:00Z') - SHANGHAI_OFFSET_MS;
			for (let day = 0; day < 32; day += 1) {
				const base = dayStart + day * DAY_MS;
				for (const hour of BOUNDARY_HOURS) {
					const at = base + hour * hourMs;
					if (at <= now) continue;
					const peak = isPeak(at, days);
					if (peak !== current) return { peak, at, ms: at - now };
				}
			}
			return { peak: !current, at: null, ms: 0 };
		}

		/**
		 * 剩余毫秒 → 给人读的完整时长：`2 天 15 小时` / `5 小时 47 分钟` / `21 分钟`，
		 * 英文为 `2 days 15 hours` / `21 minutes`。不足 1 分钟返回 null，由调用方换成
		 * 「即将切换」一类整句——不拼一个 `0 分钟` 出来。
		 */
		function fmtDuration(ms, lang) {
			const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60000));
			if (total === 0) return null;
			const days = Math.floor(total / 1440);
			const hours = Math.floor((total % 1440) / 60);
			const minutes = total % 60;
			if (lang === "en") {
				const unit = (v, word) => `${v} ${word}${v === 1 ? "" : "s"}`;
				if (days > 0) return `${unit(days, "day")} ${unit(hours, "hour")}`;
				if (hours > 0) return `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
				return unit(minutes, "minute");
			}
			if (days > 0) return `${days} 天 ${hours} 小时`;
			if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
			return `${minutes} 分钟`;
		}

		/**
		 * 金额 → 两位小数字符串。
		 * null / undefined / 空串都表示"没有拿到"，显示「—」：Number(null) 是 0，
		 * 直接转换会把"读不到余额"显示成"余额 0 元"。
		 */
		function money(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return n.toFixed(2);
		}

		/** 单价 → 去掉多余尾零的字符串；同样把"没有值"显示成「—」。 */
		function fmtPrice(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(parseFloat(n.toFixed(2)));
		}

		/** 币种 → 符号。未知币种显示代码本身（如 HKD 10.00），不假装成人民币。 */
		function currencySymbol(currency) {
			if (typeof currency !== "string" || currency === "") return "¥";
			const code = currency.trim().toUpperCase();
			if (code === "CNY" || code === "RMB") return "¥";
			if (code === "USD") return "$";
			if (code === "EUR") return "€";
			if (code === "JPY") return "¥";
			if (code === "GBP") return "£";
			return code + " ";
		}

		/**
		 * 账户读数 → 卡片金额行要显示的两截：符号 + 数值。
		 *
		 * 三种 kind：
		 *   · balance —— 币种符号 + 金额（`¥` / `$`，金额缺失时显示「—」）；
		 *   · usage / oauth —— 窗口标签 + 已用百分比。正常情况下卡片用
		 *     usageWindows() 给每个窗口画一个 D 形仪表盘，这里是窗口读不到数值时的
		 *     兜底（回退成最紧窗口或「—」）；
		 *   · 拿不到 —— 都是「—」，绝不显示 0.00 或 0%（那是"读到了 0"的意思）。
		 *
		 * @param kind     provider.kind
		 * @param account  { balance, usage }
		 * @param t        本地化函数（窗口标签需要它）
		 * @returns {{ symbol: string, value: string }}
		 */
		function accountLead(kind, account, t) {
			if (kind === "balance") {
				const balance = account && account.balance ? account.balance : null;
				return {
					symbol: currencySymbol(balance ? balance.currency : ""),
					value: money(balance ? balance.total : null),
				};
			}
			if (kind === "usage" || kind === "oauth") {
				const usage = account && account.usage ? account.usage : null;
				const windows = usage && Array.isArray(usage.windows) ? usage.windows : [];
				// 取已用百分比最高的窗口：它最先撞限，是用户最该看到的那个。
				let best = null;
				for (const w of windows) {
					if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
					if (best === null || w.percent > best.percent) best = w;
				}
				if (best === null) return { symbol: "", value: "—" };
				return {
					symbol: (t && t("accounts.window." + best.key)) || best.key,
					value: percentText(best.percent),
				};
			}
			return { symbol: "", value: "—" };
		}

		/**
		 * 百分比 → 整数字符串。null / 非数字是"没读到"，显示「—」而不是 0%
		 * （0% 是一个真实读数，含义完全相反）。
		 */
		function percentText(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(Math.round(n)) + "%";
		}

		// ---- 订阅用量窗口（一张卡片里同时显示多个档位）----
		/**
		 * 宿主的 usage.windows 已是归一后的 { key, percent, resetsAt }。这里只保留
		 * 数值有效的窗口，按固定顺序排列（5 小时 → 7 天 → Opus 7 天 → 30 天 →
		 * 当前周期），未知 key 殿后；百分比缺失的窗口不画——宁可不显示，也不画一条 0%。
		 */
		const WINDOW_ORDER = ["5h", "7d", "7d-opus", "30d", "cycle"];
		function usageWindows(account) {
			const usage = account && account.usage ? account.usage : null;
			const list = usage && Array.isArray(usage.windows) ? usage.windows : [];
			// 同 key 出现多次时保留已用百分比更高的那条（与宿主侧口径一致）。
			const byKey = new Map();
			for (const w of list) {
				if (!w || typeof w !== "object") continue;
				if (typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
				const key = typeof w.key === "string" && w.key !== "" ? w.key : "cycle";
				const seen = byKey.get(key);
				if (seen !== undefined && seen.percent >= w.percent) continue;
				byKey.set(key, {
					key,
					percent: w.percent,
					resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
				});
			}
			const rank = (key) => {
				const i = WINDOW_ORDER.indexOf(key);
				return i === -1 ? WINDOW_ORDER.length : i;
			};
			return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
		}

		/** 窗口 key → 本地化标签；词典里没有的通用时长（如 `1h` / `3d`）按语言拼。 */
		function windowLabel(t, key, lang) {
			const translated = t("accounts.window." + key);
			if (translated !== "accounts.window." + key) return translated;
			const hours = /^(\d+)h$/.exec(key);
			if (hours !== null) return lang === "en" ? hours[1] + "-hour" : hours[1] + " 小时";
			const days = /^(\d+)d$/.exec(key);
			if (days !== null) return lang === "en" ? days[1] + "-day" : days[1] + " 天";
			return key;
		}

		/**
		 * 周期徽章上的短标签（嵌在仪表盘底部缺口里，宽度有限）：统一用英文缩写，
		 * 短且与语言无关——`5H` / `7D` / `1M` / `OPUS` / `CYCLE`。
		 * 未知 key 按通用时长折算（1h → 1H、3d → 3D），仍不认得就原样大写。
		 */
		function windowBadge(key, lang = "en") {
			if (lang === "zh") {
				const labels = { "5h": "5时", "7d": "周额", "30d": "月额", "7d-opus": "Opus周额", cycle: "周期" };
				if (labels[key]) return labels[key];
			}
			const fixed = { '5h': '5H', '7d': '7D', '30d': '1M', '7d-opus': 'OPUS', cycle: 'CYCLE' };
			if (fixed[key] !== undefined) return fixed[key];
			const hours = /^(\d+)h$/.exec(key);
			if (hours !== null) return hours[1] + 'H';
			const days = /^(\d+)d$/.exec(key);
			if (days !== null) return days[1] + 'D';
			return String(key).toUpperCase();
		}

		/** 单个窗口的悬浮说明：已用百分比 + 距重置的剩余时间。 */
		function windowHint(w, t, lang) {
			const label = windowLabel(t, w.key, lang);
			const used = percentText(w.percent);
			const left = typeof w.resetsAt === "number" ? w.resetsAt - Date.now() : null;
			const span = left !== null && left > 0 ? fmtDuration(left, lang) : null;
			if (lang === "en") {
				return span !== null ? `${label}: ${used} used, resets in ${span}` : `${label}: ${used} used`;
			}
			if (span !== null) return `${label}：已用 ${used}，${span}后重置`;
			if (left !== null && left > 0) return `${label}：已用 ${used}，即将重置`;
			return `${label}：已用 ${used}`;
		}

		/** 用量比例（0–1，超出部分按满格画，不改写数字本身）。 */
		function usageRatio(percent) {
			return Math.max(0, Math.min(100, percent)) / 100;
		}

		/**
		 * 强调色的低饱和度版本：主题的 state 色直接上屏太亮眼（绿、黄尤甚），
		 * 统一按 55% 主题色 + 45% 中性灰混合——色相不变、饱和度约减半，
		 * 明暗两套主题都跟着变。指示灯与仪表盘弧共用这一组值，
		 * 同一语义只有一种颜色。
		 */
		const desaturate = (token) => `color-mix(in srgb, ${token} 55%, #808080)`;

		/**
		 * 剩余额度弧的颜色：已用不到 80% 是绿色；80% 及以上是红色，
		 * 提醒剩余额度已经不多。已用部分始终是灰色。
		 * 绿/红都取降低饱和度后的强调色——绿色与指示灯里的绿色是同一个值。
		 */
		function remainingColor(percent) {
			return percent >= 80 ? C.alert : C.idle;
		}

		/**
		 * 3 级阈值预警判定（P3）：
		 *   默认按已使用比例判断：
		 *     0% ~ (warnThreshold-1)%   -> 'normal'
		 *     warnThreshold% ~ (alert-1)% -> 'warn'
		 *     alertThreshold% ~ 100%    -> 'alert'
		 *   若 inputMode === 'remaining'，自动将剩余百分比换算为已使用百分比 (100 - value) 后判断。
		 */
		function thresholdLevel(valuePercent, options = {}) {
			if (typeof valuePercent !== "number" || !Number.isFinite(valuePercent)) return "unknown";
			const warn = Number.isFinite(Number(options.warnThreshold)) ? Number(options.warnThreshold) : 60;
			const alert = Number.isFinite(Number(options.alertThreshold)) ? Number(options.alertThreshold) : 80;
			const usedPct = options.inputMode === "remaining"
				? Math.max(0, Math.min(100, 100 - valuePercent))
				: Math.max(0, Math.min(100, valuePercent));
			if (usedPct >= alert) return "alert";
			if (usedPct >= warn) return "warn";
			return "normal";
		}

		/**
		 * 3 级阈值对应的主题颜色（复用原主题低饱和度变量，兼顾深浅色高对比度）。
		 */
		function thresholdColor(valuePercent, options = {}) {
			const level = thresholdLevel(valuePercent, options);
			if (level === "alert") return C.alert;
			if (level === "warn") return C.peak;
			if (level === "normal") return C.idle;
			return C.muted;
		}

		/**
		 * 表盘中心显示数值（支持 remaining 剩余百分比 / used 已使用百分比 两种计算模式）。
		 * 无上限或数值缺失时返回占位符 "—"，绝不编造 0 或 100。
		 */
		function formatCenterPercent(usedPercent, percentMode = "remaining") {
			if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return "—";
			const clamped = Math.max(0, Math.min(100, usedPercent));
			const value = percentMode === "used" ? clamped : 100 - clamped;
			return String(Math.round(value));
		}

		/**
		 * 多样式 SVG 表盘渲染器（P3）：
		 * 支持 5 种样式：
		 *   1. 'd-gauge'    开口朝下的 220° D 形表盘（默认，彩色弧线与周期标签）
		 *   2. 'ring'       360° 完整圆环表盘
		 *   3. 'semicircle' 180° 上半圆仪表盘
		 *   4. 'compact'    紧凑水平进度条卡片行
		 *   5. 'detailed'   详细周期额度行（含周期名、百分比、重置倒计时与进度条）
		 */
		function renderGaugeWindow(w, options = {}) {
			const {
				style = "d-gauge",
				percentMode = "remaining",
				warnThreshold = 60,
				alertThreshold = 80,
				threeTier = false,
				t = (k) => k,
				lang = "zh",
				large = true,
			} = options;
			if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) {
				return null;
			}
			const hint = windowHint(w, t, lang);
			const ratio = usageRatio(w.percent);
			// Blend continuously through the configured warning and alert anchors.
			const used = Math.max(0, Math.min(100, w.percent));
			const warnAt = Number.isFinite(warnThreshold) ? Math.max(1, Math.min(99, warnThreshold)) : 60;
			const alertAt = Number.isFinite(alertThreshold) ? Math.max(warnAt + 0.01, Math.min(100, alertThreshold)) : Math.max(warnAt + 0.01, 80);
			const green = "var(--dsw-alias-state-success-primary, #168a63)";
			const amber = "var(--dsw-alias-state-warn-primary, #b66b09)";
			const red = "var(--dsw-alias-state-error-primary, #d43a50)";
			const mix = (from, to, ratio) => "color-mix(in srgb, " + from + " " + ((1 - ratio) * 100).toFixed(3) + "%, " + to + ")";
			const activeColor = used >= alertAt ? red
				: used <= warnAt ? mix(green, amber, used / warnAt)
				: mix(amber, red, (used - warnAt) / (alertAt - warnAt));
			const centerVal = formatCenterPercent(w.percent, percentMode);
			const badge = windowBadge(w.key, lang);

			if (style === "compact") {
				const fillRatio = percentMode === "used" ? ratio : 1 - ratio;
				return h("div", {
					key: w.key,
					"data-gauge-style": "compact",
					title: hint,
					role: "img",
					"aria-label": hint,
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						width: "100%",
						minWidth: 0,
						fontSize: 12,
						lineHeight: "14px",
					},
				},
					h("span", {
						style: {
							flex: "none",
							minWidth: 28,
							padding: "0 4px",
							border: "1px solid color-mix(in srgb, " + activeColor + " 22%, transparent)",
							borderRadius: 99,
							fontSize: 10,
							fontWeight: 500,
							color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
							textAlign: "center",
						},
					}, badge),
					h("div", {
						style: {
							flex: "1 1 auto",
							height: 6,
							borderRadius: 99,
							background: C.track,
							overflow: "hidden",
						},
					},
						h("div", {
							style: {
								width: Math.round(fillRatio * 100) + "%",
								height: "100%",
								borderRadius: 99,
								background: activeColor,
								transition: "width 0.45s ease, background-color 0.45s ease",
							},
						})),
					h("span", {
						style: {
							flex: "none",
							minWidth: 28,
							textAlign: "right",
							fontWeight: 800,
						fontFamily: '"Segoe UI Variable", "SF Pro Rounded", "Segoe UI", system-ui, sans-serif',
						letterSpacing: "-0.035em",
							color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
							fontVariantNumeric: "tabular-nums",
						},
					}, centerVal + "%"));
			}

			if (style === "detailed") {
				const fillRatio = percentMode === "used" ? ratio : 1 - ratio;
				const leftMs = typeof w.resetsAt === "number" ? w.resetsAt - Date.now() : null;
				const resetSpan = leftMs !== null && leftMs > 0 ? fmtDuration(leftMs, lang) : null;
				return h("div", {
					key: w.key,
					"data-gauge-style": "detailed",
					title: hint,
					role: "img",
					"aria-label": hint,
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 3,
						width: "100%",
						minWidth: 0,
						padding: "4px 6px",
						borderRadius: 6,
						border: "0.5px solid " + C.track,
					},
				},
					h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, fontSize: 11 } },
						h("span", { style: { fontWeight: 500, color: C.label } }, windowLabel(t, w.key, lang)),
						h("span", { style: { fontWeight: 800,
						fontFamily: '"Segoe UI Variable", "SF Pro Rounded", "Segoe UI", system-ui, sans-serif',
						letterSpacing: "-0.035em", color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease", fontVariantNumeric: "tabular-nums" } },
							(percentMode === "used" ? (lang === "en" ? "Used " : "已用 ") : (lang === "en" ? "Left " : "剩余 ")) + centerVal + "%")),
					h("div", { style: { height: 5, borderRadius: 99, background: C.track, overflow: "hidden" } },
						h("div", { style: { width: Math.round(fillRatio * 100) + "%", height: "100%", background: activeColor, transition: "width 0.45s ease, background-color 0.45s ease" } })),
					resetSpan !== null
						? h("div", { style: { fontSize: 10, color: C.sub } }, (lang === "en" ? "Resets in " : "重置倒计时：") + resetSpan)
						: null);
			}

			if (style === "semicircle") {
				const W = 58;
				const H = 44;
				const STROKE = 5.5;
				const R = 23;
				const CIRC = 2 * Math.PI * R;
				const ARC = CIRC * 0.5; // 180° 半圆
				const usedLength = ARC * ratio;
				const restLength = ARC - usedLength;
				return h("div", {
					key: w.key,
					"data-gauge-style": "semicircle",
					style: { position: "relative", width: W, height: H, flex: "none" },
					title: hint,
					role: "img",
					"aria-label": hint,
				},
					h("svg", {
						width: W,
						height: H,
						viewBox: "0 0 " + W + " " + H,
						style: { display: "block" },
						"aria-hidden": "true",
					},
						h("circle", {
							cx: W / 2,
							cy: 28,
							r: R,
							fill: "none",
							style: { stroke: activeColor, transition: "stroke 0.45s ease, stroke-dasharray 0.45s ease", filter: "drop-shadow(0 1px 2px color-mix(in srgb, " + activeColor + " 30%, transparent))" },
							strokeWidth: STROKE,
							strokeLinecap: ratio < 1 ? "round" : "butt",
							strokeDasharray: restLength + " " + CIRC,
							transform: "rotate(" + (180 + 180 * ratio) + " " + (W / 2) + " 28)",
						}),
						h("circle", {
							cx: W / 2,
							cy: 28,
							r: R,
							fill: "none",
							stroke: "color-mix(in srgb, currentColor 13%, transparent)",
							strokeWidth: STROKE,
							strokeLinecap: ratio > 0 ? "round" : "butt",
							strokeDasharray: usedLength + " " + CIRC,
							transform: "rotate(180 " + (W / 2) + " 28)",
						})),
					h("span", {
						style: {
							position: "absolute",
							left: 0,
							right: 0,
							top: 8,
							textAlign: "center",
							fontSize: 22,
							lineHeight: "22px",
							fontWeight: 800,
						fontFamily: '"Segoe UI Variable", "SF Pro Rounded", "Segoe UI", system-ui, sans-serif',
						letterSpacing: "-0.035em",
							color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
							fontVariantNumeric: "tabular-nums",
						},
					}, centerVal),
					h("span", {
						style: {
							position: "absolute",
							left: "50%",
							bottom: 0,
							transform: "translateX(-50%)",
							padding: "1px 5px",
							border: "1px solid color-mix(in srgb, " + activeColor + " 22%, transparent)",
							borderRadius: 99,
							background: "color-mix(in srgb, " + activeColor + " 9%, " + C.bg + ")",
							fontSize: 12,
							lineHeight: "13px",
							fontWeight: 500,
							color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
							whiteSpace: "nowrap",
						},
					}, badge));
			}

			if (style === "ring") {
				const GAUGE = 54;
				const STROKE = 5.5;
				const R = (GAUGE - STROKE) / 2;
				const CIRC = 2 * Math.PI * R;
				const usedLength = CIRC * ratio;
				const restLength = CIRC - usedLength;
				return h("div", {
					key: w.key,
					"data-gauge-style": "ring",
					style: { position: "relative", width: GAUGE, height: GAUGE, flex: "none" },
					title: hint,
					role: "img",
					"aria-label": hint,
				},
					h("svg", {
						width: GAUGE,
						height: GAUGE,
						viewBox: "0 0 " + GAUGE + " " + GAUGE,
						style: { display: "block" },
						"aria-hidden": "true",
					},
						h("circle", {
							cx: GAUGE / 2,
							cy: GAUGE / 2,
							r: R,
							fill: "none",
							style: { stroke: activeColor, transition: "stroke 0.45s ease, stroke-dasharray 0.45s ease", filter: "drop-shadow(0 1px 2px color-mix(in srgb, " + activeColor + " 30%, transparent))" },
							strokeWidth: STROKE,
							strokeLinecap: ratio < 1 ? "round" : "butt",
							strokeDasharray: restLength + " " + CIRC,
							transform: "rotate(" + (-90 + 360 * ratio) + " " + (GAUGE / 2) + " " + (GAUGE / 2) + ")",
						}),
						h("circle", {
							cx: GAUGE / 2,
							cy: GAUGE / 2,
							r: R,
							fill: "none",
							stroke: "color-mix(in srgb, currentColor 13%, transparent)",
							strokeWidth: STROKE,
							strokeLinecap: ratio > 0 ? "round" : "butt",
							strokeDasharray: usedLength + " " + CIRC,
							transform: "rotate(-90 " + (GAUGE / 2) + " " + (GAUGE / 2) + ")",
						})),
					h("span", {
						style: {
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							paddingBottom: 8,
							fontSize: 22,
							lineHeight: "22px",
							fontWeight: 800,
						fontFamily: '"Segoe UI Variable", "SF Pro Rounded", "Segoe UI", system-ui, sans-serif',
						letterSpacing: "-0.035em",
							color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
							fontVariantNumeric: "tabular-nums",
						},
					}, centerVal),
					h("span", {
						style: {
							position: "absolute",
							left: "50%",
							bottom: 1,
							transform: "translateX(-50%)",
							padding: "1px 5px",
							border: "1px solid color-mix(in srgb, " + activeColor + " 22%, transparent)",
							borderRadius: 99,
							background: "color-mix(in srgb, " + activeColor + " 9%, " + C.bg + ")",
							fontSize: 12,
							lineHeight: "14px",
							fontWeight: 500,
							color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
							whiteSpace: "nowrap",
						},
					}, badge));
			}

			// 默认：原始 D 形表盘 ('d-gauge')，v1.0 增加 20% 放大尺寸与字体
			const GAUGE = large ? 54 : 45;
			const GAUGE_STROKE = large ? 5.5 : 4;
			const GAUGE_RADIUS = (GAUGE - GAUGE_STROKE) / 2;
			const GAUGE_CIRC = 2 * Math.PI * GAUGE_RADIUS;
			const GAUGE_SWEEP = 220 / 360;
			const GAUGE_ARC = GAUGE_CIRC * GAUGE_SWEEP;
			const GAUGE_START = 160;
			const usedLength = GAUGE_ARC * ratio;
			const restLength = GAUGE_ARC - usedLength;
			return h("div", {
				key: w.key,
				style: { position: "relative", width: GAUGE, height: GAUGE, flex: "none" },
				title: hint,
				role: "img",
				"aria-label": hint,
			},
				h("svg", {
					width: GAUGE,
					height: GAUGE,
					viewBox: "0 0 " + GAUGE + " " + GAUGE,
					style: { display: "block" },
					"aria-hidden": "true",
				},
					h("circle", {
						cx: GAUGE / 2,
						cy: GAUGE / 2,
						r: GAUGE_RADIUS,
						fill: "none",
						style: { stroke: activeColor, transition: "stroke 0.45s ease, stroke-dasharray 0.45s ease", filter: "drop-shadow(0 1px 2px color-mix(in srgb, " + activeColor + " 30%, transparent))" },
						strokeWidth: GAUGE_STROKE,
						strokeLinecap: ratio < 1 ? "round" : "butt",
						strokeDasharray: restLength + " " + GAUGE_CIRC,
						transform: "rotate(" + (GAUGE_START + 220 * ratio) + " " + GAUGE / 2 + " " + GAUGE / 2 + ")",
					}),
					h("circle", {
						cx: GAUGE / 2,
						cy: GAUGE / 2,
						r: GAUGE_RADIUS,
						fill: "none",
						stroke: "color-mix(in srgb, currentColor 13%, transparent)",
						strokeWidth: GAUGE_STROKE,
						strokeLinecap: ratio > 0 ? "round" : "butt",
						strokeDasharray: usedLength + " " + GAUGE_CIRC,
						transform: "rotate(" + GAUGE_START + " " + GAUGE / 2 + " " + GAUGE / 2 + ")",
					})),
				h("span", {
					style: {
						position: "absolute",
						inset: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						paddingBottom: large ? 11 : 10,
						fontSize: large ? 22 : 15,
						lineHeight: large ? "22px" : "15px",
						fontWeight: 800,
						fontFamily: '"Segoe UI Variable", "SF Pro Rounded", "Segoe UI", system-ui, sans-serif',
						letterSpacing: "-0.035em",
						color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
						fontVariantNumeric: "tabular-nums",
					},
				}, centerVal),
				h("span", {
					style: {
						position: "absolute",
						left: "50%",
						bottom: large ? 2 : 5,
						transform: "translateX(-50%)",
						boxSizing: "border-box",
						maxWidth: "100%",
						padding: large ? "1px 5px" : "0 4px",
						border: "1px solid color-mix(in srgb, " + activeColor + " 22%, transparent)",
						borderRadius: 99,
						background: "color-mix(in srgb, " + activeColor + " 9%, " + C.bg + ")",
						fontSize: large ? 12 : 10,
						lineHeight: large ? "14px" : "12px",
						fontWeight: 500,
						color: activeColor,
						transition: "color 0.45s ease, background-color 0.45s ease, border-color 0.45s ease",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					},
				}, badge));
		}

		// 主题变量（带兜底值）
		const C = {
			bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
			// 卡片边框与侧边栏顶部「新会话」按钮同一套：0.5px、border-l3。
			cardBorder: "var(--dsw-alias-border-l3, rgba(127,127,127,.3))",
			track: "var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
			label: "var(--dsw-alias-label-primary, #111)",
			sub: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
			// 错误文案保留主题错误色：它要表达"出问题了"，不做减饱和。
			err: "var(--dsw-alias-state-error-primary, rgb(200,40,40))",
			peak: desaturate("var(--dsw-alias-state-warn-primary, rgb(230,120,0))"),
			idle: desaturate("var(--dsw-alias-state-success-primary, rgb(34,160,80))"),
			// 剩余额度不足（已用 ≥80%）的弧色；错误文案仍用 err。
			alert: desaturate("var(--dsw-alias-state-error-primary, rgb(200,40,40))"),
			muted: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.35))",
		};

		const svgBase = {
			width: 12,
			height: 12,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2.2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			style: { flex: "none", display: "block" },
		};
		// 输入：右箭头指向右边界（→|，数据进入边界）
		const IconIn = () => h("svg", svgBase,
			h("path", { d: "M20 4v16" }),
			h("path", { d: "M20 12H6" }),
			h("path", { d: "M10 7l5 5-5 5" }));
		// 输出：左边界发出右箭头（|→，数据从边界流出）
		const IconOut = () => h("svg", svgBase,
			h("path", { d: "M4 4v16" }),
			h("path", { d: "M4 12h14" }),
			h("path", { d: "M14 7l5 5-5 5" }));
		// 缓存：闪电（缓存命中，快）
		const IconCache = () => h("svg", svgBase,
			h("path", { d: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" }));

		// ---- the widget -------------------------------------------------
		function UsageCell(props) {
			const ctx = props.ctx;
			const wide = !!props.wide;
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			const [expanded, setExpanded] = useState(false);
			// 倒计时走字用的心跳：每 30 秒 bump 一次，渲染时按当前时刻重算剩余时间。
			const [tick, setTick] = useState(0);
			const [holidayRanges, setHolidayRanges] = useState(() => HOLIDAY_RANGES);
			// 放假日期表：组件实例自己的集合（不做成模块级可变对象——同一页面挂两个实例
			// 时会互相覆盖，峰谷判定会无声翻转）。
			const holidayDays = useMemo(() => expandHolidayRanges(holidayRanges), [holidayRanges]);
			const mounted = useRef(true);
			// 请求序号：只有最后一次请求的结果可以写进 state。心跳、点击、设置事件
			// 会并发触发 load()，慢的旧响应回来得更晚，会把新数据盖掉。
			const requestSeq = useRef(0);
			// 快速重试：阶梯下标 + 定时器（宿主刚起来、余额接口还没返回时，几秒后自己再看一眼）。
			const retryStep = useRef(0);
			const retryTimer = useRef(null);
			// 页面可见性：后台标签页不做心跳（宿主每次都会真打一次官方余额接口）。
			const visible = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");
			const locale = ctx && ctx.locale;

			// 订阅语言变化（DSH locale 服务；不可用时按浏览器语言兜底）。
			const lcSnap = react.useSyncExternalStore(
				(cb) => (locale && typeof locale.subscribe === "function" ? locale.subscribe(cb) : () => {}),
				() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : FALLBACK_LOCALE_SNAPSHOT),
			);
			// 中文（zh / zh-*）用中文词典，其它语言一律英文。
			const lang = uiLang(lcSnap && lcSnap.active);
			// locale.bind(ns) 返回绑定命名空间的翻译函数；不可用时按语言取本地词典。
			const boundT = locale && typeof locale.bind === "function" ? locale.bind(NS) : null;
			const t = (key) => {
				try {
					if (boundT) {
						const v = boundT(key);
						if (typeof v === "string" && v !== key) return v;
					}
				} catch (e) { /* 词典不可用，回退本地词典 */ }
				return textOf(key, lang);
			};
			// 词典也放进 ref：load 的依赖保持稳定（不随语言重建心跳），
			// 但兜底文案仍能取到当前语言。
			const tRef = useRef(t);
			tRef.current = t;

			// 宿主还在后台忙（重启后首次余额、接口刚起来）时按 QUICK_RETRY_MS 阶梯补几次请求，
			// 让卡片几秒内收敛，不必等下一次心跳（POLL_MS）。失败同样按此节奏重试。
			// 判断依据只看"有没有拿到余额"，不依赖宿主内部字段。
			const cancelRetry = useCallback(() => {
				if (retryTimer.current !== null) {
					clearTimeout(retryTimer.current);
					retryTimer.current = null;
				}
			}, []);

			// 语言放进 ref：load 的身份不随语言变化，切中英文时不会重建心跳定时器、
			// 也不会让旧语言的在途请求回填到新语言的界面上。
			const langRef = useRef(lang);
			langRef.current = lang;

			// loadRef 让下面两个回调可以互相引用而不必谁先声明。
			const loadRef = useRef(null);

			/** 按 QUICK_RETRY_MS 阶梯安排一次补请求（用 ref 记录进度；卸载时清理）。 */
			const scheduleRetry = useCallback(() => {
				if (!mounted.current) return;
				const delay = QUICK_RETRY_MS[retryStep.current];
				if (delay === undefined) return;
				retryStep.current += 1;
				cancelRetry();
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					const run = loadRef.current;
					if (run) run();
				}, delay);
			}, [cancelRetry]);

			const load = useCallback(async (force = false) => {
				const seq = ++requestSeq.current;
				try {
					const suffix = force ? "&force=1" : "";
					const res = await fetch(USAGE_PATH + "?lang=" + langRef.current + suffix, { cache: "no-store" });
					let body = null;
					try {
						body = await res.json();
					} catch (e) {
						body = null;
					}
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						// 失败原因优先用宿主给的文案（未配置 Key / 余额接口异常，用户看得懂）；
						// 拿不到就用一句人话兜底——不把 HTTP 状态码这类传输细节摆到卡片上。
						throw new Error(body && typeof body.message === "string" && body.message !== "" ? body.message : tRef.current("error.refresh"));
					}
					// 过期响应直接丢弃：晚到的旧结果不能盖掉新数据，也不能把刚填好的
					// 余额整个抹成错误态。
					if (!mounted.current || seq !== requestSeq.current) return;
					setData(body);
					setError("");
					// 成功即取消待发的补请求并复位阶梯，否则上一次失败排下的定时器会
					// 在几秒后再打一发，可能把这份好数据换成错误态。
					cancelRetry();
					retryStep.current = 0;
				} catch (e) {
					if (!mounted.current || seq !== requestSeq.current) return;
					const message = e instanceof Error ? e.message : String(e);
					setError(message.length > ERROR_MAX_CHARS ? message.slice(0, ERROR_MAX_CHARS) + "…" : message);
					scheduleRetry();
				}
			}, [cancelRetry, scheduleRetry]);

			loadRef.current = load;

			// 语言切换后立刻按新语言重取一次：宿主返回的文案（余额/账户错误）要跟着
			// 换语言，不必等下一次心跳。用 ref 记录上一帧语言，挂载时不重复请求
			// （挂载 effect 已经 load 过），也不重建 30s 心跳定时器。
			const prevLangRef = useRef(lang);
			useEffect(() => {
				if (prevLangRef.current === lang) return;
				prevLangRef.current = lang;
				load();
			}, [lang, load]);

			useEffect(() => {
				mounted.current = true;
				load();
				// 模型切换（写入 settings 触发 document-updated）时立即刷新，单价跟着变。
				let off = null;
				try {
					if (ctx && ctx.remote && typeof ctx.remote.$on === "function") {
						off = ctx.remote.$on("settings/document-updated", () => {
							load().catch(() => {});
						});
					}
				} catch (e) {
					off = null;
				}
				return () => {
					mounted.current = false;
					cancelRetry();
					try {
						if (typeof off === "function") off();
					} catch (e) { /* 忽略退订错误 */ }
				};
			}, [load, ctx, cancelRetry]);

			// ---- 放假日期表（宿主是唯一权威：启动时拉一次，只用于本地兜底计算）----
			// 浏览器侧必须镜像峰谷规则（无法 import 宿主模块），放假日期也就不该各写一份，
			// 否则放假那几天两边会算出不同结果。这里用组件自己的 holidayDays 集合，
			// 宿主返回的表覆盖内置镜像。
			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch(HOLIDAYS_PATH, { cache: "no-store" });
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (cancelled || !res.ok || !body || body.ok !== true) return;
						if (Array.isArray(body.ranges) && body.ranges.length > 0) setHolidayRanges(body.ranges);
					} catch (e) { /* 读不到就用内置表继续 */ }
				})();
				return () => { cancelled = true; };
			}, []);

			// 页面可见性：隐藏时停心跳，回到前台补一次。
			useEffect(() => {
				if (typeof document === "undefined") return;
				const onChange = () => {
					visible.current = document.visibilityState !== "hidden";
					if (visible.current) load().catch(() => {});
				};
				document.addEventListener("visibilitychange", onChange);
				return () => document.removeEventListener("visibilitychange", onChange);
			}, [load]);

			// 设置页保存映射后立即重取一次，不等到下一次心跳（否则看起来像没生效）。
			useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onConfig = () => { load().catch(() => {}); };
				window.addEventListener("dsh-usage:config-updated", onConfig);
				return () => window.removeEventListener("dsh-usage:config-updated", onConfig);
			}, [load]);

			// 心跳：每 POLL_MS 重算一次倒计时（setTick 触发重渲染）并重新取一次数。
			// 取数会带回最新的余额、峰谷状态与档单价，所以跨过峰谷切换点后单价与指示灯
			// 最多滞后一次心跳——不需要单独检测切换时刻。页面隐藏时不发请求。
			useEffect(() => {
				const timer = setInterval(() => {
					setTick((v) => v + 1);
					if (!visible.current) return;
					load().catch(() => {});
				}, POLL_MS);
				return () => clearInterval(timer);
			}, [load]);

			const tier = data && data.tier ? data.tier : null;
			// 当前 provider 的查询能力：balance 显示金额，usage/oauth 显示订阅窗口，
			// none 表示这个 provider 没有可查的接口（卡片置空说明原因）。
			const kind = data && data.provider && typeof data.provider.kind === "string" ? data.provider.kind : "balance";
			const lead = accountLead(kind, data, t);
			const symbol = lead.symbol;
			const amount = lead.value;
			// 订阅用量：把宿主返回的每个窗口都画出来（D 形仪表盘 + 周期徽章 + 百分比），
			// 同一张卡片里并列显示 5 小时 / 周 / 月等多个档位，而不是只显示最紧的
			// 那一个。窗口读不到数值时回退成下面的 accountLead 兜底行。
			const usageRows = kind === "usage" || kind === "oauth" ? usageWindows(data) : [];
			// 档单价：宿主已按 provider + 模型查过价格表，known=false 表示"这个模型的价格
			// 插件不知道"，单价行不渲染。数据还没到（tier 为 null）时同样不显示——宁可
			// 少显示，也不要显示 0。
			const priced = !!tier && tier.known !== false;
			// provider 身份：本地兜底算倒计时、以及旧宿主响应的兼容判断都要用。
			// provider 字段缺失是老宿主的响应，按 DeepSeek 处理。
			const providerId = data && data.provider && typeof data.provider.id === "string"
				? data.provider.id.trim().toLowerCase()
				: "";
			const officialProvider = providerId === "" || ["deepseek-official", "deepseek-account", "deepseek"].includes(providerId);
			// 分时段计费：DeepSeek 的峰谷、其它 provider 的高峰/优惠时段都折算成
			// tier.window（'peak' 贵的一侧 / 'idle' 便宜的一侧）；null 表示全天一价，
			// 卡片只画单价行，不画指示灯与倒计时。订阅制路由上的 DeepSeek 模型也会
			// 由宿主填入时段（单价仍然 known=false），所以这张卡片也能显示峰谷灯。
			//
			// tier.window 是新宿主才有的字段：**旧宿主**（宿主进程没重启、只刷新了页面）
			// 的响应里没有它。那种情况退回旧口径——DeepSeek 官方模型照旧带峰谷指示灯，
			// 否则"刷新页面后指示灯凭空消失"。
			const hasWindows = !!tier && (tier.window === undefined ? priced && officialProvider : !!tier.window);
			// 卡片只显示"用户要的数字"：账户读数、当前档单价、状态圆点（悬浮给出
			// 距下次切换的剩余时间）。插件的内部信息（取价路径、模型改名）一律不进 UI，
			// 唯一的交互是点击卡片刷新。只有"账户类错误"（未配置密钥 / 接口或网络失败 /
			// 该 provider 没有可查接口）才把卡片置空并说明原因——否则读数是空的，
			// 用户无从判断。
			const errs = (Array.isArray(data && data.errors) ? data.errors : []).concat(error ? [error] : []);
			const blanked = errs.length > 0;
			// 每次渲染都以"当前时刻"求剩余时间；tick 每 30 秒 bump 一次触发这次重算。
			const nowMs = Date.now();
			const nextAt = (() => {
				const raw = data && data.next ? Number(data.next.at) : NaN;
				// 宿主给的切换时刻必须还在将来：旧响应或时钟漂移会让它落在过去，
				// 那样悬浮说明里的时长会卡在 switching。
				if (Number.isFinite(raw) && raw > nowMs) return raw;
				// 只有"有计费区间 + DeepSeek 官方口径"才在本地重算；其它 provider 的
				// 时段表只在宿主里，本地没有镜像，不做猜测。
				if (!hasWindows || !officialProvider) return null;
				const age = data && Number(data.updatedAt) > 0 ? Math.max(0, nowMs - Number(data.updatedAt)) : 0;
				const local = nextChange(nowMs - age, holidayDays);
				return local.at !== null && local.at > nowMs ? local.at : null;
			})();
			void tick; // tick 只用来触发重渲染，值本身不参与计算
			// 计费区间切换的悬浮说明：指示灯本身只有颜色，指针悬停时用一句完整的话
			// 讲清"离贵/便宜的那档价还有多久"。拿不到切换时刻时退化成当前区间名，
			// 不足 1 分钟时说"即将切换"，都不拼数字。
			const statusText = data && data.peak ? t("status.peak") : t("status.idle");
			const switchHint = (() => {
				if (!hasWindows) return statusText;
				if (nextAt === null) return statusText;
				const span = fmtDuration(nextAt - nowMs, lang);
				if (span === null) return t("hint.switching");
				return `${t(data && data.peak ? "hint.idle" : "hint.peak")} ${span}`;
			})();
			// 圆点本身用 SVG 画圆，不用 CSS 圆角：8px 盒子的 border-radius 在宿主
			// 渲染层会被画成"圆角方"（实测半径只有设定值的七八成），而同样尺寸的
			// SVG 圆是标准圆。颜色写进 style（color-mix() 在 presentation attribute
			// 上不如 CSS 属性可靠，仪表盘弧同理）。
			const dotColor = data ? (data.peak ? C.peak : C.idle) : C.muted;
			const dotCircle = (color) => h("svg", {
				width: 8,
				height: 8,
				viewBox: "0 0 8 8",
				style: { display: "block" },
				"aria-hidden": "true",
			}, h("circle", { cx: 4, cy: 4, r: 4, style: { fill: color } }));
			// 圆点只是 8×8 的定位盒子，自身不画任何东西（没有底色，也没有阴影）。
			const dot = {
				width: 8,
				height: 8,
				flex: "none",
			};
			// 区间指示灯：余额卡片放在金额行右侧；订阅卡片叠在右上角（仪表盘占满一行）。
			// 倒计时只放在悬浮说明里，不再占卡片的一行宽度。
			const scheduleDot = (style) => hasWindows && h("span", {
				style: { ...dot, ...style },
				title: switchHint,
				role: "img",
				"aria-label": statusText,
			}, dotCircle(dotColor));
			// 圆点自身不带说明（历史上 title 里塞过价格表路径等内部信息，已删除）；
			// 它只表达"现在是高峰还是空闲"，说明文字挂在外层那一组上（见 switchHint）。
			// 当存在 V2 models 列表且已正常加载（!blanked && error === ""）时，点击卡片切换展开/收起状态（B3/B4：展开收起本身不触发额外网络请求）；
			// 当尚未加载或处于错误态/旧版响应时，点击卡片直接触发刷新。
			const hasV2Models = Boolean(data && Array.isArray(data.models) && data.models.length > 0 && !blanked && error === "");
			const onCardClick = () => {
				if (hasV2Models) {
					setExpanded((v) => !v);
					return;
				}
				load().catch(() => {});
			};
			const onManualRefresh = (e) => {
				if (e && typeof e.stopPropagation === "function") e.stopPropagation();
				retryStep.current = 0;
				cancelRetry();
				load(true).catch(() => {});
			};

			// 订阅用量形态下 symbol 是窗口标签（如「5 小时」），字号随正文，
			// 不再用 24px 的货币符号尺寸——标签比符号长，放大后会挤掉百分比。
			const usageLead = kind === "usage" || kind === "oauth";
			const leadStyle = usageLead
				? { fontWeight: 600, fontSize: 12, color: C.sub, lineHeight: "28px", marginRight: 1, flex: "none", whiteSpace: "nowrap" }
				: { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", marginRight: 3, flex: "none" };
			const amountStyle = { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

			// 折叠态（图标栏）：内容宽 36px（侧边栏 56px − 折叠态左右各 10px 内边距），
			// 只容得下峰谷指示灯，没有外框也没有底色（直接坐在侧边栏背景上）。
			// 指示灯仍是"点击刷新"的落点。
			// 渲染条件：这个 provider 有可查的账户接口（kind 不是 none），或已经报了真错误。
			// 二者都不成立时这个栏里没有任何有意义的内容，整块不渲染。
			// 账户读不到时圆点用错误色——绿灯会被读成"一切正常"；但 `kind === 'none'`
			// 不是错误（插件本就不查它），那种情况用中性灰点。
			if (!wide) {
				if (kind === "none" && !blanked) return null;
				const failed = blanked && kind !== "none";
				const neutral = kind === "none";
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "none",
						padding: "4px 8px",
						cursor: "pointer",
						display: "flex",
						flexDirection: "row",
						alignItems: "center",
						userSelect: "none",
					},
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					// 折叠态只有指示灯：说明挂在整块上，指到图标就出"离峰/谷价还有多久"。
					title: failed ? t("status.error") : (neutral ? t("status.unavailable") : switchHint),
					onClick: () => load().catch(() => {}),
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							load().catch(() => {});
						}
					},
				}, h("span", {
					style: dot,
					role: "img",
					"aria-label": failed
						? t("status.error")
						: (neutral
							? t("status.unavailable")
							: statusText),
				}, dotCircle(failed ? C.err : (neutral ? C.muted : dotColor))));
			}

			// 只有"账户类错误"（未配置密钥 / 接口或网络失败 / 该 provider 没有可查
			// 接口）才走到这里：卡片置空、只显示原因文字，不画读数/单价/圆点/倒计时。
			// minHeight 兜住常态卡片高度（CARD_MIN_HEIGHT），侧边栏不跳动；
			// 文字多行时卡片自然变高。
			// 注意：这里不显示任何插件内部信息（取价路径、放假日期来源），历史上那批
			// 良性提示已随"去技术化"一起删除。
			// 折叠态（!wide）早在上面就返回了：它只有峰谷指示灯，没有文字空间。
			if (blanked) {
				// 配色分流：`kind === 'none'` 不是错误——本插件就没打算查这个提供商，
				// 用户的账户没有任何问题。把它标红会让人以为出故障了，所以用常规
				// 次要文字色陈述事实；只有真去查过并失败（网络/认证/形状不认）才用红色。
				const unsupported = kind === "none";
				const reasonStyle = {
					color: unsupported ? C.sub : C.err,
					fontSize: 12,
					lineHeight: "16px",
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
				};
				const cardStyle = {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					minHeight: CARD_MIN_HEIGHT,
					padding: "8px 10px",
					borderRadius: 10,
					border: "0.5px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					gap: 3,
					marginTop: 4,
					fontSize: "12px",
					lineHeight: "15px",
				};
				// 不支持的路由可以现场去映射：原因下面给一个直达「DeepSeek 用量」设置页的
				// 按钮；宿主没有设置外壳（旧版本 / 未认证页面）时不渲染，避免死按钮。
				if (unsupported) {
					const canMap = canOpenUsageSettings(ctx);
					return h("div", { style: { ...cardStyle, gap: 6 } },
						h("div", {
							style: { ...reasonStyle, cursor: "pointer" },
							role: "button",
							tabIndex: 0,
							"aria-label": t("card.label"),
							onClick: onCardClick,
							onKeyDown: (e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onCardClick();
								}
							},
						}, errs.join(" | ")),
						canMap
							? h("button", {
								type: "button",
								style: {
									alignSelf: "flex-start",
									boxSizing: "border-box",
									height: 22,
									padding: "0 8px",
									borderRadius: 6,
									border: "0.5px solid " + C.cardBorder,
									background: "transparent",
									color: C.label,
									font: "inherit",
									fontSize: 11,
									lineHeight: "20px",
									cursor: "pointer",
								},
								onClick: (e) => {
									if (e && typeof e.stopPropagation === "function") e.stopPropagation();
									openUsageSettings(ctx);
								},
							}, t("status.mapAction"))
							: null,
					);
				}
				return h("div", {
					style: { ...cardStyle, cursor: "pointer" },
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					onClick: onCardClick,
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onCardClick();
						}
					},
				}, h("div", { style: reasonStyle }, errs.join(" | ")));
			}

			// 单价组（图标 + 数字）：说明文字统一挂在下面的单价行上，命中区覆盖整行——鼠标
			// 落在数字上也出说明，不必精确指到那个小图标。
			const Price = (icon, value) =>
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, color: C.sub, whiteSpace: "nowrap" } },
					h("span", { style: { display: "inline-flex", alignItems: "center" }, "aria-hidden": "true" }, icon),
					h("span", { style: { fontWeight: 600 } }, fmtPrice(value)));

			// 单价行的悬浮说明：卡片上只有「图标 + 数字」，读不出单位也读不出三个档位分别
			// 指什么，所以整行共用一条 tooltip。单位是「每百万 tokens」，币种跟价格表走
			// （DeepSeek / Kimi 国内站 / MiniMax 国内站是人民币，Z.ai、OpenRouter 是美元）。
			// 原生 tooltip 不会自动折行，这里显式分两行：第一行讲单位，第二行给三个档位
			// ——侧边栏放不下时也不至于被拉成一长条。
			const priceCurrency = tier && typeof tier.currency === "string" && tier.currency !== "" ? tier.currency : "CNY";
			const priceUnitKey = "currency." + priceCurrency;
			const priceUnitText = t(priceUnitKey);
			const priceUnit = priceUnitText === priceUnitKey ? priceCurrency : priceUnitText;
			const priceTooltip = () => [
				t("price.perMillion"),
				[
					`${t("price.input")} ${fmtPrice(tier.input)} ${priceUnit}`,
					`${t("price.cache")} ${fmtPrice(tier.cacheRead)} ${priceUnit}`,
					`${t("price.output")} ${fmtPrice(tier.output)} ${priceUnit}`,
				].join(" / "),
			].join("\n");

			// 金额行：账户读数 + 右侧「倒计时 + 峰谷圆点」。
			// 倒计时与圆点放在同一个 flex 行里、alignItems:center，两者圆心必然重合；
			// 整组 alignSelf:flex-start + 负 margin，让圆点距卡片顶/右各 8px。
			// 两个反面做法都试过并实测过：
			//   · alignSelf:center → 圆点被压到卡片中线，不再是"右上角"；
			//   · paddingTop:6    → 金额行被撑高，卡片被撑大，圆点反而更靠下。
			// 金额行只放余额读数，在卡片内容区里竖向居中；单价行绝对定位在右下角，
			// 不再占据流式高度，因此金额能真正落在卡片竖直中线上。
			// 右侧留出单价行的宽度，长余额（¥1234567.89）用省略号截断，不会压到单价。
			// 有单价行时金额整体右移 10px，收窄它与右下角单价之间的空白。
			const balanceRow = h("div", {
				style: {
					display: "flex",
					alignItems: "baseline",
					minHeight: 28,
					minWidth: 0,
					gap: 6,
					paddingLeft: priced ? 10 : 0,
					paddingRight: priced ? 104 : 0,
				},
			},
				h("span", { style: leadStyle }, symbol),
				h("span", { style: amountStyle }, amount));

			// 订阅用量：每个窗口一个开口朝下的 D 形仪表盘。绿色弧是尚未使用的额度，
			// 灰色弧是已经用掉的部分；剩余额度在已用 ≥ 80% 时变红。周期缩写徽章嵌在
			// 底部缺口里，省掉单独一行标签。仪表盘按数量均分卡片宽度，竖向居中。
			const GAUGE = 45;
			const GAUGE_STROKE = 4;
			const GAUGE_RADIUS = (GAUGE - GAUGE_STROKE) / 2;
			const GAUGE_CIRC = 2 * Math.PI * GAUGE_RADIUS;
			// 保留底部 140° 的缺口放周期徽章；弧从缺口左端（160°）顺时针扫 220°。
			const GAUGE_SWEEP = 220 / 360;
			const GAUGE_ARC = GAUGE_CIRC * GAUGE_SWEEP;
			const GAUGE_START = 160;
			// 右上角指示灯占位：固定 16px。指示灯是否渲染取决于宿主有没有给计费区间
			// （数据加载前后、不同模型之间都会变），但让位宽度必须恒定，否则三个仪表盘
			// 会随指示灯的显隐左右移动、间距也变——这里始终保留 16px。
			const scheduleInset = 16;
			const disp = data && data.display && typeof data.display === "object" ? data.display : null;
			const activeGaugeStyle = disp && typeof disp.gaugeStyle === "string" ? disp.gaugeStyle : "d-gauge";
			const activePercentMode = disp && disp.percentMode === "used" ? "used" : "remaining";
			const activeWarn = disp && typeof disp.warnThreshold === "number" ? disp.warnThreshold : 60;
			const activeAlert = disp && typeof disp.alertThreshold === "number" ? disp.alertThreshold : 80;
			const useThreeTier = Boolean(disp && (disp.warnThreshold !== 60 || disp.alertThreshold !== 80 || disp.gaugeStyle !== "d-gauge"));

			const isV2 = Boolean(disp || (data && Array.isArray(data.models)));
			const isVerticalGaugeList = activeGaugeStyle === "compact" || activeGaugeStyle === "detailed";
			const usageGrid = h("div", {
				style: isVerticalGaugeList
					? {
						display: "flex",
						flexDirection: "column",
						gap: 6,
						minWidth: 0,
						boxSizing: "border-box",
						paddingRight: scheduleInset,
					}
					: {
						display: "grid",
						gridTemplateColumns: "repeat(" + Math.max(1, usageRows.length) + ", minmax(0, 1fr))",
						justifyItems: "center",
						alignItems: "center",
						gap: 8,
						minWidth: 0,
						width: "100%",
						margin: "0 auto",
						boxSizing: "border-box",
						paddingRight: scheduleInset,
					},
			}, usageRows.map((w) => renderGaugeWindow(w, {
				style: activeGaugeStyle,
				percentMode: activePercentMode,
				warnThreshold: activeWarn,
				alertThreshold: activeAlert,
				threeTier: useThreeTier,
				t,
				lang,
				large: isV2,
			})));

			// 多模型展示列表（当用户启用了 multi 模式且返回了多个模型条目时，在主卡下方渲染附加模型卡片）
			const extraModels = disp && disp.mode === "multi" && Array.isArray(data && data.models) && data.models.length > 1
				? data.models
				: [];

			const renderMultiModelCard = (m) => {
				const mWindows = m.usage && Array.isArray(m.usage.windows)
					? usageWindows({ usage: m.usage })
					: [];
				const hasMWindows = mWindows.length > 0;
				const hasMBalance = m.balance && typeof m.balance.total === "number" && Number.isFinite(m.balance.total);
				const badgeStyle = {
					padding: "0 4px",
					borderRadius: 4,
					border: "0.5px solid " + C.track,
					fontSize: 9,
					lineHeight: "13px",
					color: C.sub,
					whiteSpace: "nowrap",
				};
				return h("div", {
					key: m.key,
					"data-model-card": m.key,
					style: {
						boxSizing: "border-box",
						padding: "6px 8px",
						borderRadius: 8,
						border: "0.5px solid " + C.cardBorder,
						background: C.bg,
						display: "flex",
						flexDirection: "column",
						gap: 4,
						fontSize: 11,
					},
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", minWidth: 0 } },
						h("span", { style: { fontWeight: 600, color: C.label, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.displayName || m.modelId),
						disp.showModelId !== false && m.displayName && m.displayName !== m.modelId
							? h("span", { style: { color: C.sub, fontSize: 10 } }, "(" + m.modelId + ")")
							: null,
						disp.showProvider !== false
							? h("span", { style: badgeStyle }, (m.providerDisplayName || m.routeId) + " · " + (m.isProxy ? t("badge.proxy") : t("badge.official")))
							: null,
						disp.showAccountAlias !== false && m.accountAlias
							? h("span", { style: badgeStyle }, m.accountAlias)
							: null,
						m.sharedQuotaPool
							? h("span", { style: { ...badgeStyle, color: C.peak } }, t("badge.sharedPool"))
							: (m.poolSharingMode === "unknown" ? h("span", { style: badgeStyle }, t("badge.unknownPool")) : null),
						m.stale
							? h("span", { style: { ...badgeStyle, color: C.peak } }, t("badge.stale"))
							: null,
					),
					hasMWindows
						? h("div", {
							style: isVerticalGaugeList
								? { display: "flex", flexDirection: "column", gap: 4 }
								: { display: "grid", gridTemplateColumns: "repeat(" + Math.max(1, mWindows.length) + ", minmax(0, 1fr))", justifyItems: "center" },
						}, mWindows.map((w) => renderGaugeWindow(w, {
							style: activeGaugeStyle,
							percentMode: activePercentMode,
							warnThreshold: activeWarn,
							alertThreshold: activeAlert,
							threeTier: true,
							t,
							lang,
						})))
						: (hasMBalance
							? h("div", { style: { display: "flex", alignItems: "baseline", gap: 4, fontWeight: 700, fontSize: 16, color: C.label } },
								h("span", null, currencySymbol(m.balance.currency)),
								h("span", null, money(m.balance.total)))
							: h("div", { style: { color: m.status === "unsupported" ? C.sub : C.err, fontSize: 11 } },
								m.statusMessage || t("status." + (m.status || "unknown")))));
			};

			// 主监控模型条目与紧凑/展开态详情（B1 ~ B5 & v1.0 视觉清晰度优化）
			const primaryModel = data && Array.isArray(data.models) && data.models[0] ? data.models[0] : null;
			const compactHeader = primaryModel
				? h("div", {
					"data-section": "sidebar-compact-header",
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 6,
						minWidth: 0,
						paddingRight: scheduleInset,
						marginBottom: 6,
					},
				},
					h("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 6,
							minWidth: 0,
							overflow: "hidden",
						},
					},
						h("span", {
							style: {
								fontSize: 14,
								lineHeight: "18px",
								fontWeight: 600,
								color: C.label,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						}, primaryModel.identity && primaryModel.identity.isMonitoringOverride
							? `${t("overview.monitoringTarget")}: ${primaryModel.displayName || primaryModel.modelId}`
							: (primaryModel.displayName || primaryModel.modelId)),
						h("span", {
							style: {
								flex: "none",
								padding: "1px 5px",
								borderRadius: 4,
								border: "0.5px solid " + C.track,
								fontSize: 11,
								lineHeight: "15px",
								color: C.sub,
							},
						}, primaryModel.isProxy ? t("badge.proxy") : t("badge.official")),
						primaryModel.stale
							? h("span", {
								style: {
									flex: "none",
									padding: "1px 5px",
									borderRadius: 4,
									border: "0.5px solid " + C.peak,
									fontSize: 11,
									lineHeight: "15px",
									color: C.peak,
								},
							}, t("badge.stale"))
							: null,
					),
					h("button", {
						type: "button",
						"data-action": "toggle-expand",
						"aria-expanded": expanded,
						"aria-label": expanded ? t("sidebar.collapse") : t("sidebar.expand"),
						onClick: (e) => {
							if (e && typeof e.stopPropagation === "function") e.stopPropagation();
							setExpanded((v) => !v);
						},
						style: {
							flex: "none",
							border: "none",
							background: "transparent",
							color: C.sub,
							padding: "2px 4px",
							cursor: "pointer",
							display: "inline-flex",
							alignItems: "center",
							fontSize: 13,
							lineHeight: "14px",
						},
					}, h("span", {
						style: {
							display: "inline-block",
							transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
							transition: "transform 0.2s ease",
						},
					}, "▾")),
				)
				: null;

			const renderExpandedDetailPanel = () => {
				if (!expanded || !primaryModel) return null;
				const m = primaryModel;
				const mWindows = m.usage && Array.isArray(m.usage.windows) ? m.usage.windows : [];
				const missingWins = Array.isArray(m.missingWindows) ? m.missingWindows : [];
				const updatedTimeStr = typeof m.lastSuccessAt === "number"
					? new Date(m.lastSuccessAt).toLocaleTimeString()
					: (typeof m.fetchedAt === "number" ? new Date(m.fetchedAt).toLocaleTimeString() : "—");
				const rowItem = (labelStr, valStr, highlightColor, extraProps = {}) => h("div", {
					style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: 13, lineHeight: "19px" },
				},
					h("span", { style: { color: C.sub, fontSize: 13, fontWeight: 500, flex: "none" } }, labelStr),
					h("span", {
						...extraProps,
						style: {
							color: highlightColor || C.label,
							fontSize: 13,
							fontWeight: 600,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							textAlign: "right",
							maxWidth: "64%",
							...extraProps.style,
						},
					}, valStr));

				return h("div", {
					"data-panel": "sidebar-expanded",
					onClick: (e) => {
						if (e && typeof e.stopPropagation === "function") e.stopPropagation();
					},
					style: {
						marginTop: 8,
						paddingTop: 8,
						borderTop: "0.5px solid " + C.track,
						display: "flex",
						flexDirection: "column",
						gap: 6,
						overflowX: "hidden",
						minWidth: 0,
					},
				},
					rowItem("Model", m.displayName || m.modelId, null, { style: { fontSize: 15, fontWeight: 600 } }),
					rowItem("Model ID", m.modelId, null, { title: m.modelId }),
					rowItem("Provider", (m.providerDisplayName || m.routeId) + " (" + (m.isProxy ? t("badge.proxy") : t("badge.official")) + ")"),
					rowItem(t("overview.accountAlias"), m.accountAlias || "default"),
					rowItem(t("sidebar.pool"), (m.quotaGroupId ? m.quotaGroupId.toUpperCase() + " · " : "") + (m.sharedQuotaPool ? t("badge.sharedPool") : m.quotaPoolId)),
					mWindows.map((w) => {
						const rem = typeof w.remainingPercent === "number" ? Math.round(w.remainingPercent) : Math.round(100 - w.percent);
						const leftMs = typeof w.resetsAt === "number" ? w.resetsAt - Date.now() : null;
						const resetText = leftMs !== null && leftMs > 0 ? fmtDuration(leftMs, lang) : "—";
						return rowItem(
							windowLabel(t, w.key, lang),
							`${rem}% · ${resetText}`,
							thresholdColor(w.percent, { warnThreshold: activeWarn, alertThreshold: activeAlert, inputMode: "used" }),
							{ style: { fontSize: 14, fontWeight: 600 } },
						);
					}),
					missingWins.map((mw) => rowItem(windowLabel(t, mw, lang), t("overview.windowUnavailable"), C.sub)),
					rowItem(t("sidebar.updatedAt"), updatedTimeStr + (m.stale ? " (" + t("badge.stale") + ")" : ""), m.stale ? C.peak : undefined),
					m.statusMessage ? rowItem(t("overview.status"), m.statusMessage, C.err) : null,
					disp && disp.showDiagnostics && m.identity
						? h("div", {
							"data-section": "sidebar-diagnostics",
							style: {
								marginTop: 4,
								padding: "6px 8px",
								borderRadius: 6,
								background: "rgba(127,127,127,0.08)",
								fontSize: 11,
								lineHeight: "15px",
								color: C.sub,
								display: "flex",
								flexDirection: "column",
								gap: 2,
							},
						},
							h("div", { style: { fontWeight: 600, color: C.label } }, t("sidebar.diagnostics")),
							h("div", null, "basis: " + m.identity.matchBasis + (m.identity.ambiguous ? " (ambiguous)" : "")),
							h("div", null, "group: " + (m.identity.quotaGroupId || "none") + " | account: " + m.identity.accountId),
						)
						: null,
					h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 4 } },
						h("button", {
							type: "button",
							"data-action": "manual-refresh",
							onClick: onManualRefresh,
							style: {
								height: 26,
								padding: "0 10px",
								borderRadius: 6,
								border: "0.5px solid " + C.cardBorder,
								background: "transparent",
								color: C.label,
								font: "inherit",
								fontSize: 13,
								cursor: "pointer",
							},
						}, t("sidebar.refresh"))),
				);
			};

			return h("div", {
				style: {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					overflowX: "hidden",
					// 订阅卡提供适度内边距，让大表盘与卡片边缘有舒适留白
					padding: usageRows.length > 0 ? "10px 12px 10px" : "8px 12px",
					minHeight: 70,
					borderRadius: 10,
					border: "0.5px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					cursor: "pointer",
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					gap: 2,
					marginTop: 4,
					position: "relative",
					fontSize: "13px",
					lineHeight: "16px",
				},
				role: "button",
				tabIndex: 0,
				"aria-expanded": expanded,
				"aria-label": t("card.label"),
				onClick: onCardClick,
				onKeyDown: (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onCardClick();
					}
				},
			},
				compactHeader,
				// 余额形态画金额行；订阅形态画多窗口行（同一张卡片，不拆成多张）。
				extraModels.length > 0 && expanded
					? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, paddingRight: scheduleInset } },
						extraModels.map((m) => renderMultiModelCard(m)))
					: (usageRows.length > 0 ? usageGrid : balanceRow),
				renderExpandedDetailPanel(),
				// 区间指示灯：两种卡片都叠在同一位置（距卡片顶/右各 8px），
				// 位置只由卡片边框决定，不受金额行/仪表盘行高度影响。
				scheduleDot({ position: "absolute", top: 7, right: 7 }),
				// 单价行：当前档单价，绝对定位在卡片右下角。价格表里没有的模型
				// （known=false）整行不渲染——表外数字与它们的实际账单无关。
				// 订阅制不按 token 计价，即使命中了价格表也不显示单价行。
				// 绝对定位不参与卡片高度计算：金额行因此能在卡片里竖直居中，
				// 底部也不会空出比顶部更多的一截。
				// 用 flex-end 而不是 space-between：容器只有一个子元素时 space-between 会把它
				// 推到最左侧（0.6.0 的回归点）。
				priced && usageRows.length === 0 && h("span", {
					style: {
						position: "absolute",
						right: 9,
						bottom: 4,
						display: "flex",
						alignItems: "center",
						justifyContent: "flex-end",
						gap: 6,
						minWidth: 0,
					},
					title: priceTooltip(),
				},
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "none" } },
						Price(h(IconIn, null), tier.input),
						Price(h(IconCache, null), tier.cacheRead),
						Price(h(IconOut, null), tier.output))));
		}

		// ---- 设置页：OAuth 订阅令牌 --------------------------------------
		// 渲染在设置面板「DeepSeek 用量」页里，紧跟在「提供商映射」编辑器之后。
		// 内容来自宿主的 GET /api/deepseek-usage/accounts：这个 DSH 检测到，或有映射目标
		// 指向 Claude Code / Codex 时才有对应条目；令牌经 POST /token 写入凭证服务，
		// 响应里永不回传，因此这里只显示"已填写 / 未填写"。
		const ACCOUNTS_PATH = "/api/deepseek-usage/accounts";
		const TOKEN_PATH = "/api/deepseek-usage/token";
		/**
		 * OAuth 提供商的令牌来源说明 key（token.source.<key>）。
		 * 按 provider 路由 id 映射：接口返回的是 `anthropic` / `openai-codex`，
		 * 词典里按刻意的短名命名（claude / codex）。`chatgpt-codex` 是第三方
		 * Codex 插件注册同一家订阅接口时用的路由 id，指向同一份令牌说明。
		 */
		const TOKEN_SOURCE_KEYS = { anthropic: "claude", "openai-codex": "codex", "chatgpt-codex": "codex" };

		function OAuthTokenSection(props) {
			const t = props.t;
			// null = 还在读；[] = 没有检测到 OAuth 路由（整块不渲染）；
			// failed = 宿主路由读不到（给出说明，而不是静默消失）。
			const [providers, setProviders] = useState(null);
			const [failed, setFailed] = useState(false);
			const [draft, setDraft] = useState({});
			const [accountDraft, setAccountDraft] = useState({});
			const [saving, setSaving] = useState("");
			const [notice, setNotice] = useState("");
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);

			const load = useCallback(async () => {
				try {
					const res = await fetch(ACCOUNTS_PATH, { cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (!res.ok || !body || body.ok !== true) {
						setFailed(true);
						return;
					}
					setFailed(false);
					setProviders(Array.isArray(body.oauth) ? body.oauth : []);
				} catch (e) {
					if (mountedRef.current) setFailed(true);
				}
			}, []);

			useEffect(() => { load().catch(() => {}); }, [load]);

			// 映射保存后宿主会把目标 OAuth 提供商带进 /accounts 的 oauth 列表：
			// 收到配置更新事件就重读，令牌框随即出现（或随映射删除而消失）。
			useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onConfig = () => { load().catch(() => {}); };
				window.addEventListener("dsh-usage:config-updated", onConfig);
				return () => window.removeEventListener("dsh-usage:config-updated", onConfig);
			}, [load]);

			// 令牌保存/清除。`override` 用于清除：那时草稿还没清空，不能读 state
			// （setState 是异步的，读到的仍是旧值）。
			const submitToken = useCallback(async (provider, override) => {
				const token = override !== undefined ? override : (draft[provider] ?? "").trim();
				setSaving(provider);
				try {
					const payload = { provider, token };
					// Codex 的账号 ID 与令牌一并提交（缺了它上游可能拒绝请求）；
					// 清除时不带，宿主会连带 unset。
					const accountId = (accountDraft[provider] ?? "").trim();
					if (token !== "" && accountId !== "") payload.accountId = accountId;
					const res = await fetch(TOKEN_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					});
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (!res.ok || !body || body.ok !== true) {
						setNotice(t("token.failed"));
						return;
					}
					setNotice(body.configured ? t("token.saved") : t("token.cleared"));
					setDraft((d) => ({ ...d, [provider]: "" }));
					if (!body.configured) setAccountDraft((d) => ({ ...d, [provider]: "" }));
					await load();
				} catch (e) {
					if (mountedRef.current) setNotice(t("token.failed"));
				} finally {
					if (mountedRef.current) setSaving("");
				}
			}, [draft, accountDraft, t, load]);

			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const tagStyle = {
				flex: "none",
				borderRadius: "var(--dsw-radius-xs, 4px)",
				border: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))",
				color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
				padding: "0 4px",
				fontSize: 10,
				lineHeight: "14px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 26,
				padding: "0 10px",
				cursor: "pointer",
			};
			const inputStyle = {
				boxSizing: "border-box",
				width: "100%",
				minWidth: 0,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				padding: "4px 8px",
			};
			const cardNameStyle = {
				fontWeight: 500,
				fontSize: 12,
				lineHeight: "16px",
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			};

			// 没有检测到 OAuth 路由时没有可填的东西：整块不出现。
			if (!failed && (providers === null || providers.length === 0)) return null;

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("token.title")),
				h("p", { style: hintStyle }, t("token.intro")),
				failed
					? h("p", { style: hintStyle }, t("token.unavailable"))
					: null,
				notice ? h("p", { style: hintStyle }, notice) : null,
				providers === null || failed
					? null
					: providers.map((item) => {
						const sourceKey = TOKEN_SOURCE_KEYS[item.id] ?? item.id;
						return h("div", {
							key: item.id,
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 6,
								padding: 10,
								borderRadius: "var(--dsw-radius-md, 6px)",
								border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
								background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
							},
						},
							h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
								h("span", { style: cardNameStyle }, item.displayName || item.id),
								h("span", { style: { ...tagStyle, marginLeft: "auto" } },
									item.configured ? t("token.configured") : t("token.missing")),
							),
							h("p", { style: hintStyle }, t("token.source." + sourceKey)),
							h("textarea", {
								style: { ...inputStyle, minHeight: 52, resize: "vertical", fontFamily: "inherit" },
								placeholder: t("token.placeholder"),
								value: draft[item.id] ?? "",
								onChange: (e) => setDraft((d) => ({ ...d, [item.id]: e.target.value })),
							}),
							item.id === "openai-codex"
								? h("input", {
									type: "text",
									style: inputStyle,
									placeholder: t("token.accountPlaceholder"),
									value: accountDraft[item.id] ?? "",
									onChange: (e) => setAccountDraft((d) => ({ ...d, [item.id]: e.target.value })),
								})
								: null,
							h("div", { style: { display: "flex", gap: 8 } },
								h("button", {
									type: "button",
									style: buttonStyle,
									disabled: saving === item.id,
									onClick: () => submitToken(item.id).catch(() => {}),
								}, t("token.save")),
								h("button", {
									type: "button",
									style: buttonStyle,
									disabled: saving === item.id,
									onClick: () => submitToken(item.id, "").catch(() => {}),
								}, t("token.clear")),
							),
						);
					}),
			);
		}

		// ---- 设置页：provider 映射 --------------------------------------
		// 设置面板的「DeepSeek 用量」页（`settings.section`）里只做两件事：把第三方插件
		// 注册的 provider id 映射到本插件支持的提供商，以及填写 OAuth 订阅令牌。
		// 不猜名字、不猜端点。映射保存写回 profile 里本插件条目的 config。
		const REF_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$/;

		/** 配置值 → 草稿行（refs 在界面上是一行逗号分隔的文本）。 */
		function aliasDraftOf(value) {
			const rows = value && Array.isArray(value.providerAliases) ? value.providerAliases : [];
			return rows.map((row) => ({
				provider: row && typeof row.provider === "string" ? row.provider : "",
				capability: row && typeof row.capability === "string" ? row.capability : "",
				refsText: row && Array.isArray(row.refs) ? row.refs.join(", ") : "",
			}));
		}

		/** 一行文本 → 凭据引用数组（非法 token 直接丢弃，与宿主侧的校验一致）。 */
		function parseRefs(text) {
			return String(text || "")
				.split(/[\s,]+/)
				.map((ref) => ref.trim())
				.filter((ref) => REF_TOKEN.test(ref));
		}

		/** 设置页的映射列表 + 添加/删除 + 保存。 */
		function ProviderAliasesSettings(props) {
			const t = props.t;
			const form = props.form;
			const state = form && form.state ? form.state : null;
			const revision = state ? state.revision : undefined;
			const status = state ? state.status : undefined;
			const [draft, setDraft] = useState(() => aliasDraftOf(state && state.value));
			const [meta, setMeta] = useState(null);
			const [notice, setNotice] = useState("");
			const [problems, setProblems] = useState({});
			const [saving, setSaving] = useState(false);
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);

			// 宿主配置更新（保存成功、或在别处改了配置）时，以配置为准重置草稿。
			useEffect(() => {
				setDraft(aliasDraftOf(state && state.value));
				setProblems({});
			}, [revision, status]);

			// 下拉选项与「检测到但未识别」的候选都来自 /accounts（宿主只读本地状态，不查上游）。
			useEffect(() => {
				let alive = true;
				fetch(ACCOUNTS_PATH, { cache: "no-store" })
					.then(async (res) => {
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (!alive || !res.ok || !body || body.ok !== true) return;
						setMeta({
							aliasable: Array.isArray(body.aliasable) ? body.aliasable : [],
							unmapped: Array.isArray(body.unmapped) ? body.unmapped : [],
						});
					})
					.catch(() => { /* 选项拿不到时页面仍可用，只是没有候选 */ });
				return () => { alive = false; };
			}, []);

			const aliasable = meta && Array.isArray(meta.aliasable) ? meta.aliasable : [];
			const aliasableIds = new Set(aliasable.map((item) => item.id));
			// 目标类型：OAuth 目标的凭据是订阅令牌，不发凭据引用。
			const kindOf = (id) => {
				const hit = aliasable.find((item) => item.id === id);
				return hit ? hit.kind : "";
			};
			const detected = (meta && Array.isArray(meta.unmapped) ? meta.unmapped : [])
				.filter((item) => !draft.some((row) => row.provider.trim().toLowerCase() === item.id.toLowerCase()));

			const update = (index, patch) => setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
			const remove = (index) => setDraft((rows) => rows.filter((_, i) => i !== index));
			const add = (provider) => setDraft((rows) => [...rows, { provider: provider || "", capability: "", refsText: "" }]);

			/** 提交前校验：空 id / 重复 / 已内置支持 / 未选目标。 */
			const validate = () => {
				const next = {};
				const seen = new Set();
				draft.forEach((row, index) => {
					const provider = row.provider.trim();
					const key = provider.toLowerCase();
					if (provider === "") next[index] = t("alias.providerRequired");
					else if (seen.has(key)) next[index] = t("alias.duplicate");
					else if (aliasableIds.has(key)) next[index] = t("alias.builtin");
					else if (row.capability === "") next[index] = t("alias.capabilityRequired");
					seen.add(key);
				});
				return next;
			};

			const save = async () => {
				if (form === undefined) return;
				const next = validate();
				setProblems(next);
				if (Object.keys(next).length > 0) {
					setNotice("");
					return;
				}
				setSaving(true);
				try {
					const value = draft.map((row) => ({
						provider: row.provider.trim(),
						capability: row.capability,
						// OAuth 目标的令牌在「订阅令牌」区写入凭据服务，映射里不存引用。
						refs: kindOf(row.capability) === "oauth" ? [] : parseRefs(row.refsText),
					}));
					const ok = await form.mutate([{ op: "set", path: ["providerAliases"], value }]);
					if (mountedRef.current) setNotice(ok ? t("alias.saved") : t("alias.saveFailed"));
					// 让侧边栏卡片立即按新映射重取一次（volatile 配置就地更新，宿主不会重启）。
					if (ok && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
						window.dispatchEvent(new Event("dsh-usage:config-updated"));
					}
				} catch (e) {
					if (mountedRef.current) setNotice(t("alias.saveFailed"));
				} finally {
					if (mountedRef.current) setSaving(false);
				}
			};

			const inputStyle = {
				boxSizing: "border-box",
				minWidth: 0,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 8px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 10px",
				cursor: "pointer",
			};
			const rowStyle = {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: 8,
				padding: 10,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
				background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
			};
			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const problemStyle = { margin: 0, fontSize: 11, lineHeight: "16px", color: C.err };

			const header = h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
				h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("alias.title")),
				h("button", {
					type: "button",
					style: { ...buttonStyle, marginLeft: "auto" },
					disabled: saving || (state !== null && state.writable === false),
					onClick: () => { save().catch(() => {}); },
				}, t("alias.save")),
			);

			// 宿主没有交出配置表单（旧宿主、或该条目没被 settings 收录）：给出兜底说明。
			if (form === undefined) {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
					header,
					h("p", { style: hintStyle }, t("alias.unavailable")),
					h("p", { style: hintStyle }, t("alias.yamlHint")),
				);
			}
			if (status === "loading") {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
					header,
					h("p", { style: hintStyle }, t("alias.loading")),
				);
			}
			if (status === "unavailable") {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
					header,
					h("p", { style: hintStyle }, t("alias.unavailable")),
					h("p", { style: hintStyle }, t("alias.yamlHint")),
				);
			}

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				header,
				h("p", { style: hintStyle }, t("alias.intro")),
				state !== null && state.writable === false
					? h("p", { style: hintStyle }, t("alias.readonly"))
					: null,
				draft.length === 0
					? h("p", { style: hintStyle }, t("alias.empty"))
					: h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
						draft.map((row, index) => h("div", { key: index, style: rowStyle },
							h("input", {
								type: "text",
								style: { ...inputStyle, flex: "1 1 200px" },
								placeholder: t("alias.providerPlaceholder"),
								"aria-label": t("alias.provider"),
								value: row.provider,
								disabled: state !== null && state.writable === false,
								onChange: (e) => update(index, { provider: e.target.value }),
							}),
							h("select", {
								style: { ...inputStyle, flex: "0 1 200px" },
								"aria-label": t("alias.capability"),
								value: row.capability,
								disabled: state !== null && state.writable === false,
								onChange: (e) => update(index, { capability: e.target.value }),
							},
								h("option", { value: "" }, t("alias.capabilityPlaceholder")),
								// 配置里已有的目标即使不在选项里也要显示，不能把值悄悄丢掉。
								(row.capability !== "" && !aliasableIds.has(row.capability)
									? [h("option", { key: row.capability, value: row.capability }, row.capability)]
									: []),
								aliasable.map((item) => h("option", { key: item.id, value: item.id },
									item.displayName && item.displayName !== item.id
										? item.displayName + " (" + item.id + ")"
										: item.id)),
							),
							kindOf(row.capability) === "oauth"
								? h("p", { style: { ...hintStyle, flex: "1 1 220px" } }, t("alias.oauthHint"))
								: h("input", {
									type: "text",
									style: { ...inputStyle, flex: "1 1 220px" },
									placeholder: t("alias.refs"),
									"aria-label": t("alias.refs"),
									value: row.refsText,
									disabled: state !== null && state.writable === false,
									onChange: (e) => update(index, { refsText: e.target.value }),
								}),
							h("button", {
								type: "button",
								style: buttonStyle,
								disabled: state !== null && state.writable === false,
								onClick: () => remove(index),
							}, t("alias.remove")),
							problems[index] ? h("p", { style: problemStyle }, problems[index]) : null,
						)),
					),
				draft.some((row) => kindOf(row.capability) !== "oauth")
					? h("p", { style: hintStyle }, t("alias.refsHint"))
					: null,
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
					h("button", {
						type: "button",
						style: buttonStyle,
						disabled: state !== null && state.writable === false,
						onClick: () => add(""),
					}, t("alias.add")),
				),
				detected.length > 0
					? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
						h("p", { style: { ...hintStyle, fontWeight: 500, color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))" } }, t("alias.detected")),
						h("p", { style: hintStyle }, t("alias.detectedHint")),
						h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
							detected.map((item) => h("button", {
								key: item.id,
								type: "button",
								style: { ...buttonStyle, height: "auto", padding: "3px 8px" },
								disabled: state !== null && state.writable === false,
								onClick: () => add(item.id),
							}, (item.displayName || item.id) + " · " + item.id)),
					))
					: null,
				notice ? h("p", { style: hintStyle }, notice) : null,
			);
		}

		/**
		 * 设置面板「DeepSeek 用量」页的配置体：上面是 provider 映射编辑器，下面是
		 * OAuth 令牌填写区。这个 slot 的 owner props 只有 close，不直接给配置表单，
		 * 所以从 `configForms` 服务按本条目 id 取同一个表单控制器；服务不可用时退回
		 * 手写 YAML 的说明。条目 id 来自本包的 cordis.patch.yml（insert 的 id）。
		 */
		const ROUTING_PATH = "/api/deepseek-usage/routing";
		const DEFAULT_DISPLAY_DRAFT = {
			mode: "auto",
			fixedModelKey: "",
			selectedModelKeys: [],
			hiddenModelKeys: [],
			favoriteModelKeys: [],
			modelOrder: [],
			modelAliases: {},
			accountAliases: {},
			groupByProvider: false,
			gaugeStyle: "d-gauge",
			percentMode: "remaining",
			warnThreshold: 60,
			alertThreshold: 80,
			preferredPeriod: "all",
			showModelId: true,
			showProvider: true,
			showAccountAlias: true,
			refreshIntervalMinutes: 0.5,
			localWeekStart: "monday",
			localTimezone: "Asia/Shanghai",
		};

		function displayDraftOf(value) {
			const raw = value && value.display && typeof value.display === "object" ? value.display : {};
			return {
				...DEFAULT_DISPLAY_DRAFT,
				...raw,
				selectedModelKeys: Array.isArray(raw.selectedModelKeys) ? [...raw.selectedModelKeys] : [],
				hiddenModelKeys: Array.isArray(raw.hiddenModelKeys) ? [...raw.hiddenModelKeys] : [],
				favoriteModelKeys: Array.isArray(raw.favoriteModelKeys) ? [...raw.favoriteModelKeys] : [],
				modelOrder: Array.isArray(raw.modelOrder) ? [...raw.modelOrder] : [],
				modelAliases: raw.modelAliases && typeof raw.modelAliases === "object" ? { ...raw.modelAliases } : {},
			};
		}

		/**
		 * 设置页：UI 展示模型与表盘样式设置（P4 6.1 UI Display Target）。
		 * 修改展示模型只写本插件 `display` 配置，绝不改变 DSH 实际模型路由。
		 */
		function DisplayTargetSettings(props) {
			const t = props.t;
			const form = props.form;
			const state = form && form.state ? form.state : null;
			const revision = state ? state.revision : undefined;
			const [expanded, setExpanded] = useState(Boolean(props.defaultExpanded));
			const [draft, setDraft] = useState(() => displayDraftOf(state && state.value));
			const [catalogModels, setCatalogModels] = useState([]);
			const [saving, setSaving] = useState(false);
			const [notice, setNotice] = useState("");
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);
			useEffect(() => {
				setDraft(displayDraftOf(state && state.value));
			}, [revision]);

			useEffect(() => {
				if (!expanded) return undefined;
				let alive = true;
				fetch(ROUTING_PATH, { cache: "no-store" })
					.then(async (res) => {
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (!alive || !res || !res.ok || !body || body.ok !== true) return;
						if (Array.isArray(body.models)) setCatalogModels(body.models);
					})
					.catch(() => {});
				return () => { alive = false; };
			}, [expanded]);

			const save = async () => {
				if (!form) return;
				setSaving(true);
				try {
					const ok = await form.mutate([{ op: "set", path: ["display"], value: draft }]);
					if (mountedRef.current) setNotice(ok ? t("alias.saved") : t("alias.saveFailed"));
					if (ok && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
						window.dispatchEvent(new Event("dsh-usage:config-updated"));
					}
				} catch (e) {
					if (mountedRef.current) setNotice(t("alias.saveFailed"));
				} finally {
					if (mountedRef.current) setSaving(false);
				}
			};

			const toggleModelSelection = (key) => {
				setDraft((d) => {
					const exists = d.selectedModelKeys.includes(key);
					const next = exists
						? d.selectedModelKeys.filter((k) => k !== key)
						: [...d.selectedModelKeys, key];
					return { ...d, selectedModelKeys: next };
				});
			};

			const inputStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 8px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 10px",
				cursor: "pointer",
			};
			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};

			if (!form || (state && state.status === "unavailable")) return null;

			return h("div", {
				"data-section": "display-target",
				style: { display: "flex", flexDirection: "column", gap: 10 },
			},
				h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("display.title")),
					h("button", {
						type: "button",
						"data-action": "toggle-display-settings",
						style: { ...buttonStyle, marginLeft: "auto" },
						onClick: () => setExpanded((v) => !v),
					}, expanded ? "▲" : "▼"),
					expanded
						? h("button", {
							type: "button",
							style: buttonStyle,
							disabled: saving || (state !== null && state.writable === false),
							onClick: () => { save().catch(() => {}); },
						}, t("display.save"))
						: null,
					expanded
						? h("button", {
							type: "button",
							style: buttonStyle,
							disabled: saving,
							onClick: () => setDraft({ ...DEFAULT_DISPLAY_DRAFT }),
						}, t("display.reset"))
						: null,
				),
				h("p", { style: hintStyle }, t("display.intro")),
				!expanded
					? null
					: h("div", {
						style: {
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
							gap: 8,
							padding: 10,
							borderRadius: "var(--dsw-radius-md, 6px)",
							border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
							background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
						},
					},
						h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
							h("span", null, t("display.mode")),
							h("select", {
								style: inputStyle,
								value: draft.mode,
								onChange: (e) => setDraft((d) => ({ ...d, mode: e.target.value })),
							},
								h("option", { value: "auto" }, t("display.mode.auto")),
								h("option", { value: "fixed" }, t("display.mode.fixed")),
								h("option", { value: "multi" }, t("display.mode.multi")),
							)),
						h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
							h("span", null, t("display.gaugeStyle")),
							h("select", {
								style: inputStyle,
								value: draft.gaugeStyle,
								onChange: (e) => setDraft((d) => ({ ...d, gaugeStyle: e.target.value })),
							},
								h("option", { value: "d-gauge" }, t("display.gauge.d-gauge")),
								h("option", { value: "ring" }, t("display.gauge.ring")),
								h("option", { value: "semicircle" }, t("display.gauge.semicircle")),
								h("option", { value: "compact" }, t("display.gauge.compact")),
								h("option", { value: "detailed" }, t("display.gauge.detailed")),
							)),
						h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
							h("span", null, t("display.percentMode")),
							h("select", {
								style: inputStyle,
								value: draft.percentMode,
								onChange: (e) => setDraft((d) => ({ ...d, percentMode: e.target.value })),
							},
								h("option", { value: "remaining" }, t("display.percent.remaining")),
								h("option", { value: "used" }, t("display.percent.used")),
							)),
						h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
							h("span", null, t("display.refreshInterval")),
							h("select", {
								style: inputStyle,
								value: String(draft.refreshIntervalMinutes),
								onChange: (e) => setDraft((d) => ({ ...d, refreshIntervalMinutes: Number(e.target.value) })),
							},
								h("option", { value: "0.5" }, "30s"),
								h("option", { value: "5" }, "5 min"),
								h("option", { value: "15" }, "15 min"),
								h("option", { value: "30" }, "30 min"),
								h("option", { value: "60" }, "60 min"),
							)),
						h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
							h("span", null, t("display.warnThreshold")),
							h("input", {
								type: "number",
								min: 1,
								max: 99,
								style: inputStyle,
								value: String(draft.warnThreshold),
								onChange: (e) => setDraft((d) => ({ ...d, warnThreshold: Number(e.target.value) || 60 })),
							})),
						h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
							h("span", null, t("display.alertThreshold")),
							h("input", {
								type: "number",
								min: 1,
								max: 100,
								style: inputStyle,
								value: String(draft.alertThreshold),
								onChange: (e) => setDraft((d) => ({ ...d, alertThreshold: Number(e.target.value) || 80 })),
							})),
					),
				expanded && draft.mode === "fixed" && catalogModels.length > 0
					? h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						h("select", {
							style: { ...inputStyle, flex: "1 1 auto" },
							value: draft.fixedModelKey,
							onChange: (e) => setDraft((d) => ({ ...d, fixedModelKey: e.target.value })),
						},
							h("option", { value: "" }, "—"),
							catalogModels.map((m) => h("option", { key: m.key, value: m.key },
								m.displayName + " (" + m.providerDisplayName + " · " + (m.isProxy ? "Proxy" : "Official") + ")")),
						))
					: null,
				expanded && draft.mode === "multi" && catalogModels.length > 0
					? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
						catalogModels.map((m) => {
							const active = draft.selectedModelKeys.includes(m.key);
							return h("button", {
								key: m.key,
								type: "button",
								style: {
									...buttonStyle,
									height: 24,
									padding: "0 8px",
									borderColor: active ? "var(--dsw-alias-brand-primary, #3b82f6)" : "var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
								},
								onClick: () => toggleModelSelection(m.key),
							}, (active ? "✓ " : "+ ") + m.displayName + " · " + m.providerDisplayName);
						}))
					: null,
				notice ? h("p", { style: hintStyle }, notice) : null,
			);
		}

		/**
		 * 设置页：独立的 DSH 路由模型查看与配置区（P4 6.2 Routing Model Mapping）。
		 * 支持查看当前实际路由、切换逻辑/目标路由模型、配置自定义 BaseURL 与凭据引用、测试连通性及导出非敏感配置。
		 */
		function RoutingModelSettings(props) {
			const t = props.t;
			const ctx = props.ctx;
			const [expanded, setExpanded] = useState(Boolean(props.defaultExpanded));
			const [routing, setRouting] = useState(null);
			const [selectedProvider, setSelectedProvider] = useState("");
			const [selectedModel, setSelectedModel] = useState("");
			const [editRouteId, setEditRouteId] = useState("");
			const [editBaseUrl, setEditBaseUrl] = useState("");
			const [editKeyRef, setEditKeyRef] = useState("");
			const [notice, setNotice] = useState("");
			const [busy, setBusy] = useState(false);
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);

			const loadRouting = useCallback(async () => {
				try {
					const res = await fetch(ROUTING_PATH, { cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current || !res || !res.ok || !body || body.ok !== true) return;
					if (!Array.isArray(body.routes)) return;
					setRouting(body);
					if (body.currentDefault) {
						setSelectedProvider((p) => p || body.currentDefault.provider || "");
						setSelectedModel((m) => m || body.currentDefault.model || "");
					}
				} catch (e) {}
			}, []);

			useEffect(() => {
				if (expanded) loadRouting().catch(() => {});
			}, [expanded, loadRouting]);

			const switchRoute = async () => {
				if (!selectedProvider || !selectedModel) return;
				setBusy(true);
				try {
					const res = await fetch(ROUTING_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "selectDefaultModel",
							provider: selectedProvider,
							model: selectedModel,
						}),
					});
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (res && res.ok && body && body.ok) {
						setNotice(t("alias.saved"));
						await loadRouting();
						if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
							window.dispatchEvent(new Event("dsh-usage:config-updated"));
						}
					} else {
						setNotice((body && body.message) || t("alias.saveFailed"));
					}
				} catch (e) {
					if (mountedRef.current) setNotice(t("alias.saveFailed"));
				} finally {
					if (mountedRef.current) setBusy(false);
				}
			};

			const testConnectivity = async () => {
				if (!selectedProvider) return;
				setBusy(true);
				try {
					const res = await fetch(ROUTING_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "testRoute",
							provider: selectedProvider,
							model: selectedModel,
						}),
					});
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					setNotice(body && body.ok ? "OK: " + (body.model || selectedProvider) : ((body && body.message) || "Failed"));
				} catch (e) {
					if (mountedRef.current) setNotice("Failed");
				} finally {
					if (mountedRef.current) setBusy(false);
				}
			};

			const saveRouteEndpoint = async () => {
				if (!editRouteId) return;
				setBusy(true);
				try {
					const res = await fetch(ROUTING_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "configureRoute",
							routeId: editRouteId,
							baseURL: editBaseUrl,
							apiKeyRef: editKeyRef,
						}),
					});
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					setNotice(res && res.ok && body && body.ok ? t("alias.saved") : ((body && body.message) || t("alias.saveFailed")));
					if (res && res.ok && body && body.ok) await loadRouting();
				} catch (e) {
					if (mountedRef.current) setNotice(t("alias.saveFailed"));
				} finally {
					if (mountedRef.current) setBusy(false);
				}
			};

			const inputStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 8px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 10px",
				cursor: "pointer",
			};
			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};

			const routes = routing && Array.isArray(routing.routes) ? routing.routes : [];
			const currentRouteObj = routes.find((r) => r.routeId === selectedProvider) || routes[0] || null;
			const candidateModels = currentRouteObj && Array.isArray(currentRouteObj.models) ? currentRouteObj.models : [];

			return h("div", {
				"data-section": "routing-management",
				style: { display: "flex", flexDirection: "column", gap: 10 },
			},
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
					h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("routing.title")),
					h("button", {
						type: "button",
						"data-action": "toggle-routing-settings",
						style: { ...buttonStyle, marginLeft: "auto" },
						onClick: () => setExpanded((v) => !v),
					}, expanded ? "▲" : "▼"),
					canOpenUsageSettings(ctx)
						? h("button", {
							type: "button",
							style: buttonStyle,
							onClick: () => {
								try { settingsShellOf(ctx)?.actions?.openSection("models"); } catch (e) {}
							},
						}, t("routing.openNative"))
						: null,
				),
				h("p", { style: hintStyle }, t("routing.intro")),
				expanded && routing && routing.currentDefault
					? h("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							flexWrap: "wrap",
							padding: 10,
							borderRadius: "var(--dsw-radius-md, 6px)",
							border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
							background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
							fontSize: 12,
						},
					},
						h("span", { style: { fontWeight: 600 } }, t("routing.current") + ": " + routing.currentDefault.provider + " / " + routing.currentDefault.model),
						h("select", {
							style: inputStyle,
							value: selectedProvider,
							onChange: (e) => {
								const nextP = e.target.value;
								setSelectedProvider(nextP);
								const hit = routes.find((r) => r.routeId === nextP);
								if (hit && Array.isArray(hit.models) && hit.models[0]) {
									setSelectedModel(hit.models[0].id);
								}
							},
						}, routes.map((r) => h("option", { key: r.routeId, value: r.routeId },
							r.displayName + " (" + r.routeId + " · " + (r.isProxy ? "Proxy" : "Official") + ")"))),
						h("select", {
							style: inputStyle,
							value: selectedModel,
							onChange: (e) => setSelectedModel(e.target.value),
						}, candidateModels.map((m) => h("option", { key: m.id, value: m.id }, m.name + " (" + m.id + ")"))),
						h("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy || routing.writable === false,
							onClick: () => { switchRoute().catch(() => {}); },
						}, t("routing.switch")),
						h("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy,
							onClick: () => { testConnectivity().catch(() => {}); },
						}, t("routing.test")),
					)
					: null,
				expanded && routing && routing.writable !== false
					? h("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							flexWrap: "wrap",
							padding: 10,
							borderRadius: "var(--dsw-radius-md, 6px)",
							border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
							background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
						},
					},
						h("input", {
							type: "text",
							style: { ...inputStyle, flex: "1 1 140px" },
							placeholder: "Route ID (e.g. my-proxy)",
							value: editRouteId,
							onChange: (e) => setEditRouteId(e.target.value),
						}),
						h("input", {
							type: "text",
							style: { ...inputStyle, flex: "2 1 200px" },
							placeholder: "Base URL (https://...)",
							value: editBaseUrl,
							onChange: (e) => setEditBaseUrl(e.target.value),
						}),
						h("input", {
							type: "text",
							style: { ...inputStyle, flex: "1 1 140px" },
							placeholder: "API Key Env (e.g. MY_PROXY_API_KEY)",
							value: editKeyRef,
							onChange: (e) => setEditKeyRef(e.target.value),
						}),
						h("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy || !editRouteId.trim(),
							onClick: () => { saveRouteEndpoint().catch(() => {}); },
						}, t("alias.save")),
					)
					: null,
				notice ? h("p", { style: hintStyle }, notice) : null,
			);
		}

		/**
		 * 设置页：模型监控概览、按真实额度组隔离的额度卡片与账号管理（目标 A：参考 dsh-tool-antigravity 设计）。
		 */
		function UsageOverviewSection(props) {
			const t = props.t;
			const lang = props.lang || "zh";
			const [overview, setOverview] = useState(() => props.initialOverview || null);
			const [busy, setBusy] = useState(false);
			const [switchingHandle, setSwitchingHandle] = useState("");
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);

			const loadOverview = useCallback(async (force = false) => {
				setBusy(true);
				try {
					const suffix = force ? "&force=1" : "";
					const res = await fetch(USAGE_PATH + "?lang=" + lang + suffix, { cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current || !res || !res.ok || !body || body.ok !== true) return;
					if (!body.provider || !Array.isArray(body.models)) return;
					setOverview(body);
				} catch (e) {
				} finally {
					if (mountedRef.current) setBusy(false);
				}
			}, [lang]);

			useEffect(() => {
				loadOverview(false).catch(() => {});
			}, [loadOverview]);

			const switchAccount = async (handle) => {
				if (!handle) return;
				setSwitchingHandle(handle);
				try {
					const res = await fetch(ROUTING_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action: "switchAntigravityAccount", handle }),
					});
					if (res && res.ok) {
						await loadOverview(true);
						if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
							window.dispatchEvent(new Event("dsh-usage:config-updated"));
						}
					}
				} catch (e) {
				} finally {
					if (mountedRef.current) setSwitchingHandle("");
				}
			};

			if (!overview || !overview.provider || !Array.isArray(overview.models) || overview.models.length === 0) {
				return null;
			}

			const primary = overview.models[0];
			const activeRoute = overview.activeRoute || { provider: primary.routeId, model: primary.modelId };
			const isOverride = Boolean(primary.identity && primary.identity.isMonitoringOverride);
			const updatedStr = typeof primary.lastSuccessAt === "number"
				? new Date(primary.lastSuccessAt).toLocaleTimeString()
				: "—";

			const cardBoxStyle = {
				padding: "14px 16px",
				borderRadius: 10,
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))",
				background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))",
				display: "flex",
				flexDirection: "column",
				gap: 12,
			};
			const btnStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 10px",
				cursor: "pointer",
			};
			const badgePill = (text, colorHex, bgAlpha) => h("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 5,
					padding: "2px 8px",
					borderRadius: 12,
					fontSize: 11,
					fontWeight: 500,
					lineHeight: "16px",
					background: bgAlpha || "rgba(34, 197, 94, 0.12)",
					color: colorHex || C.idle,
					border: "1px solid " + (colorHex || C.idle),
				},
			},
				h("span", { style: { width: 6, height: 6, borderRadius: "50%", background: colorHex || C.idle } }),
				text,
			);

			// 渲染单个窗口进度条（若 windowObj 为 null，则显示“未返回 / 不支持”，绝不跨组填充）
			const renderWindowBucket = (periodKey, windowObj) => {
				const title = periodKey === "5h"
					? (lang === "zh" ? "5 小时限额 (5H)" : "5-Hour Limit (5H)")
					: (lang === "zh" ? "周限额 (Weekly / 7D)" : "Weekly Limit (7D)");
				if (!windowObj) {
					return h("div", {
						key: periodKey,
						"data-window-bucket": periodKey,
						"data-window-status": "unavailable",
						style: { display: "flex", flexDirection: "column", gap: 6 },
					},
						h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 13 } },
							h("span", { style: { fontWeight: 500, color: C.sub } }, title),
							h("span", { style: { fontSize: 12, color: C.sub } }, t("overview.windowUnavailable")),
						),
						h("div", {
							style: {
								width: "100%",
								height: 7,
								borderRadius: 4,
								background: "var(--dsw-alias-border-l1, rgba(127,127,127,.18))",
								overflow: "hidden",
							},
						}),
					);
				}

				const usedPct = typeof windowObj.usedPercent === "number" ? windowObj.usedPercent : windowObj.percent;
				const remPct = typeof windowObj.remainingPercent === "number"
					? windowObj.remainingPercent
					: Math.max(0, Math.min(100, 100 - usedPct));
				const barColor = thresholdColor(usedPct, { inputMode: "used" });
				const leftMs = typeof windowObj.resetsAt === "number" ? windowObj.resetsAt - Date.now() : null;
				const resetStr = leftMs !== null && leftMs > 0 ? fmtDuration(leftMs, lang) : "—";

				return h("div", {
					key: periodKey,
					"data-window-bucket": periodKey,
					"data-window-status": "available",
					style: { display: "flex", flexDirection: "column", gap: 6 },
				},
					h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 13 } },
						h("span", { style: { fontWeight: 500, color: C.label } }, title),
						h("span", { style: { fontWeight: 600, fontFamily: "ui-monospace, monospace", color: barColor, fontSize: 14 } },
							remPct.toFixed(2) + "%"),
					),
					h("div", {
						style: {
							width: "100%",
							height: 7,
							borderRadius: 4,
							background: "var(--dsw-alias-border-l1, rgba(127,127,127,.22))",
							overflow: "hidden",
						},
					},
						h("div", {
							style: {
								height: "100%",
								width: Math.max(0, Math.min(100, remPct)) + "%",
								background: barColor,
								borderRadius: 4,
								transition: "width 0.3s ease",
							},
						})),
					h("span", { style: { fontSize: 12, color: C.sub } },
						`${Math.round(remPct)}% ${lang === "zh" ? "剩余" : "remaining"} · ${t("window.resetIn")} ${resetStr}`),
				);
			};

			const agyGroups = primary.groups && typeof primary.groups === "object" ? primary.groups : null;
			const agyAccounts = Array.isArray(overview.antigravityAccounts) ? overview.antigravityAccounts : [];

			return h("div", {
				"data-section": "quota-overview",
				style: { display: "flex", flexDirection: "column", gap: 14 },
			},
				h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
					h("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: "24px" } }, t("overview.title")),
					h("button", {
						type: "button",
						"data-action": "refresh-overview",
						style: btnStyle,
						disabled: busy,
						onClick: () => {
							loadOverview(true).catch(() => {});
							if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
								window.dispatchEvent(new Event("dsh-usage:config-updated"));
							}
						},
					}, busy ? "…" : t("overview.refresh")),
				),
				// 1. 模型监控概览网格
				h("div", {
					style: {
						...cardBoxStyle,
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
						gap: 12,
					},
				},
					h("div", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 13 } },
						h("span", { style: { color: C.sub, fontSize: 12 } }, t("overview.activeRoute")),
						h("span", { style: { fontWeight: 600 } }, `${activeRoute.provider} / ${activeRoute.model}`)),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 13 } },
						h("span", { style: { color: C.sub, fontSize: 12 } }, t("overview.monitoredModel")),
						h("span", { style: { fontWeight: 600, color: isOverride ? C.peak : C.label } },
							isOverride
								? `${t("overview.monitoringTarget")}: ${primary.displayName || primary.modelId}`
								: `${primary.displayName || primary.modelId} (${primary.modelId})`)),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 13 } },
						h("span", { style: { color: C.sub, fontSize: 12 } }, t("overview.provider")),
						h("span", { style: { fontWeight: 600 } },
							`${primary.providerDisplayName || primary.routeId} · ${primary.isProxy ? t("badge.proxy") : t("badge.official")}`)),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 13 } },
						h("span", { style: { color: C.sub, fontSize: 12 } }, t("overview.accountAlias")),
						h("span", { style: { fontWeight: 600 } }, primary.accountAlias || "default")),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 13 } },
						h("span", { style: { color: C.sub, fontSize: 12 } }, t("overview.updatedAt")),
						h("span", { style: { fontWeight: 600 } }, updatedStr + (primary.stale ? ` (${t("badge.stale")})` : ""))),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 13, alignItems: "flex-start" } },
						h("span", { style: { color: C.sub, fontSize: 12 } }, t("overview.status")),
						badgePill(
							primary.status === "ok" ? (lang === "zh" ? "正常" : "Available") : (primary.statusMessage || primary.status),
							primary.status === "ok" ? C.idle : (primary.status === "stale" ? C.peak : C.err),
							primary.status === "ok" ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)",
						)),
				),
				// 2. 按真实额度组隔离的额度卡片（参考 dsh-tool-antigravity QuotaVisualDashboard）
				agyGroups
					? h("div", {
						"data-section": "quota-groups",
						style: {
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
							gap: 12,
						},
					}, ["gemini", "non-gemini"].filter((gKey) => agyGroups[gKey]).map((gKey) => {
						const grp = agyGroups[gKey];
						const isCurrentGroup = primary.quotaGroupId === gKey;
						const w5h = (grp.windows || []).find((w) => w.key === "5h") || null;
						const w7d = (grp.windows || []).find((w) => w.key === "7d") || null;
						return h("div", {
							key: gKey,
							"data-quota-group": gKey,
							"data-active-group": isCurrentGroup ? "true" : "false",
							style: {
								...cardBoxStyle,
								borderColor: isCurrentGroup
									? "var(--dsw-alias-brand-primary, #3b82f6)"
									: "var(--dsw-alias-border-l1, rgba(127,127,127,.22))",
							},
						},
							h("div", {
								style: {
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									paddingBottom: 8,
									borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))",
								},
							},
								h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
									h("span", { style: { fontSize: 13, fontWeight: 600, letterSpacing: "0.03em" } },
										lang === "zh" ? grp.label : (grp.labelEn || grp.label)),
									h("span", { style: { fontSize: 12, color: C.sub } }, grp.description || ""),
								),
								isCurrentGroup
									? badgePill(lang === "zh" ? "当前模型所属组" : "Active Group", C.idle, "rgba(34, 197, 94, 0.12)")
									: null,
							),
							renderWindowBucket("5h", w5h),
							renderWindowBucket("7d", w7d),
						);
					}))
					: null,
				// 3. 账户列表与状态管理（参考 dsh-tool-antigravity AccountList）
				agyAccounts.length > 0
					? h("div", {
						"data-section": "account-list",
						style: cardBoxStyle,
					},
						h("div", { style: { fontSize: 15, fontWeight: 600 } }, t("overview.accountsTitle")),
						h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
							agyAccounts.map((acc) => {
								const handle = acc.handle || acc.email || "default";
								const inUse = Boolean(acc.active || acc.inUse || acc.selected);
								return h("div", {
									key: handle,
									"data-account-row": handle,
									style: {
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: 10,
										padding: "10px 14px",
										borderRadius: 8,
										border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))",
									},
								},
									h("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
										h("span", { style: { fontSize: 14, fontWeight: 500 } }, acc.email || handle),
										inUse ? badgePill(t("overview.accountInUse"), C.idle, "rgba(34, 197, 94, 0.12)") : null,
									),
									!inUse
										? h("button", {
											type: "button",
											"data-action": "switch-account",
											style: btnStyle,
											disabled: Boolean(switchingHandle),
											onClick: () => { switchAccount(handle).catch(() => {}); },
										}, t("overview.accountSwitch"))
										: null,
								);
							})),
					)
					: null,
			);
		}

		function AdvancedSettingsSection(props) {
			const t = props.t;
			const form = props.form;
			const [open, setOpen] = useState(false);
			const btnStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 13,
				height: 30,
				padding: "0 12px",
				cursor: "pointer",
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
			};
			return h("div", {
				"data-section": "advanced-settings",
				style: {
					padding: "16px 18px",
					borderRadius: 10,
					border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))",
					background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))",
					display: "flex",
					flexDirection: "column",
					gap: 12,
				},
			},
				h("div", {
					style: { display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" },
					onClick: () => setOpen((v) => !v),
				},
					h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
						h("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600, color: C.label } }, t("advanced.title")),
						h("p", { style: { margin: 0, fontSize: 13, color: C.sub } }, t("advanced.intro")),
					),
					h("button", {
						type: "button",
						style: btnStyle,
						"aria-expanded": open,
						onClick: (e) => {
							if (e && typeof e.stopPropagation === "function") e.stopPropagation();
							setOpen((v) => !v);
						},
					},
						h("span", null, open ? t("advanced.collapse") : t("advanced.expand")),
						h("span", {
							style: {
								display: "inline-block",
								transform: open ? "rotate(180deg)" : "rotate(0deg)",
								transition: "transform 0.2s ease",
							},
						}, "▾")),
				),
				h("div", {
					style: {
						display: open ? "flex" : "none",
						flexDirection: "column",
						gap: 16,
						marginTop: 4,
						paddingTop: 14,
						borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))",
					},
				},
					h(ProviderAliasesSettings, { t, form }),
					h(OAuthTokenSection, { t }),
				),
			);
		}

		function DeepSeekLegacySection(props) {
			const t = props.t;
			return h("div", {
				"data-section": "deepseek-legacy-section",
				style: {
					padding: "16px 18px",
					borderRadius: 10,
					border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))",
					background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))",
					display: "flex",
					flexDirection: "column",
					gap: 8,
				},
			},
				h("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600, color: C.label } }, t("settings.title")),
				h("p", { style: { margin: 0, fontSize: 13, color: C.sub, lineHeight: "19px" } }, t("settings.intro")),
				h("div", { style: { fontSize: 13, color: C.sub, lineHeight: "20px", marginTop: 4 } },
					t("settings.deepseekNotice"),
				),
			);
		}

		const CONFIG_ENTRY_ID = "deepseek-usage";

		function UsageConfigSection(props) {
			const t = props.t;
			const ctx = props.ctx;
			const configForms = ctx === undefined || ctx === null
				? undefined
				: (typeof ctx.get === "function" ? ctx.get("configForms") : ctx.configForms);
			const form = configForms && typeof configForms.get === "function"
				? configForms.get(CONFIG_ENTRY_ID)
				: undefined;

			// hooks 不能条件调用：没有表单时给一个永远「不可用」的只读 store。
			const fallback = useMemo(() => ({
				subscribe: () => () => {},
				getSnapshot: () => ({ status: "unavailable", value: undefined, revision: 0, writable: false }),
			}), []);
			const store = form === undefined ? fallback : form;
			const subscribe = useCallback((notify) => store.subscribe(notify), [store]);
			const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
			const snapshot = useSyncExternalStore(subscribe, getSnapshot);
			const face = form === undefined
				? undefined
				: { state: snapshot, mutate: (ops, revision) => form.mutate(ops, revision) };
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 20 } },
				// 第一部分 & 第二部分：模型监控概览与额度分组 + 账户列表（位于最顶部）
				h(UsageOverviewSection, { t, lang: currentLang(ctx), initialOverview: props.initialOverview }),
				// 第三部分：仪表盘与监控设置
				h(DisplayTargetSettings, { t, form: face }),
				// 第四部分：模型路由设置
				h(RoutingModelSettings, { t, ctx }),
				// 第五部分：高级设置（提供商映射与 OAuth 订阅令牌，默认折叠）
				h(AdvancedSettingsSection, { t, form: face }),
				// 第六部分：DeepSeek 用量（位于最下方）
				h(DeepSeekLegacySection, { t }),
			);
		}

		// 设置导航项：id 与位置（放在 Plugins 15 之后、Agent presets 20 之前）。
		const SETTINGS_SECTION_ID = "deepseek-usage";
		const SETTINGS_SECTION_ORDER = 16;
		const SETTINGS_HEADING_STYLE = { margin: 0, fontSize: 20, lineHeight: "28px", fontWeight: 700 };
		const SETTINGS_INTRO_STYLE = {
			margin: 0,
			fontSize: 13,
			lineHeight: "20px",
			color: C.sub,
		};

		/** 设置面板里的「DeepSeek 用量」页：标题 + 说明 + 配置体。 */
		function UsageSettingsSection(props) {
			const t = props.t;
			return h("div", {
				style: {
					maxWidth: 820,
					color: "var(--dsw-alias-label-primary)",
					display: "flex",
					flexDirection: "column",
					gap: 20,
				},
			},
				h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
					h("h2", { style: SETTINGS_HEADING_STYLE }, t("settings.pageHeading")),
					h("p", { style: SETTINGS_INTRO_STYLE }, t("settings.pageSubtitle")),
				),
				h(UsageConfigSection, { t, ctx: props.ctx, initialOverview: props.initialOverview }),
			);
		}

		/**
		 * 设置外壳的共享实例：设置面板把「开/关 + 当前分区」的状态放在
		 * `sidebar.settings` 槽位注册项的 store 上，`create()` 返回的就是面板在用的
		 * 那个实例（settings-general 自己重写了 create，反复调用拿到的仍是同一个）。
		 * 槽位 ledger 的 entry 把 store 句柄放在 `entry.store`（options 是渲染侧擦除
		 * 过的空壳），老版本若把它投影在 options 里也一并兼容。宿主没有设置外壳时
		 * 返回 undefined。
		 */
		function settingsShellOf(ctx) {
			try {
				const slots = ctx && ctx.slots;
				if (!slots || typeof slots.entries !== "function") return undefined;
				for (const entry of slots.entries("sidebar.settings") || []) {
					const handle = entry && (entry.store || (entry.options ? entry.options.store : undefined));
					if (handle && typeof handle.create === "function") {
						const shell = handle.create();
						if (shell) return shell;
					}
				}
			} catch (e) { /* 宿主没有设置外壳 */ }
			return undefined;
		}

		/** 能否直接跳到「DeepSeek 用量」设置页（外壳存在且支持 openSection）。 */
		function canOpenUsageSettings(ctx) {
			const actions = settingsShellOf(ctx)?.actions;
			return !!(actions && typeof actions.openSection === "function");
		}

		/** 打开设置面板并切到「DeepSeek 用量」页；不可用时返回 false。 */
		function openUsageSettings(ctx) {
			try {
				const actions = settingsShellOf(ctx)?.actions;
				if (!actions || typeof actions.openSection !== "function") return false;
				actions.openSection(SETTINGS_SECTION_ID);
				return true;
			} catch (e) {
				return false;
			}
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots", "remote", "locale"];

		function apply(ctx) {
			// 注册 i18n 词典（DSH locale 服务；不可用时组件回退中文）。
			// 用 ctx.effect 管理生命周期：插件卸载时词典随之撤销。
			try {
				if (ctx.effect && ctx.locale && typeof ctx.locale.register === "function") {
					ctx.effect(
						() => ctx.locale.register(NS, { zh: ZH, en: EN }),
						"dsh-usage: dictionaries",
					);
				} else if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.locale.register(NS, { zh: ZH, en: EN });
				}
			} catch (e) { /* 词典注册失败不影响卡片 */ }
			// 注入本包样式：footerActions 换行（卡片独占一行）。
			const tagId = "dsh-usage";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-usage";
				style.dataset.pluginCss = tagId;
				style.textContent = 'div[class*="footerActions"]{flex-wrap:wrap}';
				document.head.appendChild(style);
			}
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				// label 用函数：每次求值时按当前 DSH 语言取，切换语言后不必重新注册槽位。
				{ name: "sidebar.footer.action", id: "dsh-usage", order: 100, label: () => textOf("sidebar.label", currentLang(ctx)) },
				(props) => h(UsageCell, { wide: props.wide, ctx }),
			));
			// 设置面板的「DeepSeek 用量」页：provider 映射 + OAuth 订阅令牌。
			// 导航标题用 thunk，切换语言后重新求值；locale: NS 让页面拿到注入的 t。
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{
					name: "settings.section",
					id: SETTINGS_SECTION_ID,
					order: SETTINGS_SECTION_ORDER,
					label: () => textOf("settings.nav", currentLang(ctx)),
					locale: NS,
				},
				(props) => h(UsageSettingsSection, { ...props, ctx }),
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数透出（供 test/client-layout.test.mjs 直接做确定性断言，不必模拟计时器）。
		exports.__internals = {
			nextChange,
			isPeak,
			money,
			fmtPrice,
			currencySymbol,
			expandHolidayRanges,
			isHoliday,
			accountLead,
			percentText,
			usageWindows,
			windowLabel,
			windowBadge,
			windowHint,
			usageRatio,
			remainingColor,
			thresholdLevel,
			thresholdColor,
			formatCenterPercent,
			renderGaugeWindow,
			displayDraftOf,
			aliasDraftOf,
			parseRefs,
			uiLang,
		};
		return module.exports;
	}
});
