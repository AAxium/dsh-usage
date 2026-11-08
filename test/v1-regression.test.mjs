// v1.0 专项回归测试（覆盖第五节 9 大场景与第六节 6 项安全审计）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-credentials') {
      const stub = 'export function credentialRef(n) { return { __ref: String(n) }; }\nexport function credentialKey(s, id) { return `${s}/${id}`; }\n';
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  parseAntigravityAuthUsage,
  resolveAntigravityQuotaGroup,
} = await import('../lib/accounts.js');
const {
  buildQuotaIdentity,
  computeQuotaPoolId,
  maskAccountId,
  normalizeToQuotaContract,
  queryProxyAdapter,
  validateEndpointUrlWithDns,
} = await import('../lib/adapters.js');
const {
  mutateRoutingConfig,
} = await import('../lib/routing.js');

// 模拟上游 Antigravity 额度视图：
// Gemini 仅有 Weekly = 75% 剩余（已用 25%），5H 不存在！
// Claude (non-gemini) 有 5H = 42% 剩余（已用 58%）、Weekly = 61% 剩余（已用 39%）
function makeMixedAntigravityView() {
  return {
    state: 'available',
    checkedAt: '2026-11-08T01:00:00.000Z',
    groups: [
      {
        group: 'gemini',
        modelCount: 4,
        windows: [
          { window: 'weekly', remainingFraction: 0.75, resetTime: '2026-11-15T00:00:00.000Z' },
        ],
      },
      {
        group: 'non-gemini',
        modelCount: 3,
        windows: [
          { window: '5h', remainingFraction: 0.42, resetTime: '2026-11-08T05:00:00.000Z' },
          { window: 'weekly', remainingFraction: 0.61, resetTime: '2026-11-14T00:00:00.000Z' },
        ],
      },
    ],
  };
}

test('测试 1：Gemini 与 Claude 窗口混合时，当前模型为 Gemini 绝不能把 Claude 的 5H 当作 Gemini 的 5H', () => {
  const view = makeMixedAntigravityView();
  const geminiRes = parseAntigravityAuthUsage(view, { modelId: 'antigravity-gemini-4-argon' });

  assert.equal(geminiRes.ok, true);
  assert.equal(geminiRes.quotaGroupId, 'gemini');
  // Gemini 仅返回了 Weekly(7d)，因此 windows 长度只能是 1，绝不能出现 5h！
  assert.equal(geminiRes.usage.windows.length, 1);
  assert.equal(geminiRes.usage.windows[0].key, '7d');
  assert.equal(Math.round(geminiRes.usage.windows[0].remainingPercent), 75);
  assert.equal(Math.round(geminiRes.usage.windows[0].percent), 25);
  // 明确记录 5h 未返回
  assert.deepEqual(geminiRes.usage.missingWindows, ['5h']);

  // 同时 groups 完整保留两组独立数据：Claude 卡片拥有 5H=42% 剩余、Weekly=61% 剩余
  const claudeGrp = geminiRes.groups['non-gemini'];
  assert.ok(claudeGrp);
  assert.equal(claudeGrp.windows.length, 2);
  const c5h = claudeGrp.windows.find((w) => w.key === '5h');
  const c7d = claudeGrp.windows.find((w) => w.key === '7d');
  assert.equal(Math.round(c5h.remainingPercent), 42);
  assert.equal(Math.round(c7d.remainingPercent), 61);
});

