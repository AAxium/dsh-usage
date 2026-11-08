/**
 * dsh-usage — 统一 Provider Adapter 与额度归一化层 (P1)
 *
 * 职责：
 *   1. 为每个官方提供商与反向代理提供显式能力声明 (ProviderCapabilities)
 *   2. 严格区分「支持模型调用」与「支持额度查询」
 *   3. 统一转换 QuotaInfo / QuotaWindow / QuotaPool 标准数据模型
 *   4. 对自定义 Base URL 执行 SSRF 安全校验
 *   5. 绝不伪造 0% / 100% 或估算总额度
 */

import { validateEndpointUrl, validateEndpointUrlWithDns, safeFetch, readBoundedText } from './network.js';
export { validateEndpointUrl, validateEndpointUrlWithDns } from './network.js';
import {
  ACCOUNT_EMPTY,
  ACCOUNT_SHAPE,
  ACCOUNT_UNAVAILABLE,
  accountCapabilityOf,
  candidateRefsOf,
  canonicalProviderId,
  makeAccountReader,
  parseLiteLlmKeyInfo,
  parseOneApiTokenUsage,
  resolveAntigravityQuotaGroup,
} from './accounts.js';

/** 官方已知域名表：用于识别路由 Base URL 是否指向官方源还是第三方反代。 */
export const OFFICIAL_HOST_PATTERNS = {
  'deepseek-official': ['api.deepseek.com'],
  'deepseek-account': ['api.deepseek.com'],
  deepseek: ['api.deepseek.com'],
  moonshotai: ['api.moonshot.ai', 'api.moonshot.cn'],
  'kimi-coding': ['api.kimi.com'],
  zai: ['api.z.ai', 'open.bigmodel.cn'],
  'zai-coding': ['api.z.ai', 'open.bigmodel.cn'],
  openrouter: ['openrouter.ai'],
  opencode: ['opencode.ai'],
  'opencode-go': ['opencode.ai'],
  minimax: ['www.minimax.io', 'api.minimax.io', 'api.minimax.chat'],
  'minimax-cn': ['api.minimaxi.com', 'api.minimax.chat'],
  anthropic: ['api.anthropic.com'],
  'openai-codex': ['chatgpt.com', 'api.openai.com'],
  openai: ['api.openai.com'],
  siliconflow: ['api.siliconflow.cn', 'api.siliconflow.com'],
  google: ['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'],
  dashscope: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
  qwen: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
  volcengine: ['ark.cn-beijing.volces.com', 'open.volcengineapi.com'],
  doubao: ['ark.cn-beijing.volces.com', 'open.volcengineapi.com'],
};

/**
 * 脱敏账户标识（用于诊断信息展示，绝不暴露完整 Token、Key 或敏感邮箱全称）。
 */
export function maskAccountId(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'default';
  const s = raw.trim();
  const at = s.indexOf('@');
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}***@${domain}`;
  }
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}***${s.slice(-3)}`;
}

/**
 * 判断一个路由配置属于官方源还是反向代理（绝不仅凭模型名判断）。
 *
 * @param {string} providerId
 * @param {string | null | undefined} baseURL
 * @param {string | null | undefined} resolvedCapabilityId
 * @returns {{ isProxy: boolean, sourceType: 'official' | 'proxy' | 'oauth' | 'account' | 'unknown', host: string | null }}
 */
export function classifyRouteSource(providerId, baseURL, resolvedCapabilityId = null) {
  const id = canonicalProviderId(providerId || '');
  const capId = canonicalProviderId(resolvedCapabilityId || id);
  if (capId === 'deepseek-account') {
    return { isProxy: false, sourceType: 'account', host: 'api.deepseek.com' };
  }
  if (capId === 'anthropic' || capId === 'openai-codex') {
    if (!baseURL || baseURL.trim() === '') {
      return { isProxy: false, sourceType: 'oauth', host: null };
    }
  }
  if (typeof baseURL === 'string' && baseURL.trim() !== '') {
    try {
      const u = new URL(baseURL.trim());
      const host = u.hostname.toLowerCase();
      const officialHosts = OFFICIAL_HOST_PATTERNS[capId] ?? OFFICIAL_HOST_PATTERNS[id] ?? [];
      if (officialHosts.length > 0 && officialHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        return {
          isProxy: false,
          sourceType: capId === 'anthropic' || capId === 'openai-codex' ? 'oauth' : 'official',
          host,
        };
      }
      // 自定义了非官方域名的 baseURL → 明确判定为反向代理
      return { isProxy: true, sourceType: 'proxy', host };
    } catch {
      return { isProxy: true, sourceType: 'proxy', host: null };
    }
  }
  const entry = accountCapabilityOf(capId);
  if (entry !== null) {
    if (entry.kind === 'oauth') return { isProxy: false, sourceType: 'oauth', host: null };
    return { isProxy: false, sourceType: 'official', host: null };
  }
  return { isProxy: false, sourceType: 'unknown', host: null };
}

