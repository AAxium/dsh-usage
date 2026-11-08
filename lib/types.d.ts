/**
 * dsh-usage — 统一类型契约 (P1 Unified Data Model & Provider Adapter Contract)
 */

export type SourceType = 'official' | 'proxy' | 'oauth' | 'account' | 'unknown';

export type QuotaType =
  | 'balance'
  | 'subscription_window'
  | 'token_usage'
  | 'request_count'
  | 'local_spend'
  | 'mixed'
  | 'none';

export type QuotaUnit =
  | 'CNY'
  | 'USD'
  | 'EUR'
  | 'JPY'
  | 'GBP'
  | 'tokens'
  | 'requests'
  | 'percent'
  | 'credits'
  | 'unknown';

export type QuotaWindowPeriod = '5h' | '1d' | '7d' | '7d-opus' | '30d' | 'cycle' | string;

export type DataSourceType =
  | 'official_api'
  | 'oauth_api'
  | 'rate_limit_headers'
  | 'host_account_grant'
  | 'proxy_token_api'
  | 'local_session_stats'
  | 'none';

export type DataConfidence = 'high' | 'medium' | 'low' | 'unknown';

export type QueryStatus =
  | 'ok'
  | 'unsupported'
  | 'unknown'
  | 'unconfigured'
  | 'failed'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'stale';

export interface ProviderCapabilities {
  /** 是否支持真实账户或令牌余额查询 */
  supportsBalance: boolean;
  /** 是否支持周额度上限/周期窗口查询 */
  supportsWeeklyQuota: boolean;
  /** 是否支持历史用量明细/累计使用量查询 */
  supportsUsageHistory: boolean;
  /** 是否返回官方重置时间 */
  supportsResetTime: boolean;
  /** 是否支持枚举或探测模型列表 */
  supportsModelList: boolean;
  /** 是否支持按单模型拆分额度桶 */
  supportsPerModelUsage: boolean;
  /** 是否属于多模型共享账户额度池 */
  supportsQuotaPool: boolean;
}

export interface AccountInfo {
  accountId: string;
  providerId: string;
  alias: string | null;
  credentialRef: string | null;
  sourceType: SourceType;
  configured: boolean;
  planType: string | null;
}

export interface ModelIdentity {
  /** 唯一标识键: `${routeId}/${modelId}` */
  key: string;
  providerId: string;
  routeId: string;
  modelId: string;
  displayName: string;
  alias: string | null;
  providerDisplayName: string;
  sourceType: SourceType;
  isProxy: boolean;
  baseURL: string | null;
  accountAlias: string | null;
  credentialRef: string | null;
  favorite?: boolean;
  hidden?: boolean;
  order?: number;
}

export interface QuotaIdentity {
  providerId: string;
  accountId: string;
  routeId?: string;
  requestedModelId?: string;
  resolvedModelId?: string;
  quotaGroupId?: string | null;
  quotaPoolId?: string;
  sourceType: SourceType;
  matchBasis?:
    | 'explicit_api_pool'
    | 'provider_model_registry'
    | 'route_provider_model'
    | 'account_shared_pool'
    | 'user_selected_target'
    | 'unrecognized_model';
  ambiguous?: boolean;
  sharedQuotaPool?: boolean;
  isMonitoringOverride?: boolean;
}