test('测试 2：反向切换 Claude（含 gemini-claude-* 历史别名）只显示 Claude 组额度，不混入 Gemini Weekly 75%', () => {
  const view = makeMixedAntigravityView();

  assert.equal(resolveAntigravityQuotaGroup('antigravity-claude-sonnet-5-5'), 'non-gemini');
  assert.equal(resolveAntigravityQuotaGroup('gemini-claude-sonnet-4-6-thinking-high'), 'non-gemini');

  const claudeRes = parseAntigravityAuthUsage(view, { modelId: 'antigravity-claude-sonnet-5-5' });
  assert.equal(claudeRes.ok, true);
  assert.equal(claudeRes.quotaGroupId, 'non-gemini');
  assert.equal(claudeRes.usage.windows.length, 2);
  const w5h = claudeRes.usage.windows.find((w) => w.key === '5h');
  const w7d = claudeRes.usage.windows.find((w) => w.key === '7d');
  assert.equal(Math.round(w5h.remainingPercent), 42);
  assert.equal(Math.round(w7d.remainingPercent), 61);
  assert.notEqual(Math.round(w7d.remainingPercent), 75, '绝不能把 Gemini 的 75% 当作 Claude 的 Weekly');

  // 若 Claude 仅返回 5H（无 Weekly），不得拿 Gemini 的 Weekly 填充
  const claudeOnly5hView = {
    state: 'available',
    groups: [
      { group: 'gemini', modelCount: 2, windows: [{ window: 'weekly', remainingFraction: 0.75, resetTime: '2026-11-15T00:00:00.000Z' }] },
      { group: 'non-gemini', modelCount: 2, windows: [{ window: '5h', remainingFraction: 0.42, resetTime: '2026-11-08T05:00:00.000Z' }] },
    ],
  };
  const claudeOnly5h = parseAntigravityAuthUsage(claudeOnly5hView, { modelId: 'antigravity-claude-opus-5-5' });
  assert.equal(claudeOnly5h.ok, true);
  assert.equal(claudeOnly5h.usage.windows.length, 1);
  assert.equal(claudeOnly5h.usage.windows[0].key, '5h');
  assert.deepEqual(claudeOnly5h.usage.missingWindows, ['7d']);
});

test('测试 3 & 4 & 5：同模型不同 Provider、不同账户同模型隔离、同组多模型共享额度池', () => {
  // 测试 3：Google 官方 API vs Google Antigravity
  const poolOfficial = computeQuotaPoolId({
    providerId: 'google',
    capabilityId: 'google',
    routeId: 'google',
    credentialRef: 'GEMINI_API_KEY',
  });
  const poolAgy = computeQuotaPoolId({
    providerId: 'google-antigravity',
    capabilityId: 'google-antigravity',
    routeId: 'google-antigravity',
    accountId: 'acc-1',
    quotaGroupId: 'gemini',
  });
  assert.notEqual(poolOfficial.quotaPoolId, poolAgy.quotaPoolId);

  // 测试 4：两个不同 Antigravity 账户均提供 Gemini，按 accountId 严格隔离
  const poolAgyAcc2 = computeQuotaPoolId({
    providerId: 'google-antigravity',
    capabilityId: 'google-antigravity',
    routeId: 'google-antigravity',
    accountId: 'acc-2',
    quotaGroupId: 'gemini',
  });
  assert.notEqual(poolAgy.quotaPoolId, poolAgyAcc2.quotaPoolId);

  // 测试 5：同一账户下的多个 Gemini 模型（Argon 与 3.8 Flash）共享同一个 gemini 额度池，而同账户 Claude 走 non-gemini 池
  const poolGeminiFlash = computeQuotaPoolId({
    providerId: 'google-antigravity',
    capabilityId: 'google-antigravity',
    routeId: 'google-antigravity',
    accountId: 'acc-1',
    quotaGroupId: resolveAntigravityQuotaGroup('antigravity-gemini-3.8-flash'),
  });
  const poolClaudeSonnet = computeQuotaPoolId({
    providerId: 'google-antigravity',
    capabilityId: 'google-antigravity',
    routeId: 'google-antigravity',
    accountId: 'acc-1',
    quotaGroupId: resolveAntigravityQuotaGroup('antigravity-claude-sonnet-5-5'),
  });
  assert.equal(poolAgy.quotaPoolId, poolGeminiFlash.quotaPoolId, '同账户下多个 Gemini 模型共享同一额度池');
  assert.notEqual(poolAgy.quotaPoolId, poolClaudeSonnet.quotaPoolId, '同账户下 Gemini 与 Claude 额度池严格分离');
});

