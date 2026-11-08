/**
 * dsh-usage — 多模型识别、额度池监控引擎与 DSH 路由管理服务 (P2 & P4)
 */

import {
  accountCapabilityOf,
  aliasableProviderIds,
  candidateRefsOf,
  canonicalProviderId,
  oauthProviderOf,
} from './accounts.js';
import {
  classifyRouteSource,
  computeQuotaPoolId,
  getProviderAdapter,
  proxyAdapterIds,
  validateEndpointUrl,
  validateEndpointUrlWithDns,
} from './adapters.js';
import { DEFAULT_MODEL, unitAt } from './pricing.js';

/** 默认 UI 展示配置 */
export const DEFAULT_DISPLAY_CONFIG = Object.freeze({
  mode: 'auto',
  fixedModelKey: '',
  selectedModelKeys: [],
  hiddenModelKeys: [],
  favoriteModelKeys: [],
  modelOrder: [],
  modelAliases: {},
  accountAliases: {},
  groupByProvider: false,
  gaugeStyle: 'd-gauge',
  percentMode: 'remaining',
  warnThreshold: 60,
  alertThreshold: 80,
  preferredPeriod: 'all',
  showModelId: true,
  showProvider: true,
  showAccountAlias: true,
  refreshIntervalMinutes: 0.5,
  localWeekStart: 'monday',
  localTimezone: 'Asia/Shanghai',
  sidebarExpanded: false,
  showDiagnostics: false,
});

/** 解包 schemastery volatile 包装对象 */
export function unwrapVolatile(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.get === 'function') {
    try {
      return raw.get();
    } catch {
      return undefined;
    }
  }
  return raw;
}

/**
 * 归一化 UI 展示配置（兼容旧配置，缺省值自动补齐）。
 */
export function normalizeDisplayConfig(raw) {
  const val = unwrapVolatile(raw);
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return { ...DEFAULT_DISPLAY_CONFIG };
  }
  const mode = ['auto', 'fixed', 'multi'].includes(val.mode) ? val.mode : 'auto';
  const gaugeStyle = ['d-gauge', 'ring', 'semicircle', 'compact', 'detailed'].includes(val.gaugeStyle)
    ? val.gaugeStyle
    : 'd-gauge';
  const percentMode = val.percentMode === 'used' ? 'used' : 'remaining';
  const warnThreshold = Number.isFinite(Number(val.warnThreshold))
    ? Math.max(1, Math.min(99, Number(val.warnThreshold)))
    : 60;
  const alertThreshold = Number.isFinite(Number(val.alertThreshold))
    ? Math.max(warnThreshold, Math.min(100, Number(val.alertThreshold)))
    : Math.max(warnThreshold, 80);
  const preferredPeriod = ['all', '5h', '1d', '7d', '30d', 'cycle'].includes(val.preferredPeriod)
    ? val.preferredPeriod
    : 'all';
  const refreshIntervalMinutes = [0.5, 5, 15, 30, 60].includes(Number(val.refreshIntervalMinutes))
    ? Number(val.refreshIntervalMinutes)
    : 0.5;
  const localWeekStart = val.localWeekStart === 'sunday' ? 'sunday' : 'monday';
  const localTimezone = typeof val.localTimezone === 'string' && val.localTimezone.trim() !== ''
    ? val.localTimezone.trim()
    : 'Asia/Shanghai';

  const cleanStrList = (arr) => (Array.isArray(arr)
    ? [...new Set(arr.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))]
    : []);

  const cleanDict = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = typeof k === 'string' ? k.trim() : '';
      if (key !== '' && !['__proto__', 'constructor', 'prototype'].includes(key) && typeof v === 'string' && v.trim() !== '') {
        out[key] = v.trim();
      }
    }
    return out;
  };

  return {
    mode,
    fixedModelKey: typeof val.fixedModelKey === 'string' ? val.fixedModelKey.trim() : '',
    selectedModelKeys: cleanStrList(val.selectedModelKeys),
    hiddenModelKeys: cleanStrList(val.hiddenModelKeys),
    favoriteModelKeys: cleanStrList(val.favoriteModelKeys),
    modelOrder: cleanStrList(val.modelOrder),
    modelAliases: cleanDict(val.modelAliases),
    accountAliases: cleanDict(val.accountAliases),
    groupByProvider: val.groupByProvider === true,
    gaugeStyle,
    percentMode,
    warnThreshold,
    alertThreshold,
    preferredPeriod,
    showModelId: val.showModelId !== false,
    showProvider: val.showProvider !== false,
    showAccountAlias: val.showAccountAlias !== false,
    refreshIntervalMinutes,
    localWeekStart,
    localTimezone,
    sidebarExpanded: val.sidebarExpanded === true,
    showDiagnostics: val.showDiagnostics === true,
  };
}