export interface QuotaWindow {
  /** 窗口唯一标识 */
  windowId?: string;
  /** 标准窗口分类：5h / weekly / daily / monthly / custom */
  windowKind?: '5h' | 'weekly' | 'daily' | 'monthly' | 'custom';
  /** 窗口周期标识：5h / 1d / 7d / 7d-opus / 30d / cycle */
  key: QuotaWindowPeriod;
  label: string;
  /** 所属额度组（如 'gemini' | 'non-gemini'） */
  quotaGroupId?: string | null;
  quotaType: QuotaType;
  unit: QuotaUnit;
  /** 总额度上限（仅百分比接口为 null） */
  total: number | null;
  /** 已使用数量（仅百分比接口为 null） */
  used: number | null;
  /** 剩余数量（仅百分比接口为 null） */
  remaining: number | null;
  /** 已使用百分比 (0-100)，无上限时为 null */
  usedPercent: number | null;
  /** 剩余百分比 (0-100)，无上限时为 null */
  remainingPercent: number | null;
  /** 剩余比例 (0-1) */
  remainingFraction?: number | null;
  /** 官方重置时间戳 (ms)，未知时为 null */
  resetsAt: number | null;
  /** 带明确时区的 ISO 重置时间，未知时为 null */
  resetAt?: string | null;
  resetAtIso: string | null;
  /** 时区标识，如 'UTC' 或 'Asia/Shanghai' */
  timezone: string;
  /** 标准窗口数据来源 */
  source?: 'official' | 'provider' | 'local';
  /** 标准窗口可用状态 */
  status?: 'available' | 'unknown' | 'unsupported' | 'error';
  /** 数据来源：区分官方窗口与本地统计窗口 */
  dataSource: DataSourceType;
  /** 适用的模型名（若为模型专属桶） */
  modelScope?: string | null;
}

export interface QuotaInfo {
  quotaPoolId: string;
  quotaType: QuotaType;
  unit: QuotaUnit;
  currency: string | null;
  /** 总额度（无上限的纯充值余额为 null，严禁伪造进度环） */
  total: number | null;
  /** 已用额度 */
  used: number | null;
  /** 剩余可用余额或额度 */
  remaining: number | null;
  /** 赠金/代金券余额（若接口拆分） */
  grantedBalance?: number | null;
  /** 充值现金余额（若接口拆分） */
  toppedUpBalance?: number | null;
  /** 是否为无限额度令牌（如 OneAPI/NewAPI 无限额 Key） */
  unlimited?: boolean;
  /** 官方重置时间 (ms) */
  resetAt: number | null;
  /** 带时区的重置时间字符串 */
  resetAtIso: string | null;
  timezone: string;
  windows: QuotaWindow[];
}

export interface QuotaPool {
  quotaPoolId: string;
  providerId: string;
  accountId: string;
  displayName: string;
  /** 共享状态：confirmed=确认共享同一账户池，isolated=独立模型桶，unknown=额度归属未知 */
  sharingMode: 'confirmed' | 'isolated' | 'unknown';
  /** 关联到该额度池的 model Keys (`routeId/modelId`) */
  memberModels: string[];
  quota: QuotaInfo | null;
  status: QueryStatus;
}

export interface ModelUsage {
  modelId: string;
  routeId: string;
  /** 本地统计周期起点（与官方重置窗口严格分离） */
  windowStartMs: number | null;
  windowEndMs: number | null;
  weekStartDay: 'monday' | 'sunday';
  timezone: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  requestCount: number | null;
  dataSource: 'local_session_stats' | 'official_api';
}

export interface QueryResult {
  providerId: string;
  accountId: string;
  routeId: string;
  modelId: string;
  displayName: string;
  providerDisplayName: string;
  sourceType: SourceType;
  isProxy: boolean;
  baseURL: string | null;
  accountAlias: string | null;
  quotaPoolId: string;
  /** 是否与其他展示模型共享同一额度池 */
  sharedQuotaPool: boolean;
  /** 共享关系可信度 */
  poolSharingMode: 'confirmed' | 'isolated' | 'unknown';
  quotaType: QuotaType;
  unit: QuotaUnit;
  currency: string | null;
  total: number | null;
  used: number | null;
  remaining: number | null;
  resetAt: number | null;
  resetAtIso: string | null;
  timezone: string;
  fetchedAt: number;
  dataSource: DataSourceType;
  confidence: DataConfidence;
  status: QueryStatus;
  statusMessage: string | null;
  /** 是否为查询失败后保留的上次缓存快照 */
  stale: boolean;
  /** 上次成功更新时间戳 (ms) */
  lastSuccessAt: number | null;
  /** 限流退避到期时间戳 (ms) */
  retryAfterAt?: number | null;
  balance: {
    isAvailable: boolean | null;
    total: number | null;
    currency: string | null;
    granted?: number | null;
    toppedUp?: number | null;
  } | null;
  usage: {
    plan: string | null;
    windows: QuotaWindow[];
  } | null;
  localUsage?: ModelUsage | null;
  tier?: {
    input: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    model: string | null;
    known: boolean;
    currency: string;
    window: 'peak' | 'idle' | null;
  } | null;
}