/** 将毫秒时间戳格式化为带明确 UTC 时区（或 +08:00）的 ISO 字符串。 */
export function toIsoWithTimezone(ms, timezone = 'UTC') {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  if (timezone === 'Asia/Shanghai' || timezone === 'Asia/Hong_Kong') {
    const d = new Date(ms + 8 * 3600_000);
    return d.toISOString().replace('Z', '+08:00');
  }
  return new Date(ms).toISOString();
}

/**
 * 计算共享额度池 ID (quotaPoolId)。
 *
 * 规则：
 *   - 同一个 provider 能力条目 + 同一把凭据引用（或 accountId）+ 同一个源（官方或同一反代 origin）
 *     下的所有模型共享同一个账户额度池。
 *   - 若无凭据引用且无法确认账户边界，标记 sharingMode = 'unknown'。
 */
export function computeQuotaPoolId({
  providerId,
  capabilityId,
  routeId,
  credentialRef = null,
  accountId = null,
  baseURL = null,
  quotaGroupId = null,
  isProxy = false,
}) {
  // 若实际路由是反向代理，绝不允许因模型名含 gemini/claude 而伪造进官方额度池
  const rawCap = isProxy && (!capabilityId || capabilityId === 'google' || capabilityId === 'google-antigravity' || capabilityId === 'anthropic')
    ? (routeId || 'proxy')
    : (capabilityId || providerId || routeId || 'unknown');
  const cap = canonicalProviderId(rawCap);
  let hostPart = isProxy ? 'proxy' : 'official';
  if (typeof baseURL === 'string' && baseURL.trim() !== '') {
    try {
      hostPart = new URL(baseURL.trim()).origin.toLowerCase();
    } catch {
      hostPart = baseURL.trim().toLowerCase();
    }
  }
  const credPart = accountId || credentialRef || null;
  const groupSuffix = quotaGroupId ? `:group:${quotaGroupId}` : '';

  if (cap === 'deepseek-account' && !isProxy) {
    return {
      quotaPoolId: `pool:deepseek-account:default:${credPart || 'default'}`,
      sharingMode: 'confirmed',
    };
  }
  if (credPart !== null && credPart !== '') {
    return {
      quotaPoolId: `pool:${cap}:${hostPart}:${credPart}${groupSuffix}`,
      sharingMode: 'confirmed',
    };
  }
  const entry = accountCapabilityOf(cap);
  if (entry && entry.kind !== 'none' && !isProxy) {
    const defaultRef = entry.tokenRef ?? (Array.isArray(entry.refs) && entry.refs[0]) ?? cap;
    return {
      quotaPoolId: `pool:${cap}:${hostPart}:${defaultRef}${groupSuffix}`,
      sharingMode: 'confirmed',
    };
  }
  return {
    quotaPoolId: `pool:unknown:${routeId || cap}:${hostPart}${groupSuffix}`,
    sharingMode: 'unknown',
  };
}

/**
 * 构建统一额度身份契约 `QuotaIdentity` 与可验证归属诊断信息（C3 / C4 / C6 / C7）。
 *
 * 严格遵循 5 级归属优先级：
 *   1. 额度 API 显式返回的模型或额度池/组标识 (`explicit_api_pool`)
 *   2. 可信 Provider Adapter 中定义的正式模型组映射 (`provider_model_registry`)
 *   3. DSH 真实路由的 Provider 与 resolvedModelId (`route_provider_model`)
 *   4. 已验证的账户级共享额度关系 (`account_shared_pool`)
 *   5. 用户手动选择的监控目标 (`user_selected_target`，标记 `isMonitoringOverride = true`)
 */
export function buildQuotaIdentity({
  providerId,
  accountId = 'default',
  routeId = '',
  requestedModelId = '',
  resolvedModelId = '',
  activeRouteProvider = '',
  activeRouteModel = '',
  quotaGroupId = null,
  quotaPoolId = '',
  sourceType = 'official',
  isProxy = false,
  matchBasis = null,
  ambiguous = false,
  sharedQuotaPool = false,
}) {
  const effectiveModelId = resolvedModelId || requestedModelId || '';
  const isMonitoringOverride = Boolean(
    (activeRouteProvider && routeId && activeRouteProvider !== routeId) ||
    (activeRouteModel && effectiveModelId && activeRouteModel !== effectiveModelId),
  );

  let basis = matchBasis;
  if (!basis) {
    if (ambiguous) basis = 'unrecognized_model';
    else if (quotaGroupId) basis = 'provider_model_registry';
    else if (isMonitoringOverride) basis = 'user_selected_target';
    else if (sharedQuotaPool) basis = 'account_shared_pool';
    else basis = 'route_provider_model';
  }

  return {
    providerId: String(providerId || routeId || 'unknown'),
    accountId: maskAccountId(String(accountId || 'default')),
    routeId: String(routeId || providerId || ''),
    requestedModelId: String(requestedModelId || effectiveModelId),
    resolvedModelId: String(effectiveModelId),
    quotaGroupId: quotaGroupId ?? null,
    quotaPoolId: String(quotaPoolId || ''),
    sourceType: isProxy ? 'proxy' : sourceType,
    matchBasis: basis,
    ambiguous: Boolean(ambiguous),
    sharedQuotaPool: Boolean(sharedQuotaPool),
    isMonitoringOverride,
  };
}