test('测试 6：模糊模型名（名称含 gemini 但实际路由到自定义反代）绝不识别为官方额度', () => {
  const proxyPool = computeQuotaPoolId({
    providerId: 'google',
    capabilityId: 'google-antigravity',
    routeId: 'my-custom-proxy',
    credentialRef: 'PROXY_KEY',
    baseURL: 'https://relay.example.com/v1',
    isProxy: true,
  });
  assert.ok(!proxyPool.quotaPoolId.includes('google-antigravity'), '反代路由不得归入 google-antigravity 官方池');
  assert.ok(proxyPool.quotaPoolId.includes('my-custom-proxy'));
});

test('测试 7：无法识别额度组时返回 ambiguous_group（显示“未能确认额度所属模型”），绝不回退使用另一组额度', () => {
  const view = makeMixedAntigravityView();
  assert.equal(resolveAntigravityQuotaGroup('antigravity-mystery-custom-llm'), null);

  const res = parseAntigravityAuthUsage(view, { modelId: 'antigravity-mystery-custom-llm' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ambiguous_group');
  assert.equal(res.ambiguous, true);
  assert.equal(res.usage, null);

  const norm = normalizeToQuotaContract({
    rawResult: res,
    capabilityId: 'google-antigravity',
    quotaPoolId: 'pool:test',
  });
  assert.equal(norm.status, 'unknown');
  assert.equal(norm.ambiguous, true);
});

test('测试 8：UI 交互（侧边栏默认收起、点击展开/收起不触发额外请求、手动刷新按钮触发 force=1、设置页按组展示且缺失窗口标为 unavailable）', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let state = [];
  let effects = [];
  let cleanups = [];
  let cursor = 0;

  const reactStub = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useMemo: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, value: fn() };
      return state[i].value;
    },
    useCallback: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, fn };
      return state[i].fn;
    },
    useEffect: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps?.[k]))) {
        state[i] = { deps };
        effects.push({ fn, i });
      }
    },
    useSyncExternalStore: (_sub, snap) => snap(),
  };

  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, () => reactStub);
  const mod = win.__def.factory(() => reactStub);

  const slots = {};
  const ctx = {
    slots: {
      inject: (_n, fn) => fn(),
      register: (meta, comp) => { slots[meta.name] = comp; },
    },
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh' }),
      register: () => () => {},
      bind: () => (k) => k,
    },
  };
  mod.apply(ctx);

  const fetchCalls = [];
  const view = makeMixedAntigravityView();
  const parsedGemini = parseAntigravityAuthUsage(view, { modelId: 'antigravity-gemini-4-argon' });

  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: 'google-antigravity', displayName: 'Google Antigravity', kind: 'usage', reason: null, via: 'exact' },
        balance: { isAvailable: null, total: null, currency: null },
        usage: parsedGemini.usage,
        peak: false,
        next: { peak: false, at: null, ms: 0 },
        tier: { input: null, cacheRead: null, cacheWrite: null, output: null, model: null, known: false, currency: 'CNY', window: null },
        display: { mode: 'auto', gaugeStyle: 'd-gauge', percentMode: 'remaining', warnThreshold: 60, alertThreshold: 80, showDiagnostics: true },
        activeRoute: { provider: 'google-antigravity', model: 'antigravity-gemini-4-argon' },
        antigravityAccounts: [{ handle: 'acc-1', email: 'u***@example.com', active: true }],
        models: [{
          key: 'google-antigravity/antigravity-gemini-4-argon',
          providerId: 'google-antigravity',
          accountId: 'u***@example.com',
          routeId: 'google-antigravity',
          modelId: 'antigravity-gemini-4-argon',
          displayName: 'Gemini 4 Argon',
          providerDisplayName: 'Google Antigravity',
          sourceType: 'official',
          isProxy: false,
          accountAlias: 'u***@example.com',
          quotaGroupId: 'gemini',
          quotaPoolId: 'pool:google-antigravity:official:acc-1:group:gemini',
          sharedQuotaPool: true,
          status: 'ok',
          stale: false,
          lastSuccessAt: Date.now(),
          usage: parsedGemini.usage,
          missingWindows: ['5h'],
          groups: parsedGemini.groups,
          identity: buildQuotaIdentity({
            providerId: 'google-antigravity',
            accountId: 'u***@example.com',
            routeId: 'google-antigravity',
            requestedModelId: 'antigravity-gemini-4-argon',
            resolvedModelId: 'antigravity-gemini-4-argon',
            quotaGroupId: 'gemini',
            quotaPoolId: 'pool:google-antigravity:official:acc-1:group:gemini',
            sharedQuotaPool: true,
          }),
        }],
        errors: [],
      }),
    };
  };

  const renderSidebar = () => {
    cursor = 0;
    const wrapper = slots['sidebar.footer.action']({ wide: true });
    const out = typeof wrapper.type === 'function' ? wrapper.type(wrapper.props) : wrapper;
    const pending = effects.splice(0, effects.length);
    for (const e of pending) {
      const cleanup = e.fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    return out;
  };
  const allNodes = (node, acc = []) => {
    if (!node || typeof node !== 'object') return acc;
    if (typeof node.type === 'function') return allNodes(node.type(node.props), acc);
    acc.push(node);
    for (const c of node.children || []) allNodes(c, acc);
    return acc;
  };

  try {
    renderSidebar();
    await new Promise((r) => setTimeout(r, 20));
    let out = renderSidebar();

    const usageCallsBefore = fetchCalls.filter((u) => u.startsWith('/api/deepseek-usage?')).length;
    assert.equal(out.props['aria-expanded'], false, '默认处于收起状态');
    assert.equal(allNodes(out).some((n) => n.props?.['data-panel'] === 'sidebar-expanded'), false);

    // 点击展开：切换 aria-expanded=true，且不产生任何额外网络请求！
    out.props.onClick();
    out = renderSidebar();
    assert.equal(out.props['aria-expanded'], true, '点击后进入展开状态');
    assert.equal(allNodes(out).some((n) => n.props?.['data-panel'] === 'sidebar-expanded'), true);
    assert.equal(fetchCalls.filter((u) => u.startsWith('/api/deepseek-usage?')).length, usageCallsBefore, '展开本身不得触发额外额度请求');

    // 键盘 Space / Enter 再次收起：同样不触发额外请求
    out.props.onKeyDown({ key: 'Enter', preventDefault() {} });
    out = renderSidebar();
    assert.equal(out.props['aria-expanded'], false, '按 Enter 后收起');
    assert.equal(fetchCalls.filter((u) => u.startsWith('/api/deepseek-usage?')).length, usageCallsBefore, '收起本身不得触发额外额度请求');

    // 再次展开并点击手动刷新按钮：触发带 force=1 的请求
    out.props.onClick();
    out = renderSidebar();
    const refreshBtn = allNodes(out).find((n) => n.props?.['data-action'] === 'manual-refresh');
    assert.ok(refreshBtn, '展开面板内必须包含手动刷新按钮');
    refreshBtn.props.onClick({ stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(fetchCalls.some((u) => u.includes('force=1')), '点击手动刷新应触发 force=1 请求');
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
});

test('审计项（第六节）：DNS Rebinding SSRF 拦截、3xx 重定向拦截、修改路由保留同 Provider 既有模型、账号脱敏', async () => {
  // 1. DNS 解析到内网/元数据 IP 时拦截
  const dnsCheck = await validateEndpointUrlWithDns('https://evil-rebind.example.com/v1', {
    lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
  });
  assert.equal(dnsCheck.ok, false);
  assert.ok(dnsCheck.reason.includes('dns_resolved'));

  // 2. 3xx 重定向不携带 Bearer 自动跟随
  const redirectRes = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://relay.example.com/v1',
    secret: 'sk-test',
    fetchImpl: async () => ({ status: 302, headers: new Headers({ location: 'http://169.254.169.254/' }) }),
  });
  assert.equal(redirectRes.ok, false);

  // 3. 修改路由添加新模型时不覆盖该路由已有的其他模型
  let mutatedOps = null;
  const mockCtx = {
    get: (name) => {
      if (name === 'settings') {
        return {
          describe: () => [{
            ns: 'llm-pi-ai',
            value: {
              providers: {
                'my-proxy': {
                  displayName: 'My Proxy',
                  models: [{ id: 'existing-model-1', name: 'Existing 1' }],
                },
              },
            },
          }],
          mutate: async (_ns, ops) => { mutatedOps = ops; },
        };
      }
      return null;
    },
  };
  const mutRes = await mutateRoutingConfig(mockCtx, {
    action: 'configureRoute',
    routeId: 'my-proxy',
    modelId: 'new-model-2',
    modelName: 'New 2',
  });
  assert.equal(mutRes.ok, true);
  const modelsOp = mutatedOps.find((op) => op.path[2] === 'models');
  assert.equal(modelsOp.value.length, 2, '必须保留 existing-model-1 并追加 new-model-2');
  assert.equal(modelsOp.value[0].id, 'existing-model-1');
  assert.equal(modelsOp.value[1].id, 'new-model-2');

  // 4. 账户脱敏
  assert.equal(maskAccountId('alice.smith@example.com'), 'al***@example.com');
  assert.equal(maskAccountId('sk-1234567890abcdef'), 'sk-1***def');
});

