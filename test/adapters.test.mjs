// P1 统一 Provider Adapter 与额度数据契约确定性测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLiteLlmKeyInfo,
  parseOneApiTokenUsage,
  parseSiliconFlowBalance,
  parseZaiCodingUsage,
} from '../lib/accounts.js';
import {
  classifyRouteSource,
  computeQuotaPoolId,
  getProviderAdapter,
  listProviderAdapters,
  normalizeToQuotaContract,
  parseOpenAiBillingCompat,
  queryProxyAdapter,
  validateEndpointUrl,
} from '../lib/adapters.js';

test('P1: ProviderAdapter 能力声明完整且不伪造能力', () => {
  const ds = getProviderAdapter('deepseek-official');
  assert.ok(ds);
  assert.equal(ds.capabilities.supportsBalance, true);
  assert.equal(ds.capabilities.supportsWeeklyQuota, false);
  assert.equal(ds.capabilities.supportsQuotaPool, true);

  const sf = getProviderAdapter('siliconflow');
  assert.ok(sf);
  assert.equal(sf.capabilities.supportsBalance, true);
  assert.equal(sf.displayName, 'SiliconFlow');

  const zaiCoding = getProviderAdapter('zai-coding');
  assert.ok(zaiCoding);
  assert.equal(zaiCoding.capabilities.supportsWeeklyQuota, true);
  assert.equal(zaiCoding.capabilities.supportsResetTime, true);

  const google = getProviderAdapter('google');
  assert.ok(google);
  assert.equal(google.kind, 'none');
  assert.equal(google.capabilities.supportsBalance, false);
  assert.equal(google.capabilities.supportsWeeklyQuota, false);
  assert.equal(google.capabilities.supportsModelList, true);

  const qwen = getProviderAdapter('dashscope');
  assert.ok(qwen);
  assert.equal(qwen.kind, 'none');
  assert.equal(qwen.capabilities.supportsBalance, false);

  const oaiCompat = getProviderAdapter('openai-compatible');
  assert.ok(oaiCompat);
  assert.equal(oaiCompat.sourceType, 'proxy');
  assert.equal(oaiCompat.capabilities.supportsModelList, true);
  assert.equal(oaiCompat.capabilities.supportsBalance, false, '兼容推理不代表兼容余额接口');

  const all = listProviderAdapters();
  assert.ok(all.length >= 20);
});

test('P1: SiliconFlow 与 Z.ai Coding Plan 解析器', () => {
  const sfOk = parseSiliconFlowBalance({
    code: 20000,
    status: true,
    data: { totalBalance: '38.50', balance: '10.00', chargeBalance: '28.50', status: 'normal' },
  });
  assert.equal(sfOk.ok, true);
  assert.equal(sfOk.balance.total, 38.5);

  const sfDisabled = parseSiliconFlowBalance({
    code: 20000,
    status: true,
    data: { totalBalance: '10.00', status: 'disable' },
  });
  assert.equal(sfDisabled.ok, false);
  assert.equal(sfDisabled.code, 'unavailable');

  const zaiOk = parseZaiCodingUsage({
    code: 200,
    success: true,
    data: {
      planName: 'Pro',
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 25, nextResetTime: '2026-11-08T12:00:00Z' },
        { type: 'TIME_LIMIT', percentage: 60, nextResetTime: '2026-11-30T00:00:00Z' },
      ],
    },
  });
  assert.equal(zaiOk.ok, true);
  assert.equal(zaiOk.usage.plan, 'Pro');
  assert.equal(zaiOk.usage.windows.length, 2);
  assert.deepEqual(zaiOk.usage.windows.map((w) => w.key), ['5h', '30d']);
});

test('P1: OneAPI / NewAPI / LiteLLM 反代额度解析器', () => {
  // OneAPI 内部 quota 单位 (500000 = $1)
  const oneApiQuota = parseOneApiTokenUsage({
    code: true,
    data: {
      total_granted: 5000000,   // $10
      total_used: 1500000,      // $3
      total_available: 3500000, // $7
      unlimited_quota: false,
      expires_at: 1794100000,
    },
  });
  assert.equal(oneApiQuota.ok, true);
  assert.equal(oneApiQuota.balance.total, 7);
  assert.equal(oneApiQuota.balance.currency, 'USD');
  assert.equal(oneApiQuota.usage.windows[0].percent, 30);

  // Billing 兼容格式 (/v1/dashboard/billing/subscription + usage)
  const billingCompat = parseOpenAiBillingCompat(
    { hard_limit_usd: 20, access_until: 1794100000 },
    { total_usage: 500 }, // 500 cents = $5
  );
  assert.equal(billingCompat.ok, true);
  assert.equal(billingCompat.balance.total, 15);
  assert.equal(billingCompat.usage.windows[0].percent, 25);

  // LiteLLM /key/info
  const litellm = parseLiteLlmKeyInfo({
    key: 'sk-123',
    info: { max_budget: 50, spend: 12.5, budget_duration: '30d', budget_reset_at: '2026-11-30T00:00:00Z' },
  });
  assert.equal(litellm.ok, true);
  assert.equal(litellm.balance.total, 37.5);
  assert.equal(litellm.usage.windows[0].key, '30d');
  assert.equal(litellm.usage.windows[0].percent, 25);
});