/**
 * 把底层 accounts.js 的 { ok, balance, usage, code } 结果标准化为 P1 契约对象。
 */
export function normalizeToQuotaContract({
  rawResult,
  capabilityId,
  quotaPoolId,
  dataSource = 'official_api',
  timezone = 'UTC',
}) {
  if (!rawResult || !rawResult.ok) {
    const code = rawResult?.code ?? 'empty';
    let status = 'failed';
    if (code === 'noKey' || code === 'accountNoKey' || code === 'accountNoToken' || code === 'accountNoGrant') {
      status = 'unconfigured';
    } else if (code === 'unauthorized') {
      status = 'unauthorized';
    } else if (code === 'accountNoApi' || code === 'proxy_unsupported' || code === 'unsupported') {
      status = 'unsupported';
    } else if (code === 'unavailable') {
      status = 'unavailable';
    } else if (code === 'rate_limited') {
      status = 'rate_limited';
    } else if (code === 'ambiguous_group') {
      status = 'unknown';
    }
    return {
      ok: false,
      status,
      code,
      quotaType: 'none',
      unit: 'unknown',
      dataSource: 'none',
      confidence: 'unknown',
      balance: null,
      usage: null,
      quotaInfo: null,
      quotaGroupId: rawResult?.quotaGroupId ?? null,
      groups: rawResult?.groups ?? null,
      ambiguous: Boolean(rawResult?.ambiguous),
      matchBasis: rawResult?.matchBasis ?? null,
    };
  }

  const hasBalance = rawResult.balance !== null && rawResult.balance !== undefined && rawResult.balance.total !== null;
  const rawWindows = Array.isArray(rawResult.usage?.windows) ? rawResult.usage.windows : [];
  const hasWindows = rawWindows.length > 0;
  const quotaGroupId = rawResult.quotaGroupId ?? rawResult.usage?.quotaGroupId ?? null;
  const missingWindows = Array.isArray(rawResult.usage?.missingWindows) ? rawResult.usage.missingWindows : [];

  const windows = rawWindows.map((w) => {
    const usedPct = typeof w.percent === 'number' && Number.isFinite(w.percent)
      ? Math.max(0, Math.min(100, w.percent))
      : null;
    const remPct = usedPct !== null ? Math.max(0, Math.min(100, 100 - usedPct)) : null;
    const remFrac = remPct !== null ? remPct / 100 : null;
    const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null;
    const key = w.key || 'cycle';
    const windowKind = w.windowKind ?? (key === '5h' ? '5h' : (key === '7d' || key === '7d-opus' ? 'weekly' : (key === '1d' ? 'daily' : (key === '30d' ? 'monthly' : 'custom'))));
    return {
      windowId: w.windowId || `${quotaPoolId}:${key}`,
      windowKind,
      key,
      label: key,
      quotaGroupId: w.quotaGroupId ?? quotaGroupId,
      quotaType: 'subscription_window',
      unit: typeof w.total === 'number' ? 'USD' : 'percent',
      total: typeof w.total === 'number' ? w.total : null,
      used: typeof w.used === 'number' ? w.used : null,
      remaining: typeof w.remaining === 'number' ? w.remaining : null,
      usedPercent: usedPct,
      remainingPercent: remPct,
      remainingFraction: remFrac,
      resetsAt,
      resetAt: toIsoWithTimezone(resetsAt, timezone),
      resetAtIso: toIsoWithTimezone(resetsAt, timezone),
      timezone,
      source: w.source || (dataSource === 'official_api' ? 'official' : 'provider'),
      status: w.status || 'available',
      dataSource,
      modelScope: w.key === '7d-opus' ? 'claude-opus' : (quotaGroupId || null),
    };
  });

  const currency = rawResult.balance?.currency ?? (hasBalance ? 'CNY' : null);
  let quotaType = 'none';
  if (hasBalance && hasWindows) quotaType = 'mixed';
  else if (hasWindows) quotaType = 'subscription_window';
  else if (hasBalance) quotaType = 'balance';

  const unit = hasBalance
    ? (currency || 'CNY')
    : (hasWindows ? 'percent' : 'unknown');

  // 对于纯充值余额（如 DeepSeek / Moonshot / SiliconFlow），总额度上限为 null，严禁伪造进度环
  const total = typeof rawResult.granted === 'number'
    ? rawResult.granted
    : (typeof rawResult.total === 'number' ? rawResult.total : null);
  const used = typeof rawResult.used === 'number' ? rawResult.used : null;
  const remaining = hasBalance
    ? rawResult.balance.total
    : (typeof rawResult.remaining === 'number' ? rawResult.remaining : null);

  const primaryResetAt = windows.find((w) => w.resetsAt !== null)?.resetsAt
    ?? (typeof rawResult.resetsAt === 'number' ? rawResult.resetsAt : null);

  const quotaInfo = {
    quotaPoolId,
    quotaGroupId,
    quotaType,
    unit,
    currency,
    total,
    used,
    remaining,
    unlimited: rawResult.unlimited === true,
    resetAt: primaryResetAt,
    resetAtIso: toIsoWithTimezone(primaryResetAt, timezone),
    timezone,
    windows,
    missingWindows,
    groups: rawResult.groups ?? rawResult.usage?.groups ?? null,
  };

  return {
    ok: true,
    status: 'ok',
    code: null,
    quotaType,
    unit,
    dataSource,
    confidence: 'high',
    balance: rawResult.balance,
    usage: hasWindows
      ? {
        plan: rawResult.usage?.plan ?? null,
        quotaGroupId,
        groupLabel: rawResult.usage?.groupLabel ?? null,
        groupDescription: rawResult.usage?.groupDescription ?? null,
        missingWindows,
        windows,
        groups: rawResult.groups ?? rawResult.usage?.groups ?? null,
      }
      : null,
    quotaInfo,
    quotaGroupId,
    groups: rawResult.groups ?? rawResult.usage?.groups ?? null,
    ambiguous: false,
    matchBasis: rawResult.matchBasis ?? null,
  };
}