test('测试 9：v1.0 设置页面模块重排（监控概览在最前，DeepSeek 用量在最后，高级设置默认折叠但组件与配置能力保留）', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let state = [];
  let cursor = 0;
  const reactStub = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useSyncExternalStore: (_sub, snap) => snap(),
  };

  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, () => reactStub);
  const mod = win.__def.factory(() => reactStub);

  const slots = {};
  const ctx = {
    slots: {
      inject: (_n, fn) => fn(),
      register: (meta, comp) => { slots[meta.name] = comp; },
    },
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh' }),
      register: () => () => {},
      bind: () => (k) => k,
    },
  };
  mod.apply(ctx);

  const sampleData = {
    ok: true,
    provider: { id: 'google-antigravity', displayName: 'Google Antigravity' },
    activeRoute: { provider: 'google-antigravity', model: 'antigravity-gemini-4-argon' },
    models: [{
      key: 'google-antigravity/antigravity-gemini-4-argon',
      modelId: 'antigravity-gemini-4-argon',
      displayName: 'Gemini 4 Argon',
      quotaGroupId: 'gemini',
      groups: {
        gemini: { label: 'GEMINI 模型', windows: [{ key: '7d', percent: 10, remainingPercent: 90 }] },
      },
    }],
    antigravityAccounts: [],
  };

  cursor = 0;
  const settingsVnode = slots['settings.section']({ t: (k) => k, initialOverview: sampleData });
  const settingsDiv = settingsVnode.type(settingsVnode.props);
  const configVnode = settingsDiv.children[1];
  const configDiv = configVnode.type(configVnode.props);

  const sectionTypes = configDiv.children.map((c) => c.type.name);
  assert.equal(sectionTypes[0], 'UsageOverviewSection', '第一部分必须为模型监控概览与额度分组');
  assert.equal(sectionTypes[1], 'DisplayTargetSettings', '第二部分为仪表盘与监控设置');
  assert.equal(sectionTypes[2], 'RoutingModelSettings', '第三部分为模型路由设置');
  assert.equal(sectionTypes[3], 'AdvancedSettingsSection', '第四部分为高级设置（折叠提供商映射）');
  assert.equal(sectionTypes[4], 'DeepSeekLegacySection', '最后部分必须为 DeepSeek 用量');

  // 验证高级设置默认折叠，但 DOM 子树依然完整包含提供商映射与保存按钮
  const advancedVnode = configDiv.children[3];
  const advancedDiv = advancedVnode.type(advancedVnode.props);
  assert.equal(advancedDiv.props['data-section'], 'advanced-settings');
  const innerCollapsedDiv = advancedDiv.children[1];
  assert.equal(innerCollapsedDiv.props.style.display, 'none', '高级设置默认折叠隐藏');
  const innerSectionNames = innerCollapsedDiv.children.map((c) => c.type.name);
  assert.ok(innerSectionNames.includes('ProviderAliasesSettings'), '高级设置中必须包含 ProviderAliasesSettings');
  assert.ok(innerSectionNames.includes('OAuthTokenSection'), '高级设置中必须包含 OAuthTokenSection');
});