/**
 * 归一化反代路由配置 (`config.proxyRoutes`)。
 * 每项格式：{ provider, adapter, baseURL?, refs?, customQuotaPath?, accountAlias? }
 */
export function normalizeProxyRoutes(raw) {
  const val = unwrapVolatile(raw);
  const routes = new Map();
  if (!Array.isArray(val)) return routes;
  const validAdapters = new Set([...proxyAdapterIds(), ...aliasableProviderIds()]);
  for (const item of val) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
    const adapter = typeof item.adapter === 'string' ? item.adapter.trim().toLowerCase() : '';
    if (provider === '' || !validAdapters.has(adapter)) continue;
    const key = provider.toLowerCase();
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (routes.has(key)) continue;
    const baseURL = typeof item.baseURL === 'string' && item.baseURL.trim() !== '' ? item.baseURL.trim() : null;
    if (baseURL !== null && !validateEndpointUrl(baseURL, { allowLoopback: true }).ok) {
      continue;
    }
    const refs = Array.isArray(item.refs)
      ? item.refs.filter((r) => typeof r === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.trim())).map((r) => r.trim())
      : [];
    const customQuotaPath = typeof item.customQuotaPath === 'string' && item.customQuotaPath.trim().startsWith('/')
      ? item.customQuotaPath.trim()
      : null;
    const accountAlias = typeof item.accountAlias === 'string' && item.accountAlias.trim() !== ''
      ? item.accountAlias.trim()
      : null;
    routes.set(key, {
      provider,
      adapter,
      baseURL,
      refs,
      customQuotaPath,
      accountAlias,
    });
  }
  return routes;
}

/**
 * 计算本地自然周统计时间窗口（与官方重置窗口严格分离）。
 *
 * @param {number} nowMs
 * @param {{ weekStartDay?: 'monday' | 'sunday', timezone?: string }} [options]
 */
export function computeLocalWeeklyWindow(nowMs = Date.now(), options = {}) {
  const weekStartDay = options.weekStartDay === 'sunday' ? 'sunday' : 'monday';
  const timezone = typeof options.timezone === 'string' && options.timezone.trim() !== ''
    ? options.timezone.trim()
    : 'Asia/Shanghai';

  // 解析时区偏移：Asia/Shanghai / Asia/Hong_Kong 为 UTC+8，UTC 为 0，其余尝试 Intl
  let offsetMinutes = 480;
  if (timezone.toUpperCase() === 'UTC' || timezone === 'Etc/UTC') {
    offsetMinutes = 0;
  } else if (timezone !== 'Asia/Shanghai' && timezone !== 'Asia/Hong_Kong' && timezone !== 'Asia/Taipei') {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'shortOffset',
      }).formatToParts(new Date(nowMs));
      const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzPart);
      if (m) {
        const sign = m[1] === '-' ? -1 : 1;
        offsetMinutes = sign * (Number(m[2]) * 60 + Number(m[3] || 0));
      }
    } catch {
      offsetMinutes = 480;
    }
  }

  const offsetMs = offsetMinutes * 60_000;
  const shifted = new Date(nowMs + offsetMs);
  const dow = shifted.getUTCDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
  const daysSinceStart = weekStartDay === 'sunday' ? dow : (dow === 0 ? 6 : dow - 1);
  const dayStartUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const windowStartMs = dayStartUtc - daysSinceStart * 86_400_000 - offsetMs;
  const windowEndMs = windowStartMs + 7 * 86_400_000;

  return {
    windowStartMs,
    windowEndMs,
    weekStartDay,
    timezone,
    dataSource: 'local_session_stats',
  };
}