/**
 * 解析 OneAPI / NewAPI 兼容的 `/v1/dashboard/billing/subscription` + `/v1/dashboard/billing/usage`
 */
export function parseOpenAiBillingCompat(subBody, usageBody = null) {
  if (subBody === null || typeof subBody !== 'object') {
    return { ok: false, balance: null, usage: null, code: ACCOUNT_SHAPE };
  }
  const hardLimit = Number(subBody.hard_limit_usd ?? subBody.system_hard_limit_usd);
  if (!Number.isFinite(hardLimit) || hardLimit < 0) {
    return { ok: false, balance: null, usage: null, code: ACCOUNT_SHAPE };
  }
  // OneAPI 无限额度通常返回 >= 100000000 USD
  const unlimited = hardLimit >= 1e8;
  let usedUsd = 0;
  if (usageBody && typeof usageBody === 'object' && Number.isFinite(Number(usageBody.total_usage))) {
    // OpenAI billing usage 单位为美分 (cents)，即 total_usage / 100 = USD
    usedUsd = Math.max(0, Number(usageBody.total_usage) / 100);
  }
  const remaining = unlimited ? null : Math.max(0, hardLimit - usedUsd);
  const resetsAt = Number.isFinite(Number(subBody.access_until)) && Number(subBody.access_until) > 0
    ? Number(subBody.access_until) * 1000
    : null;

  const balance = remaining !== null
    ? { isAvailable: true, total: remaining, currency: 'USD' }
    : null;
  const windows = [];
  if (!unlimited && hardLimit > 0) {
    const percent = Math.max(0, Math.min(100, (usedUsd / hardLimit) * 100));
    windows.push({
      key: 'cycle',
      percent,
      resetsAt,
      total: hardLimit,
      used: usedUsd,
      remaining,
    });
  }
  if (balance === null && windows.length === 0 && !unlimited) {
    return { ok: false, balance: null, usage: null, code: ACCOUNT_EMPTY };
  }
  return {
    ok: true,
    balance,
    usage: windows.length > 0 ? { plan: subBody.plan?.title ?? null, windows } : null,
    unlimited,
    granted: unlimited ? null : hardLimit,
    used: usedUsd,
    remaining,
    resetsAt,
  };
}

/**
 * 执行反向代理（OneAPI / NewAPI / LiteLLM / Custom）的额度查询。
 *
 * 原则：
 *   - 绝不扫描未知管理后台接口；
 *   - 只请求用户显式选择的适配器对应的标准令牌额度端点；
 *   - 若未指定已知反代类型或返回非预期结构，返回 `proxy_unsupported`（界面显示“不支持查询”）。
 */
