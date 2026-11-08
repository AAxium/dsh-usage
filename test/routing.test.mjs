// P2 多模型识别、共享额度池、过期快照保留与路由管理测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const CREDENTIALS_STUB = `
export function credentialRef(name) { return { kind: 'credential-ref', name }; }
export default { credentialRef };
`;
const SCHEMASTERY_STUB = `
const chain = () => new Proxy(function () {}, { get: () => chain, apply: () => chain });
const z = {
  object: chain, array: chain, string: chain, number: chain, boolean: chain,
  dict: chain, union: chain, const: chain, any: chain, literal: chain,
};
export default z;
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-credentials') {
      return { url: 'data:text/javascript,' + encodeURIComponent(CREDENTIALS_STUB), shortCircuit: true };
    }
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: 'data:text/javascript,' + encodeURIComponent(SCHEMASTERY_STUB), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  mutateRoutingConfig,
  computeLocalWeeklyWindow,
  discoverRoutesAndModels,
  normalizeDisplayConfig,
  selectTargetModels,
} = await import('../lib/routing.js');
const { apply: applyPlugin } = await import('../lib/index.js');
function apply(ctx, config) { return applyPlugin(ctx, config, { fetchImpl: (...args) => globalThis.fetch(...args), lookupImpl: async () => [{address:'8.8.8.8',family:4}] }); }