export interface ProviderAdapterContext {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  baseURL?: string | null;
  deepseekUrl?: string | null;
  secret?: string | null;
  accountId?: string | null;
  credentialRef?: string | null;
  routeId?: string;
  modelId?: string;
  customQuotaPath?: string | null;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly sourceType: SourceType;
  readonly kind: 'balance' | 'usage' | 'oauth' | 'proxy' | 'none';
  readonly capabilities: ProviderCapabilities;
  readonly defaultRefs: readonly string[];
  identify(providerId: string, routeConfig?: Record<string, unknown> | null): boolean;
  resolveQuotaPoolId(context: {
    providerId: string;
    routeId: string;
    credentialRef?: string | null;
    accountId?: string | null;
    baseURL?: string | null;
  }): { quotaPoolId: string; sharingMode: 'confirmed' | 'isolated' | 'unknown' };
  query(context: ProviderAdapterContext): Promise<{
    ok: boolean;
    status: QueryStatus;
    code: string | null;
    quotaType: QuotaType;
    unit: QuotaUnit;
    dataSource: DataSourceType;
    confidence: DataConfidence;
    balance: {
      isAvailable: boolean | null;
      total: number | null;
      currency: string | null;
      granted?: number | null;
      toppedUp?: number | null;
    } | null;
    usage: {
      plan: string | null;
      windows: QuotaWindow[];
    } | null;
    quotaInfo: QuotaInfo | null;
    retryAfterMs?: number | null;
  }>;
}

export type GaugeStyle = 'd-gauge' | 'ring' | 'semicircle' | 'compact' | 'detailed';
export type PercentDisplayMode = 'remaining' | 'used';
export type MonitorMode = 'auto' | 'fixed' | 'multi';

export interface DisplayTargetConfig {
  mode: MonitorMode;
  fixedModelKey: string;
  selectedModelKeys: string[];
  hiddenModelKeys: string[];
  favoriteModelKeys: string[];
  modelOrder: string[];
  modelAliases: Record<string, string>;
  groupByProvider: boolean;
  gaugeStyle: GaugeStyle;
  percentMode: PercentDisplayMode;
  warnThreshold: number;
  alertThreshold: number;
  preferredPeriod: 'all' | '5h' | '1d' | '7d' | '30d' | 'cycle';
  showModelId: boolean;
  showProvider: boolean;
  showAccountAlias: boolean;
  refreshIntervalMinutes: 0.5 | 5 | 15 | 30 | 60;
  localWeekStart: 'monday' | 'sunday';
  localTimezone: string;
}

export interface RoutingModelMappingItem {
  logicalModel: string;
  targetProvider: string;
  targetModelId: string;
  baseURL?: string;
  apiKeyRef?: string;
  proxyAdapter?: 'auto' | 'oneapi' | 'newapi' | 'litellm' | 'none';
}

export interface RoutingConfig {
  currentDefault: {
    provider: string;
    model: string;
    reasoningEffort?: string | null;
  };
  routes: Array<{
    routeId: string;
    displayName: string;
    sourceType: SourceType;
    isProxy: boolean;
    apiProtocol: string | null;
    baseURL: string | null;
    defaultBaseURL: string | null;
    apiKeyRef: string | null;
    credentialConfigured: boolean;
    credentialSource: string | null;
    capabilityId: string | null;
    quotaStatus: QueryStatus;
    models: Array<{
      id: string;
      name: string;
      contextWindow?: number | null;
      maxTokens?: number | null;
    }>;
  }>;
  writable: boolean;
}