export async function queryProxyAdapter({
  proxyType,
  baseURL,
  secret,
  customQuotaPath = null,
  fetchImpl = safeFetch,
  timeoutMs = 15000,
  maxBodyBytes = 64 * 1024,
  allowLoopback = true,
}) {
  const validated = validateEndpointUrl(baseURL || '', { allowLoopback });
  if (!validated.ok) {
    return { ok: false, balance: null, usage: null, code: 'invalid_url', reason: validated.reason };
  }
  if (typeof secret !== 'string' || secret.trim() === '') {
    return { ok: false, balance: null, usage: null, code: 'accountNoKey' };
  }
  const type = String(proxyType || '').trim().toLowerCase();
  if (type !== 'oneapi' && type !== 'newapi' && type !== 'litellm' && type !== 'custom') {
    return { ok: false, balance: null, usage: null, code: 'proxy_unsupported' };
  }

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${secret.trim()}`,
  };

  async function getJson(url) {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      maxBodyBytes, allowLoopback,
    });
    if (res.status >= 300 && res.status < 400) {
      return { status: res.status, redirected: true, body: null };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: res.status, unauthorized: true, body: null };
    }
    if (res.status === 429) {
      const retryHeader = res.headers?.get?.('retry-after');
      const retrySecs = retryHeader ? Number(retryHeader) : NaN;
      return {
        status: 429,
        rateLimited: true,
        retryAfterMs: Number.isFinite(retrySecs) && retrySecs > 0 ? retrySecs * 1000 : 60_000,
        body: null,
      };
    }
    if (res.status >= 500 && res.status < 600) {
      return { status: res.status, serverError: true, body: null };
    }
    if (res.status === 404) {
      return { status: 404, notFound: true, body: null };
    }
    if (!(res.status >= 200 && res.status < 300)) {
      return { status: res.status, httpError: true, body: null };
    }
    const text = await readBoundedText(res, maxBodyBytes);
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, parseError: true, body: null };
    }
  }

  // rootOrigin：去掉末尾常见的 `/v1` 推理路径，得到网关根路径
  const rootBase = validated.basePath.replace(/\/v1$/i, '');
  const rootUrl = `${validated.origin}${rootBase}`;

  try {
    if (type === 'litellm') {
      const res = await getJson(`${rootUrl}/key/info`);
      if (res.rateLimited) return { ok: false, balance: null, usage: null, code: 'rate_limited', retryAfterMs: res.retryAfterMs };
      if (res.unauthorized) return { ok: false, balance: null, usage: null, code: 'unauthorized' };
      if (res.serverError) return { ok: false, balance: null, usage: null, code: 'unavailable' };
      if (res.redirected) return { ok: false, balance: null, usage: null, code: 'network' };
      if (res.parseError) return { ok: false, balance: null, usage: null, code: ACCOUNT_SHAPE };
      if (res.notFound) return { ok: false, balance: null, usage: null, code: 'proxy_unsupported' };
      if (!res.body) return { ok: false, balance: null, usage: null, code: 'proxy_unsupported' };
      const parsed = parseLiteLlmKeyInfo(res.body);
      return parsed.ok ? parsed : { ok: false, balance: null, usage: null, code: 'proxy_unsupported' };
    }

    if (type === 'custom') {
      if (typeof customQuotaPath !== 'string' || !customQuotaPath.startsWith('/')) {
        return { ok: false, balance: null, usage: null, code: 'proxy_unsupported' };
      }
      const res = await getJson(`${rootUrl}${customQuotaPath}`);
      if (res.rateLimited) return { ok: false, balance: null, usage: null, code: 'rate_limited', retryAfterMs: res.retryAfterMs };
      if (res.unauthorized) return { ok: false, balance: null, usage: null, code: 'unauthorized' };
      if (res.serverError) return { ok: false, balance: null, usage: null, code: 'unavailable' };
      if (res.redirected) return { ok: false, balance: null, usage: null, code: 'network' };
      if (res.parseError) return { ok: false, balance: null, usage: null, code: ACCOUNT_SHAPE };
      if (res.notFound) return { ok: false, balance: null, usage: null, code: 'proxy_unsupported' };
      if (!res.body) return { ok: false, balance: null, usage: null, code: ACCOUNT_SHAPE };
      const oneapi = parseOneApiTokenUsage(res.body);
      if (oneapi.ok) return oneapi;
      const litellm = parseLiteLlmKeyInfo(res.body);
      if (litellm.ok) return litellm;
      return { ok: false, balance: null, usage: null, code: ACCOUNT_SHAPE };
    }

    // OneAPI / NewAPI：
    // 1. 优先尝试标准令牌级额度接口 GET /api/usage/token
    const tokenRes = await getJson(`${rootUrl}/api/usage/token`);
    if (tokenRes.rateLimited) {
      return { ok: false, balance: null, usage: null, code: 'rate_limited', retryAfterMs: tokenRes.retryAfterMs };
    }
    if (tokenRes.body) {
      const parsed = parseOneApiTokenUsage(tokenRes.body);
      if (parsed.ok) return parsed;
    }

    // 2. 回退尝试 OneAPI/NewAPI 兼容的 /v1/dashboard/billing/subscription + usage
    const subRes = await getJson(`${rootUrl}/v1/dashboard/billing/subscription`);
    if (subRes.rateLimited) {
      return { ok: false, balance: null, usage: null, code: 'rate_limited', retryAfterMs: subRes.retryAfterMs };
    }
    if (subRes.body) {
      const usageRes = await getJson(`${rootUrl}/v1/dashboard/billing/usage`);
      const parsed = parseOpenAiBillingCompat(subRes.body, usageRes.body);
      if (parsed.ok) return parsed;
    }

    // 严格鉴别未授权（401/403）：必须为真实未授权，且未被 5xx、重定向或格式错误干扰
    if (
      (subRes.unauthorized && tokenRes.unauthorized) ||
      (subRes.unauthorized && tokenRes.notFound) ||
      (tokenRes.unauthorized && subRes.notFound)
    ) {
      return { ok: false, balance: null, usage: null, code: 'unauthorized' };
    }

    // 服务器端故障 (5xx)
    if (tokenRes.serverError || subRes.serverError) {
      return { ok: false, balance: null, usage: null, code: 'unavailable' };
    }

    // 重定向拦截保护 (3xx)
    if (tokenRes.redirected || subRes.redirected) {
      return { ok: false, balance: null, usage: null, code: 'network' };
    }

    // 200 响应但格式损坏或非 JSON (HTML 错误页等)
    if (tokenRes.parseError || subRes.parseError) {
      return { ok: false, balance: null, usage: null, code: ACCOUNT_SHAPE };
    }

    return { ok: false, balance: null, usage: null, code: 'proxy_unsupported' };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      ok: false,
      balance: null,
      usage: null,
      code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
}

/**
 * 构建完整 ProviderAdapter 实例。
 */
function createOfficialAdapter({
  id,
  displayName,
  sourceType = 'official',
  kind,
  capabilities,
}) {
  const entry = accountCapabilityOf(id);
  const defaultRefs = candidateRefsOf(id);
  const timezone = id.startsWith('deepseek') || id === 'zai' || id === 'zai-coding' || id === 'minimax-cn'
    ? 'Asia/Shanghai'
    : 'UTC';

  return {
    id,
    displayName,
    sourceType,
    kind,
    capabilities: Object.freeze({ ...capabilities }),
    defaultRefs: Object.freeze(defaultRefs),
    identify(providerId) {
      return canonicalProviderId(providerId) === id;
    },
    resolveQuotaPoolId(ctx) {
      return computeQuotaPoolId({ ...ctx, capabilityId: id });
    },
    async query(context = {}) {
      const { quotaPoolId } = computeQuotaPoolId({
        providerId: id,
        capabilityId: id,
        routeId: context.routeId || id,
        credentialRef: context.credentialRef,
        accountId: context.accountId,
        baseURL: context.baseURL,
      });

      if (!entry || entry.kind === 'none' || kind === 'none') {
        return normalizeToQuotaContract({
          rawResult: { ok: false, code: 'accountNoApi' },
          capabilityId: id,
          quotaPoolId,
          dataSource: 'none',
          timezone,
        });
      }

      if (!context.secret || String(context.secret).trim() === '') {
        const missingCode = kind === 'oauth'
          ? 'accountNoToken'
          : (id === 'deepseek-account' ? 'accountNoGrant' : 'accountNoKey');
        return normalizeToQuotaContract({
          rawResult: { ok: false, code: missingCode },
          capabilityId: id,
          quotaPoolId,
          dataSource: 'none',
          timezone,
        });
      }

      const reader = makeAccountReader({
        fetchImpl: context.fetchImpl,
        timeoutMs: context.timeoutMs,
        maxBodyBytes: context.maxBodyBytes,
        deepseekUrl: context.deepseekUrl,
      });

      const rawResult = await reader.read(entry, context.secret, {
        accountId: context.accountId || '',
      });

      const dataSource = id === 'deepseek-account'
        ? 'host_account_grant'
        : (kind === 'oauth' ? 'oauth_api' : 'official_api');

      return normalizeToQuotaContract({
        rawResult,
        capabilityId: id,
        quotaPoolId,
        dataSource,
        timezone,
      });
    },
  };
}

function createProxyAdapter({ id, displayName, supportsQuota }) {
  return {
    id,
    displayName,
    sourceType: 'proxy',
    kind: 'proxy',
    capabilities: Object.freeze({
      supportsBalance: supportsQuota,
      supportsWeeklyQuota: supportsQuota,
      supportsUsageHistory: supportsQuota,
      supportsResetTime: supportsQuota,
      supportsModelList: true,
      supportsPerModelUsage: false,
      supportsQuotaPool: true,
    }),
    defaultRefs: Object.freeze([]),
    identify(providerId) {
      return String(providerId || '').trim().toLowerCase() === id;
    },
    resolveQuotaPoolId(ctx) {
      return computeQuotaPoolId({ ...ctx, capabilityId: id });
    },
    async query(context = {}) {
      const { quotaPoolId } = computeQuotaPoolId({
        providerId: id,
        capabilityId: id,
        routeId: context.routeId || id,
        credentialRef: context.credentialRef,
        accountId: context.accountId,
        baseURL: context.baseURL,
      });

      if (!supportsQuota) {
        return normalizeToQuotaContract({
          rawResult: { ok: false, code: 'proxy_unsupported' },
          capabilityId: id,
          quotaPoolId,
          dataSource: 'none',
          timezone: 'UTC',
        });
      }

      const rawResult = await queryProxyAdapter({
        proxyType: id === 'custom-proxy' ? 'custom' : id,
        baseURL: context.baseURL,
        secret: context.secret,
        customQuotaPath: context.customQuotaPath,
        fetchImpl: context.fetchImpl,
        timeoutMs: context.timeoutMs,
        maxBodyBytes: context.maxBodyBytes,
      });

      return normalizeToQuotaContract({
        rawResult,
        capabilityId: id,
        quotaPoolId,
        dataSource: rawResult.ok ? 'proxy_token_api' : 'none',
        timezone: 'UTC',
      });
    },
  };
}

const BALANCE_CAPS = {
  supportsBalance: true,
  supportsWeeklyQuota: false,
  supportsUsageHistory: false,
  supportsResetTime: false,
  supportsModelList: true,
  supportsPerModelUsage: false,
  supportsQuotaPool: true,
};

const WINDOW_CAPS = {
  supportsBalance: false,
  supportsWeeklyQuota: true,
  supportsUsageHistory: true,
  supportsResetTime: true,
  supportsModelList: true,
  supportsPerModelUsage: false,
  supportsQuotaPool: true,
};

const NONE_CAPS = {
  supportsBalance: false,
  supportsWeeklyQuota: false,
  supportsUsageHistory: false,
  supportsResetTime: false,
  supportsModelList: true,
  supportsPerModelUsage: false,
  supportsQuotaPool: false,
};

const ADAPTERS = new Map([
  // 官方余额型
  ['deepseek-official', createOfficialAdapter({ id: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance', capabilities: BALANCE_CAPS })],
  ['deepseek', createOfficialAdapter({ id: 'deepseek', displayName: 'DeepSeek', kind: 'balance', capabilities: BALANCE_CAPS })],
  ['deepseek-account', createOfficialAdapter({ id: 'deepseek-account', displayName: 'DeepSeek Account', sourceType: 'account', kind: 'balance', capabilities: BALANCE_CAPS })],
  ['moonshotai', createOfficialAdapter({ id: 'moonshotai', displayName: 'Moonshot', kind: 'balance', capabilities: BALANCE_CAPS })],
  ['zai', createOfficialAdapter({ id: 'zai', displayName: 'Z.ai (GLM)', kind: 'balance', capabilities: BALANCE_CAPS })],
  ['openrouter', createOfficialAdapter({
    id: 'openrouter',
    displayName: 'OpenRouter',
    kind: 'balance',
    capabilities: { ...BALANCE_CAPS, supportsUsageHistory: true },
  })],
  ['siliconflow', createOfficialAdapter({ id: 'siliconflow', displayName: 'SiliconFlow', kind: 'balance', capabilities: BALANCE_CAPS })],

  // 官方订阅窗口型
  ['kimi-coding', createOfficialAdapter({ id: 'kimi-coding', displayName: 'Kimi For Coding', kind: 'usage', capabilities: WINDOW_CAPS })],
  ['opencode', createOfficialAdapter({ id: 'opencode', displayName: 'OpenCode', kind: 'usage', capabilities: WINDOW_CAPS })],
  ['opencode-go', createOfficialAdapter({ id: 'opencode-go', displayName: 'OpenCode Go', kind: 'usage', capabilities: WINDOW_CAPS })],
  ['minimax', createOfficialAdapter({
    id: 'minimax',
    displayName: 'MiniMax',
    kind: 'usage',
    capabilities: { ...WINDOW_CAPS, supportsPerModelUsage: true },
  })],
  ['minimax-cn', createOfficialAdapter({
    id: 'minimax-cn',
    displayName: 'MiniMax (CN)',
    kind: 'usage',
    capabilities: { ...WINDOW_CAPS, supportsPerModelUsage: true },
  })],
  ['zai-coding', createOfficialAdapter({ id: 'zai-coding', displayName: 'Z.ai Coding Plan', kind: 'usage', capabilities: WINDOW_CAPS })],

  // 官方 OAuth 订阅型
  ['anthropic', createOfficialAdapter({
    id: 'anthropic',
    displayName: 'Claude Code',
    sourceType: 'oauth',
    kind: 'oauth',
    capabilities: { ...WINDOW_CAPS, supportsPerModelUsage: true },
  })],
  ['openai-codex', createOfficialAdapter({
    id: 'openai-codex',
    displayName: 'OpenAI Codex',
    sourceType: 'oauth',
    kind: 'oauth',
    capabilities: { ...WINDOW_CAPS, supportsBalance: true },
  })],

  // 官方仅支持模型调用、不支持 API Key 额度查询的服务（诚实声明能力）
  ['openai', createOfficialAdapter({ id: 'openai', displayName: 'OpenAI Platform', kind: 'none', capabilities: NONE_CAPS })],
  ['google', createOfficialAdapter({ id: 'google', displayName: 'Google Gemini', kind: 'none', capabilities: NONE_CAPS })],
  ['google-vertex', createOfficialAdapter({ id: 'google-vertex', displayName: 'Google Vertex AI', kind: 'none', capabilities: NONE_CAPS })],
  ['dashscope', createOfficialAdapter({ id: 'dashscope', displayName: 'Aliyun Bailian (Qwen)', kind: 'none', capabilities: NONE_CAPS })],
  ['qwen', createOfficialAdapter({ id: 'qwen', displayName: 'Aliyun Bailian (Qwen)', kind: 'none', capabilities: NONE_CAPS })],
  ['volcengine', createOfficialAdapter({ id: 'volcengine', displayName: 'Volcengine Ark (Doubao)', kind: 'none', capabilities: NONE_CAPS })],
  ['doubao', createOfficialAdapter({ id: 'doubao', displayName: 'Volcengine Ark (Doubao)', kind: 'none', capabilities: NONE_CAPS })],
  ['github-copilot', createOfficialAdapter({ id: 'github-copilot', displayName: 'GitHub Copilot', kind: 'none', capabilities: NONE_CAPS })],
  ['amazon-bedrock', createOfficialAdapter({ id: 'amazon-bedrock', displayName: 'Amazon Bedrock', kind: 'none', capabilities: NONE_CAPS })],
  ['azure', createOfficialAdapter({ id: 'azure', displayName: 'Azure OpenAI', kind: 'none', capabilities: NONE_CAPS })],

  // 反向代理适配器
  ['oneapi', createProxyAdapter({ id: 'oneapi', displayName: 'OneAPI Proxy', supportsQuota: true })],
  ['newapi', createProxyAdapter({ id: 'newapi', displayName: 'NewAPI Proxy', supportsQuota: true })],
  ['litellm', createProxyAdapter({ id: 'litellm', displayName: 'LiteLLM Proxy', supportsQuota: true })],
  ['custom-proxy', createProxyAdapter({ id: 'custom-proxy', displayName: 'Custom Proxy', supportsQuota: true })],
  ['openai-compatible', createProxyAdapter({ id: 'openai-compatible', displayName: 'OpenAI-Compatible Proxy', supportsQuota: false })],
  ['anthropic-compatible', createProxyAdapter({ id: 'anthropic-compatible', displayName: 'Anthropic-Compatible Proxy', supportsQuota: false })],
  ['gemini-compatible', createProxyAdapter({ id: 'gemini-compatible', displayName: 'Gemini-Compatible Proxy', supportsQuota: false })],
]);

/**
 * 按 providerId 或代理类型获取 ProviderAdapter。
 *
 * @param {string} providerId
 * @returns {import('./types.js').ProviderAdapter | null}
 */
export function getProviderAdapter(providerId) {
  if (typeof providerId !== 'string' || providerId.trim() === '') return null;
  const canonical = canonicalProviderId(providerId);
  return ADAPTERS.get(canonical) ?? ADAPTERS.get(providerId.trim().toLowerCase()) ?? null;
}

/**
 * 列出所有已注册的 ProviderAdapter。
 */
export function listProviderAdapters() {
  return [...ADAPTERS.values()];
}

/**
 * 支持作为反向代理映射目标的适配器列表。
 */
export function proxyAdapterIds() {
  return ['oneapi', 'newapi', 'litellm', 'openai-compatible', 'anthropic-compatible', 'gemini-compatible', 'custom-proxy'];
}