test('测试 10：v1.0 侧栏收起态表盘直径放大为 54px，展开态移除数据来源显示行但保留数据字段', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let state = [];
  let cursor = 0;
  const reactStub = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useSyncExternalStore: (_sub, snap) => snap(),
  };

  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, () => reactStub);
  const mod = win.__def.factory(() => reactStub);

  // 1. 验证 当前状态下表盘放大为 54px，字号放大为 22px
  const gaugeNode = mod.__internals.renderGaugeWindow({ key: '5h', percent: 20 }, { large: true });
  assert.equal(gaugeNode.props.style.width, 54, '表盘宽度必须放大为 54px（原 45px 的约 1.2 倍）');
  assert.equal(gaugeNode.props.style.height, 54, '表盘高度必须放大为 54px');
  const centerPercentNode = gaugeNode.children.find((c) => c.type === 'span' && c.props.style.fontSize === 22);
  assert.ok(centerPercentNode, '表盘中心百分比字号必须为 22px');

  // 2. 验证侧栏展开详情不渲染“数据来源”行
  const slots = {};
  const ctx = {
    slots: { inject: (_n, fn) => fn(), register: (m, c) => { slots[m.name] = c; } },
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh' }), register: () => () => {}, bind: () => (k) => k },
  };
  mod.apply(ctx);

  const sampleModel = {
    key: 'google-antigravity/antigravity-gemini-4-argon',
    modelId: 'antigravity-gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    providerDisplayName: 'Google Antigravity',
    dataSource: 'official_api', // 数据字段完整保留
    usage: { windows: [{ key: '5h', percent: 20, remainingPercent: 80, resetsAt: Date.now() + 3600000 }] },
  };

  state = [{ ok: true, provider: { id: 'google-antigravity', kind: 'usage' }, models: [sampleModel] }, '', true];
  cursor = 0;
  const wrapper = slots['sidebar.footer.action']({ wide: true });
  const card = wrapper.type(wrapper.props);

  const allNodes = (node, acc = []) => {
    if (!node || typeof node !== 'object') return acc;
    if (typeof node.type === 'function') return allNodes(node.type(node.props), acc);
    acc.push(node);
    for (const c of node.children || []) allNodes(c, acc);
    return acc;
  };
  const renderedText = allNodes(card).flatMap((n) => n.children || []).filter((c) => typeof c === 'string').join(' ');
  assert.ok(!renderedText.includes('数据来源'), '侧栏展开详情严禁出现“数据来源”文字');
  assert.ok(!renderedText.includes('official_api'), '侧栏展开详情严禁渲染 official_api');
  assert.equal(sampleModel.dataSource, 'official_api', '底层数据模型中的 dataSource 字段必须完整保留');
});