function makeMockCtx(options = {}) {
  const routes = new Map();
  let currentSel = {
    provider: options.provider ?? 'deepseek-official',
    model: options.model ?? 'deepseek-chat',
  };
  const mutations = [];
  const ctx = {
    logger: { warn() {} },
    webServer: {
      host: '127.0.0.1:55656',
      register(spec) {
        routes.set(spec.path, spec.handler);
        return () => routes.delete(spec.path);
      },
    },
    effect(fn) {
      return fn();
    },
    credentials: {
      resolve: async (ref) => {
        const name = ref && typeof ref === 'object' && 'name' in ref ? ref.name : String(ref);
        const val = options.refs ? options.refs[name] : (name === 'DEEPSEEK_API_KEY' ? 'sk-ds-test' : undefined);
        return val ? { value: val, source: 'env' } : undefined;
      },
      describe: async (ref) => {
        const name = ref && typeof ref === 'object' && 'name' in ref ? ref.name : String(ref);
        const val = options.refs ? options.refs[name] : (name === 'DEEPSEEK_API_KEY' ? 'sk-ds-test' : undefined);
        return { configured: Boolean(val), source: val ? 'env' : undefined, writable: true };
      },
      set: async () => {},
      unset: async () => {},
    },
    get(serviceName) {
      if (serviceName === 'agentDefaultModel') {
        return {
          currentSelection: () => ({ ...currentSel }),
          saveSelection: async (next) => {
            currentSel = { ...next };
          },
        };
      }
      if (serviceName === 'llm') {
        return {
          listProviders: () => options.providers ?? [
            { id: 'deepseek-official', name: 'DeepSeek' },
            { id: 'siliconflow', name: 'SiliconFlow' },
            { id: 'my-oneapi', name: 'My OneAPI Proxy' },
          ],
          listConfigurableProviders: () => [
            { provider: 'deepseek-official', displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com' },
            { provider: 'siliconflow', displayName: 'SiliconFlow', defaultBaseURL: 'https://api.siliconflow.cn/v1' },
          ],
          listModels: async (p) => {
            if (p === 'deepseek-official') {
              return [
                { id: 'deepseek-chat', name: 'DeepSeek Chat' },
                { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
              ];
            }
            if (p === 'siliconflow') {
              return [{ id: 'deepseek-reasoner', name: 'DeepSeek R1 (SiliconFlow)' }];
            }
            if (p === 'my-oneapi') {
              return [{ id: 'claude-sonnet', name: 'Claude Sonnet (Proxy)' }];
            }
            return [];
          },
        };
      }
      if (serviceName === 'settings') {
        return {
          describe: () => [
            {
              ns: 'include:llm-pi-ai',
              applies: 'live',
              value: {
                providers: {
                  'my-oneapi': {
                    displayName: 'My OneAPI Proxy',
                    api: 'openai-completions',
                    baseURL: 'https://oneapi.example.com/v1',
                    apiKeyEnv: 'MY_ONEAPI_KEY',
                    models: [{ id: 'claude-sonnet', name: 'Claude Sonnet (Proxy)' }],
                  },
                },
              },
            },
          ],
          mutate: async (ns, ops) => {
            mutations.push({ ns, ops });
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, routes, mutations, getSelection: () => currentSel };
}

async function callHandler(handler, { method = 'GET', url = '/api/deepseek-usage', body = null } = {}) {
  let status = 200;
  let payload = '';
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:55656' },
    text: async () => (body ? JSON.stringify(body) : ''),
    headers: {
      host: '127.0.0.1:55656',
      get: () => (body ? String(Buffer.byteLength(JSON.stringify(body))) : '0'),
    },
  };
  const res = {
    headersSent: false,
    writeHead(s) {
      status = s;
      this.headersSent = true;
    },
    end(str = '') {
      payload = str;
    },
  };
  await handler(req, res);
  return { status, body: payload ? JSON.parse(payload) : null };
}

test('P2: 多模型模式选择、排序、隐藏、收藏与别名', async () => {
  const { ctx } = makeMockCtx();
  const displayConfig = normalizeDisplayConfig({
    mode: 'multi',
    selectedModelKeys: [
      'deepseek-official/deepseek-chat',
      'deepseek-official/deepseek-reasoner',
      'siliconflow/deepseek-reasoner',
      'my-oneapi/claude-sonnet',
    ],
    hiddenModelKeys: ['siliconflow/deepseek-reasoner'],
    favoriteModelKeys: ['my-oneapi/claude-sonnet'],
    modelOrder: ['deepseek-official/deepseek-reasoner', 'deepseek-official/deepseek-chat'],
    modelAliases: {
      'deepseek-official/deepseek-chat': 'DS-Chat 主力',
    },
  });
  const discovery = await discoverRoutesAndModels(ctx, { displayConfig });
  const targets = selectTargetModels(discovery, displayConfig);

  assert.equal(targets.length, 3, '隐藏的模型不应出现在监控列表中');
  assert.equal(targets[0].key, 'my-oneapi/claude-sonnet', '收藏的常用模型排在最前');
  assert.equal(targets[0].isProxy, true, '自定义非官方 BaseURL 的路由应标记为 Proxy');
  assert.equal(targets[1].key, 'deepseek-official/deepseek-reasoner', '按用户自定义顺序排列');
  assert.equal(targets[2].key, 'deepseek-official/deepseek-chat');
  assert.equal(targets[2].displayName, 'DS-Chat 主力', '模型别名生效');
});

test('P2: 多模型共享同一账户额度池时自动合并请求并标记 sharedQuotaPool', async () => {
  let upstreamCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '128.00' }],
      }),
      { status: 200 },
    );
  };

  try {
    const { ctx, routes } = makeMockCtx({
      refs: { DEEPSEEK_API_KEY: 'sk-shared-pool-test' },
    });
    apply(ctx, {
      display: {
        mode: 'multi',
        selectedModelKeys: [
          'deepseek-official/deepseek-chat',
          'deepseek-official/deepseek-reasoner',
        ],
      },
    });

    const res = await callHandler(routes.get('/api/deepseek-usage'), {
      url: '/api/deepseek-usage?lang=zh&force=1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.models.length, 2);
    assert.equal(res.body.models[0].quotaPoolId, res.body.models[1].quotaPoolId, '同路由同 Key 的两个模型共享同一 quotaPoolId');
    assert.equal(res.body.models[0].sharedQuotaPool, true, '应标记 sharedQuotaPool=true');
    assert.equal(res.body.models[1].sharedQuotaPool, true);
    assert.equal(upstreamCalls, 1, '同一额度池在单次刷新中只请求一次上游 API');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('P2: 查询失败时保留上次有效数据并标记 stale=true 与 lastSuccessAt', async () => {
  let shouldFail = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (shouldFail) {
      return new Response('Bad Gateway', { status: 502 });
    }
    return new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '66.88' }],
      }),
      { status: 200 },
    );
  };

  try {
    const { ctx, routes } = makeMockCtx({
      refs: { DEEPSEEK_API_KEY: 'sk-stale-test-key' },
    });
    apply(ctx, {});

    // 第一次成功
    const okRes = await callHandler(routes.get('/api/deepseek-usage'), {
      url: '/api/deepseek-usage?lang=zh&force=1',
    });
    assert.equal(okRes.body.balance.total, 66.88);
    assert.equal(okRes.body.stale, false);

    // 第二次强制刷新但上游故障
    shouldFail = true;
    const failRes = await callHandler(routes.get('/api/deepseek-usage'), {
      url: '/api/deepseek-usage?lang=zh&force=1',
    });
    assert.equal(failRes.body.stale, true, '顶层应标记 stale=true');
    assert.equal(failRes.body.staleSnapshot.balance.total, 66.88, 'staleSnapshot 保留上次成功余额');
    assert.equal(typeof failRes.body.lastSuccessAt, 'number');
    assert.equal(failRes.body.models[0].status, 'stale');
    assert.equal(failRes.body.models[0].remaining, 66.88, '模型卡片保留上次余额，同时标明过期状态');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('P2: 本地周统计窗口计算（支持周一/周日开始与自定义时区）', () => {
  const now = Date.parse('2026-11-08T10:00:00+08:00'); // 2026-11-08 是周日
  const monWin = computeLocalWeeklyWindow(now, { weekStartDay: 'monday', timezone: 'Asia/Shanghai' });
  const sunWin = computeLocalWeeklyWindow(now, { weekStartDay: 'sunday', timezone: 'Asia/Shanghai' });

  assert.equal(monWin.dataSource, 'local_session_stats');
  assert.equal(new Date(monWin.windowStartMs).toISOString(), '2026-11-01T16:00:00.000Z', '北京时间周一 00:00');
  assert.equal(new Date(sunWin.windowStartMs).toISOString(), '2026-11-07T16:00:00.000Z', '北京时间周日 00:00');
});

test('P2/P4: /api/deepseek-usage/routing 支持读取、切换默认模型、修改路由配置、测试连通性与安全校验', async () => {
  const { ctx, routes, mutations, getSelection } = makeMockCtx();
  apply(ctx, {});
  const handler = routes.get('/api/deepseek-usage/routing');
  assert.ok(handler, '应注册 /api/deepseek-usage/routing');

  // 1. GET 读取路由表
  const getRes = await callHandler(handler, { method: 'GET', url: '/api/deepseek-usage/routing' });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.ok, true);
  assert.equal(getRes.body.currentDefault.provider, 'deepseek-official');
  assert.ok(getRes.body.routes.some((r) => r.routeId === 'my-oneapi' && r.isProxy === true));

  // 2. POST 切换默认模型
  const selRes = await callHandler(handler, {
    method: 'POST',
    url: '/api/deepseek-usage/routing',
    body: { action: 'selectDefaultModel', provider: 'siliconflow', model: 'deepseek-reasoner' },
  });
  assert.equal(selRes.status, 200);
  assert.equal(getSelection().provider, 'siliconflow');
  assert.equal(getSelection().model, 'deepseek-reasoner');

  // 3. POST 修改路由配置（拦截 SSRF URL）
  const ssrfRes = await callHandler(handler, {
    method: 'POST',
    url: '/api/deepseek-usage/routing',
    body: { action: 'configureRoute', routeId: 'my-oneapi', baseURL: 'http://169.254.169.254/v1' },
  });
  assert.equal(ssrfRes.status, 400);
  assert.equal(ssrfRes.body.error, 'invalid_url');

  // 4. POST 修改合法路由配置
  const cfgRes = await callHandler(handler, {
    method: 'POST',
    url: '/api/deepseek-usage/routing',
    body: {
      action: 'configureRoute',
      routeId: 'my-oneapi',
      baseURL: 'https://gateway.example.com/v1',
      apiKeyRef: 'MY_GATEWAY_KEY',
    },
  });
  assert.equal(cfgRes.status, 200);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].ns, 'include:llm-pi-ai');

  // 5. POST 测试路由连通性
  const testRes = await callHandler(handler, {
    method: 'POST',
    url: '/api/deepseek-usage/routing',
    body: { action: 'testRoute', provider: 'siliconflow', model: 'deepseek-reasoner' },
  });
  assert.equal(testRes.status, 200);
  assert.equal(testRes.body.ok, true);
});


test('路由配置拒绝原型属性名和DNS失败，危险配置不会写入宿主', async () => {
  let writes=0;
  const ctx={get:()=>({mutate:async()=>{writes++}})};
  for(const routeId of ['__proto__','constructor','prototype']) {
    const result=await mutateRoutingConfig(ctx,{action:'configureRoute',routeId});
    assert.equal(result.ok,false);
  }
  const result=await mutateRoutingConfig(ctx,{action:'configureRoute',routeId:'gateway',baseURL:'https://quota.example/'},{lookupImpl:async()=>{throw Error('DNS failure')}});
  assert.equal(result.ok,false);assert.equal(writes,0);
});