test('P1: SSRF 防护与 Base URL 校验', () => {
  assert.equal(validateEndpointUrl('https://api.example.com/v1').ok, true);
  assert.equal(validateEndpointUrl('http://127.0.0.1:4000/v1', { allowLoopback: true }).ok, true);
  assert.equal(validateEndpointUrl('http://127.0.0.1:4000/v1', { allowLoopback: false }).ok, false);
  assert.equal(validateEndpointUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(validateEndpointUrl('http://100.100.100.200/latest/meta-data').ok, false);
  assert.equal(validateEndpointUrl('https://metadata.google.internal/computeMetadata').ok, false);
  assert.equal(validateEndpointUrl('http://192.168.1.10:3000/v1').ok, false);
  assert.equal(validateEndpointUrl('http://10.0.0.5/v1').ok, false);
  assert.equal(validateEndpointUrl('file:///etc/passwd').ok, false);
  assert.equal(validateEndpointUrl('https://user:pass@api.example.com/v1').ok, false);
});

test('P1: Official vs Proxy 路由来源识别（不靠模型名猜测）', () => {
  const official = classifyRouteSource('deepseek-official', 'https://api.deepseek.com/v1');
  assert.equal(official.isProxy, false);
  assert.equal(official.sourceType, 'official');

  const proxy = classifyRouteSource('deepseek-official', 'https://my-oneapi.example.com/v1');
  assert.equal(proxy.isProxy, true);
  assert.equal(proxy.sourceType, 'proxy');
  assert.equal(proxy.host, 'my-oneapi.example.com');
});

test('P1: 共享额度池 quotaPoolId 计算与防重', () => {
  const sonnetPool = computeQuotaPoolId({
    providerId: 'anthropic',
    capabilityId: 'anthropic',
    routeId: 'anthropic',
    credentialRef: 'DSH_USAGE_CLAUDE_OAUTH_TOKEN',
  });
  const opusPool = computeQuotaPoolId({
    providerId: 'anthropic',
    capabilityId: 'anthropic',
    routeId: 'anthropic',
    credentialRef: 'DSH_USAGE_CLAUDE_OAUTH_TOKEN',
  });
  assert.equal(sonnetPool.quotaPoolId, opusPool.quotaPoolId, '同一账户下的 Sonnet 与 Opus 必须共享同一 quotaPoolId');
  assert.equal(sonnetPool.sharingMode, 'confirmed');

  const unknownPool = computeQuotaPoolId({
    providerId: 'unknown-custom',
    capabilityId: 'unknown-custom',
    routeId: 'unknown-custom',
  });
  assert.equal(unknownPool.sharingMode, 'unknown');
});

test('P1: 余额类数据不虚构总额度上限，重置时间带明确时区', () => {
  const norm = normalizeToQuotaContract({
    rawResult: {
      ok: true,
      balance: { isAvailable: true, total: 88.5, currency: 'CNY' },
      usage: null,
    },
    capabilityId: 'deepseek-official',
    quotaPoolId: 'pool:deepseek',
    timezone: 'Asia/Shanghai',
  });
  assert.equal(norm.ok, true);
  assert.equal(norm.quotaType, 'balance');
  assert.equal(norm.unit, 'CNY');
  assert.equal(norm.quotaInfo.total, null, '纯余额无上限，total 必须为 null');
  assert.equal(norm.quotaInfo.remaining, 88.5);
  assert.equal(norm.quotaInfo.windows.length, 0);

  const winNorm = normalizeToQuotaContract({
    rawResult: {
      ok: true,
      balance: null,
      usage: {
        plan: 'Pro',
        windows: [{ key: '5h', percent: 40, resetsAt: Date.parse('2026-11-08T04:00:00Z') }],
      },
    },
    capabilityId: 'kimi-coding',
    quotaPoolId: 'pool:kimi',
    timezone: 'Asia/Shanghai',
  });
  assert.equal(winNorm.quotaInfo.windows[0].usedPercent, 40);
  assert.equal(winNorm.quotaInfo.windows[0].remainingPercent, 60);
  assert.match(winNorm.quotaInfo.windows[0].resetAtIso, /\+08:00$/);
});

test('P1: queryProxyAdapter 支持 OneAPI 回退与不兼容反代诚实报告', async () => {
  // 1. 不支持的通用兼容反代直接报 proxy_unsupported，不发扫描请求
  let called = 0;
  const compatRes = await queryProxyAdapter({
    proxyType: 'openai-compatible',
    baseURL: 'https://proxy.example.com/v1',
    secret: 'sk-test',
    fetchImpl: async () => { called += 1; return new Response('{}'); },
  });
  assert.equal(compatRes.ok, false);
  assert.equal(compatRes.code, 'proxy_unsupported');
  assert.equal(called, 0, '未指定额度端点的兼容反代不得盲目扫描接口');

  // 2. OneAPI /api/usage/token 404 时回退 /v1/dashboard/billing/subscription
  const oneApiRes = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://oneapi.example.com/v1',
    secret: 'sk-test',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/usage/token')) {
        return new Response('Not Found', { status: 404 });
      }
      if (String(url).endsWith('/v1/dashboard/billing/subscription')) {
        return new Response(JSON.stringify({ hard_limit_usd: 100 }));
      }
      if (String(url).endsWith('/v1/dashboard/billing/usage')) {
        return new Response(JSON.stringify({ total_usage: 2500 }));
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  assert.equal(oneApiRes.ok, true);
  assert.equal(oneApiRes.balance.total, 75);
  assert.equal(oneApiRes.usage.windows[0].percent, 25);
});