/**
 * 从 DSH Settings / ConfigEditor 读取 `llm-pi-ai` 的自定义与内置提供商配置。
 *
 * @param {any} ctx
 * @returns {{ ns: string | null, providers: Record<string, any>, writable: boolean }}
 */
export function readLlmPiAiConfig(ctx) {
  let ns = null;
  let providers = {};
  let writable = false;
  try {
    const settings = ctx.get?.('settings');
    if (settings && typeof settings.describe === 'function') {
      const descriptors = settings.describe({ redactSecrets: true }) || [];
      const hit = descriptors.find((d) => d && (d.ns === 'include:llm-pi-ai' || d.ns === 'llm-pi-ai' || String(d.ns).endsWith(':llm-pi-ai')));
      if (hit) {
        ns = hit.ns;
        writable = hit.applies === 'live';
        const val = hit.value;
        if (val && typeof val === 'object' && val.providers && typeof val.providers === 'object') {
          providers = val.providers;
        }
      }
    }
  } catch {}
  return { ns, providers, writable };
}

/**
 * 发现并构建当前 DSH 环境中的所有路由与模型身份目录（遵循 4.3 模型识别优先级）。
 *
 * 优先级：
 *   1. DSH 已有模型配置（llm-pi-ai 的 providers 配置，含自定义 baseURL / apiKeyEnv / models）
 *   2. DSH 路由映射（agentDefaultModel.currentSelection + llm.listProviders + llm.listConfigurableProviders）
 *   3. Provider Adapter / llm.listModels 返回的模型列表
 *   4. 用户自定义映射（providerAliases + proxyRoutes）
 *   5. 未知模型
 */
export async function discoverRoutesAndModels(ctx, { providerResolver, proxyRoutes = new Map(), displayConfig = DEFAULT_DISPLAY_CONFIG, toCredentialRef = (n) => n } = {}) {
  const adm = ctx.get?.('agentDefaultModel');
  const currentSel = adm && typeof adm.currentSelection === 'function'
    ? adm.currentSelection()
    : { provider: 'deepseek-official', model: DEFAULT_MODEL };
  const currentProvider = typeof currentSel?.provider === 'string' && currentSel.provider.trim() !== ''
    ? currentSel.provider.trim()
    : 'deepseek-official';
  const currentModel = typeof currentSel?.model === 'string' && currentSel.model.trim() !== ''
    ? currentSel.model.trim()
    : DEFAULT_MODEL;

  const { ns: llmPiAiNs, providers: piAiProviders, writable: settingsWritable } = readLlmPiAiConfig(ctx);

  const registeredMap = new Map();
  const configurableMap = new Map();
  const llm = ctx.get?.('llm');

  if (llm) {
    try {
      if (typeof llm.listProviders === 'function') {
        for (const p of llm.listProviders() || []) {
          if (p && typeof p.id === 'string') registeredMap.set(p.id, p);
        }
      }
    } catch {}
    try {
      if (typeof llm.listConfigurableProviders === 'function') {
        for (const c of llm.listConfigurableProviders() || []) {
          if (c && typeof c.provider === 'string') configurableMap.set(c.provider, c);
        }
      }
    } catch {}
  }

  // 汇总所有已知 routeId
  const routeIds = new Set([
    ...registeredMap.keys(),
    ...Object.keys(piAiProviders || {}),
    ...(currentProvider ? [currentProvider] : []),
  ]);

  const routes = [];
  const modelsByKey = new Map();

  for (const routeId of routeIds) {
    if (!routeId || typeof routeId !== 'string') continue;
    const reg = registeredMap.get(routeId);
    const conf = configurableMap.get(routeId);
    const piCfg = piAiProviders?.[routeId] ?? null;
    const proxyCfg = proxyRoutes.get(routeId.toLowerCase()) ?? null;
    const aliasRes = providerResolver ? providerResolver.resolve(routeId) : null;

    const baseURL = proxyCfg?.baseURL ?? piCfg?.baseURL ?? conf?.defaultBaseURL ?? null;
    const defaultBaseURL = conf?.defaultBaseURL ?? null;
    const apiProtocol = piCfg?.api ?? null;

    // 确定使用的适配器 ID
    let capabilityId = null;
    if (proxyCfg) {
      capabilityId = proxyCfg.adapter;
    } else if (aliasRes) {
      capabilityId = aliasRes.capabilityId;
    } else {
      const cap = accountCapabilityOf(routeId);
      if (cap) capabilityId = cap.id;
    }

    const sourceClass = classifyRouteSource(routeId, baseURL, capabilityId);
    const isProxy = Boolean(proxyCfg) || sourceClass.isProxy;
    const sourceType = isProxy ? 'proxy' : sourceClass.sourceType;

    // 确定候选凭据引用：DSH 路由显式配置的 apiKeyEnv 优先，其次用户映射/反代配置，再次派生引用与默认引用
    const derivedKeyRef = `${String(routeId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
    const candidateRefs = [
      ...(typeof piCfg?.apiKeyEnv === 'string' && piCfg.apiKeyEnv.trim() !== '' ? [piCfg.apiKeyEnv.trim()] : []),
      ...(proxyCfg?.refs ?? []),
      ...(aliasRes?.refs ?? []),
      ...(Array.isArray(conf?.nativeAuth?.env) ? conf.nativeAuth.env : []),
      derivedKeyRef,
    ];
    const uniqueRefs = [...new Set(candidateRefs.filter((r) => typeof r === 'string' && r.trim() !== ''))];
    const primaryKeyRef = uniqueRefs[0] ?? null;

    // 检查凭据配置状态（只调用 describe 或检查存在性，不暴露明文）
    let credentialConfigured = false;
    let credentialSource = null;
    if (capabilityId === 'deepseek-account') {
      try {
        if (typeof ctx.credentials?.describeRecord === 'function') {
          const info = await ctx.credentials.describeRecord('deepseek-account-platform/default');
          credentialConfigured = Boolean(info?.configured);
          credentialSource = 'deepseek-account';
        } else if (typeof ctx.credentials?.readRecord === 'function') {
          const rec = await ctx.credentials.readRecord('deepseek-account-platform/default');
          credentialConfigured = Boolean(rec?.payload?.token);
          credentialSource = 'deepseek-account';
        }
      } catch {}
    } else if (capabilityId && oauthProviderOf(capabilityId)) {
      const spec = oauthProviderOf(capabilityId);
      try {
        if (typeof ctx.credentials?.describe === 'function') {
          const info = await ctx.credentials.describe(toCredentialRef(spec.tokenRef));
          credentialConfigured = Boolean(info?.configured);
          credentialSource = info?.source ?? 'oauth';
        } else if (typeof ctx.credentials?.resolve === 'function') {
          const hit = await ctx.credentials.resolve(toCredentialRef(spec.tokenRef));
          credentialConfigured = Boolean(hit?.value);
          credentialSource = hit?.source ?? 'oauth';
        }
      } catch {}
    } else {
      for (const ref of uniqueRefs) {
        try {
          if (typeof ctx.credentials?.describe === 'function') {
            const info = await ctx.credentials.describe(toCredentialRef(ref));
            if (info?.configured) {
              credentialConfigured = true;
              credentialSource = ref;
              break;
            }
          } else if (typeof ctx.credentials?.resolve === 'function') {
            const hit = await ctx.credentials.resolve(toCredentialRef(ref));
            if (hit?.value) {
              credentialConfigured = true;
              credentialSource = ref;
              break;
            }
          }
        } catch {}
      }
    }

    const adapter = capabilityId ? getProviderAdapter(capabilityId) : null;
    const providerDisplayName = piCfg?.displayName
      || reg?.name
      || conf?.displayName
      || adapter?.displayName
      || routeId;

    // 收集该路由下的模型列表（1. llm.listModels → 2. piAiProviders.models → 3. 当前选中模型兜底）
    const routeModels = [];
    const seenModelIds = new Set();
    const pushModel = (m) => {
      if (!m || typeof m.id !== 'string' || m.id.trim() === '') return;
      const id = m.id.trim();
      if (seenModelIds.has(id)) return;
      seenModelIds.add(id);
      routeModels.push({
        id,
        name: typeof m.name === 'string' && m.name.trim() !== '' ? m.name.trim() : id,
        contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
        maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : null,
      });
    };

    if (llm && typeof llm.listModels === 'function' && registeredMap.has(routeId)) {
      try {
        const listed = await llm.listModels(routeId);
        for (const m of listed || []) pushModel(m);
      } catch {}
    }
    if (Array.isArray(piCfg?.models)) {
      for (const m of piCfg.models) pushModel(m);
    }
    if (routeId === currentProvider && currentModel) {
      pushModel({ id: currentModel, name: currentModel });
    }
    if (routeModels.length === 0) {
      // 若路由未暴露模型目录，提供一个默认代表模型项以便账户级监控
      const fallbackModelId = routeId.startsWith('deepseek') ? DEFAULT_MODEL : 'default';
      pushModel({ id: fallbackModelId, name: providerDisplayName });
    }

    const accountAlias = displayConfig.accountAliases?.[routeId]
      ?? proxyCfg?.accountAlias
      ?? credentialSource
      ?? null;

    routes.push({
      routeId,
      displayName: providerDisplayName,
      sourceType,
      isProxy,
      apiProtocol,
      baseURL,
      defaultBaseURL,
      apiKeyRef: credentialSource ?? primaryKeyRef,
      candidateRefs: uniqueRefs,
      credentialConfigured,
      credentialSource,
      capabilityId,
      customQuotaPath: proxyCfg?.customQuotaPath ?? null,
      accountAlias,
      models: routeModels,
    });

    for (const m of routeModels) {
      const key = `${routeId}/${m.id}`;
      const alias = displayConfig.modelAliases?.[key] ?? null;
      modelsByKey.set(key, {
        key,
        providerId: capabilityId || routeId,
        routeId,
        modelId: m.id,
        displayName: alias || m.name || m.id,
        alias,
        providerDisplayName,
        sourceType,
        isProxy,
        baseURL,
        accountAlias,
        credentialRef: credentialSource ?? primaryKeyRef,
        candidateRefs: uniqueRefs,
        customQuotaPath: proxyCfg?.customQuotaPath ?? null,
        favorite: displayConfig.favoriteModelKeys.includes(key),
        hidden: displayConfig.hiddenModelKeys.includes(key),
      });
    }
  }

  return {
    currentDefault: {
      provider: currentProvider,
      model: currentModel,
      reasoningEffort: currentSel?.reasoningEffort ?? null,
    },
    llmPiAiNs,
    writable: settingsWritable || Boolean(ctx.get?.('configEditor')),
    routes,
    modelsByKey,
  };
}

/**
 * 根据 UI Display Target 配置选出本次需要监控和展示的目标模型列表。
 */
export function selectTargetModels(discovery, displayConfig = DEFAULT_DISPLAY_CONFIG) {
  const { currentDefault, modelsByKey } = discovery;
  const activeKey = `${currentDefault.provider}/${currentDefault.model}`;

  const ensureModelIdentity = (key) => {
    if (modelsByKey.has(key)) return modelsByKey.get(key);
    const slash = key.indexOf('/');
    const routeId = slash === -1 ? currentDefault.provider : key.slice(0, slash);
    const modelId = slash === -1 ? key : key.slice(slash + 1);
    const cap = accountCapabilityOf(routeId);
    const sourceClass = classifyRouteSource(routeId, null, cap?.id);
    return {
      key: `${routeId}/${modelId}`,
      providerId: cap?.id ?? routeId,
      routeId,
      modelId,
      displayName: displayConfig.modelAliases?.[`${routeId}/${modelId}`] || modelId,
      alias: displayConfig.modelAliases?.[`${routeId}/${modelId}`] ?? null,
      providerDisplayName: cap?.displayName ?? routeId,
      sourceType: sourceClass.sourceType,
      isProxy: sourceClass.isProxy,
      baseURL: null,
      accountAlias: displayConfig.accountAliases?.[routeId] ?? null,
      credentialRef: null,
      candidateRefs: candidateRefsOf(cap?.id ?? routeId),
      customQuotaPath: null,
      favorite: displayConfig.favoriteModelKeys.includes(`${routeId}/${modelId}`),
      hidden: false,
    };
  };

  if (displayConfig.mode === 'fixed' && displayConfig.fixedModelKey) {
    return [ensureModelIdentity(displayConfig.fixedModelKey)];
  }

  if (displayConfig.mode === 'multi' && displayConfig.selectedModelKeys.length > 0) {
    const hiddenSet = new Set(displayConfig.hiddenModelKeys);
    const orderMap = new Map(displayConfig.modelOrder.map((k, idx) => [k, idx]));
    const favSet = new Set(displayConfig.favoriteModelKeys);

    const list = displayConfig.selectedModelKeys
      .filter((k) => !hiddenSet.has(k))
      .map((k) => ensureModelIdentity(k));

    list.sort((a, b) => {
      // 常用模型优先，其次按用户自定义排序
      const favA = favSet.has(a.key) ? 0 : 1;
      const favB = favSet.has(b.key) ? 0 : 1;
      if (favA !== favB) return favA - favB;
      const ordA = orderMap.has(a.key) ? orderMap.get(a.key) : 9999;
      const ordB = orderMap.has(b.key) ? orderMap.get(b.key) : 9999;
      if (ordA !== ordB) return ordA - ordB;
      return a.key.localeCompare(b.key);
    });

    if (list.length > 0) return list;
  }

  // 默认 auto 模式：展示当前 DSH 实际使用的模型
  return [ensureModelIdentity(activeKey)];
}

/**
 * 并发受控执行器（避免多模型同时刷新触发瞬时风暴）。
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 通过 DSH 官方 API 修改默认模型或路由配置（绝不篡改未知内部文件）。
 */
export async function mutateRoutingConfig(ctx, payload, { lookupImpl } = {}) {
  const action = payload?.action;

  // 动作 1：切换当前默认模型（通过官方 agentDefaultModel.saveSelection）
  if (action === 'selectDefaultModel') {
    const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    if (provider === '' || model === '') {
      return { ok: false, error: 'invalid_params', message: 'provider and model are required' };
    }
    const adm = ctx.get?.('agentDefaultModel');
    if (!adm || typeof adm.saveSelection !== 'function') {
      return { ok: false, error: 'readonly', readonly: true, message: 'agentDefaultModel service is not writable' };
    }
    const next = {
      provider,
      model,
      ...(typeof payload.reasoningEffort === 'string' && payload.reasoningEffort.trim() !== ''
        ? { reasoningEffort: payload.reasoningEffort.trim() }
        : {}),
    };
    await adm.saveSelection(next);
    return { ok: true, selected: next };
  }

  // 动作 2：更新或新增 llm-pi-ai 中的提供商路由（BaseURL / apiKeyEnv / models）
  if (action === 'configureRoute') {
    const routeId = typeof payload.routeId === 'string' ? payload.routeId.trim() : '';
    if (routeId === '' || /\s/.test(routeId) || routeId.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(routeId)) {
      return { ok: false, error: 'invalid_route', message: 'Invalid routeId' };
    }
    const baseURL = typeof payload.baseURL === 'string' && payload.baseURL.trim() !== ''
      ? payload.baseURL.trim()
      : null;
    if (baseURL !== null) {
      const check = await validateEndpointUrlWithDns(baseURL, { allowLoopback: true, lookupImpl });
      if (!check.ok) {
        return { ok: false, error: 'invalid_url', message: `Unsafe or invalid Base URL (${check.reason})` };
      }
    }
    const apiKeyRef = typeof payload.apiKeyRef === 'string' && payload.apiKeyRef.trim() !== ''
      ? payload.apiKeyRef.trim()
      : null;
    if (apiKeyRef !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyRef)) {
      return { ok: false, error: 'invalid_ref', message: 'Invalid API key reference name' };
    }
    const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : null;
    if (modelId !== null && (modelId === '' || ['__proto__', 'constructor', 'prototype'].includes(modelId))) {
      return { ok: false, error: 'invalid_model', message: 'Invalid modelId' };
    }

    const { ns, providers: piAiProviders } = readLlmPiAiConfig(ctx);
    const settings = ctx.get?.('settings');
    if (!ns || !settings || typeof settings.mutate !== 'function') {
      return {
        ok: false,
        error: 'readonly',
        readonly: true,
        message: 'Host settings service does not support live route mutation',
      };
    }

    const ops = [];
    if (baseURL !== null) {
      ops.push({ op: 'set', path: ['providers', routeId, 'baseURL'], value: baseURL });
    }
    if (apiKeyRef !== null) {
      ops.push({ op: 'set', path: ['providers', routeId, 'apiKeyEnv'], value: apiKeyRef });
    }
    if (typeof payload.displayName === 'string' && payload.displayName.trim() !== '') {
      ops.push({ op: 'set', path: ['providers', routeId, 'displayName'], value: payload.displayName.trim() });
    }
    if (['openai-completions', 'openai-responses', 'anthropic-messages'].includes(payload.apiProtocol)) {
      ops.push({ op: 'set', path: ['providers', routeId, 'api'], value: payload.apiProtocol });
    }
    if (modelId !== null && modelId !== '') {
      const mId = modelId;
      const existingModels = Array.isArray(piAiProviders?.[routeId]?.models)
        ? [...piAiProviders[routeId].models]
        : [];
      const idx = existingModels.findIndex((m) => m && m.id === mId);
      const nextModel = { id: mId, name: payload.modelName || mId };
      if (idx >= 0) {
        existingModels[idx] = { ...existingModels[idx], ...nextModel };
      } else {
        existingModels.push(nextModel);
      }
      ops.push({
        op: 'set',
        path: ['providers', routeId, 'models'],
        value: existingModels,
      });
    }

    if (ops.length > 0) {
      await settings.mutate(ns, ops);
    }
    return { ok: true, routeId };
  }

  // 动作 3：切换 Antigravity 账号池中的当前激活账号（仅调用官方 antigravityAuth.selectAccount，绝不改动 DSH 路由）
  if (action === 'switchAntigravityAccount') {
    const handle = typeof payload.handle === 'string' ? payload.handle.trim() : '';
    if (handle === '') {
      return { ok: false, error: 'invalid_handle', message: 'Account handle is required' };
    }
    const agyService = ctx.get?.('antigravityAuth');
    if (!agyService || typeof agyService.selectAccount !== 'function') {
      return { ok: false, error: 'unsupported', message: 'Antigravity multi-account service is not available' };
    }
    const res = await agyService.selectAccount(handle);
    if (res?.state === 'selected') {
      return { ok: true, state: 'selected', handle };
    }
    return { ok: false, error: res?.state || 'failed', message: 'Failed to switch Antigravity account' };
  }

  return { ok: false, error: 'unknown_action', message: 'Unsupported routing action' };
}

/**
 * 测试目标模型路由可用性。
 */
export async function testRouteConnectivity(ctx, { provider, model }) {
  const p = typeof provider === 'string' ? provider.trim() : '';
  const m = typeof model === 'string' ? model.trim() : '';
  if (p === '') {
    return { ok: false, status: 'invalid', message: 'Provider is required' };
  }
  const llm = ctx.get?.('llm');
  if (!llm) {
    return { ok: false, status: 'unavailable', message: 'Host LLM service is not available' };
  }
  try {
    if (typeof llm.resolveModelInfo === 'function' && m !== '') {
      const info = await llm.resolveModelInfo(p, m, AbortSignal.timeout(10_000));
      return {
        ok: true,
        status: 'ok',
        provider: p,
        model: info?.id ?? m,
        contextWindow: info?.context?.contextWindow ?? null,
      };
    }
    if (typeof llm.listModels === 'function') {
      const list = await llm.listModels(p);
      const hit = m === '' ? list[0] : list.find((item) => item.id === m);
      if (hit || list.length > 0) {
        return {
          ok: true,
          status: 'ok',
          provider: p,
          model: hit?.id ?? m,
          modelCount: list.length,
        };
      }
    }
    return { ok: false, status: 'not_found', message: 'Route or model not found in active LLM registry' };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      message: error instanceof Error ? error.message.slice(0, 120) : 'Route validation failed',
    };
  }
}
