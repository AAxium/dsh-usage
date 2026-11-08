import test from 'node:test';
import assert from 'node:assert/strict';
import { queryProxyAdapter } from '../lib/adapters.js';
import { isDeepSeekScheduleModel } from '../lib/pricing.js';
import { normalizeDisplayConfig, normalizeProxyRoutes, mutateRoutingConfig } from '../lib/routing.js';

test('P1-fix: queryProxyAdapter reports unauthorized when token endpoint 404 and subscription endpoint 401', async () => {
  const res = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://proxy.example.com/v1',
    secret: 'sk-invalid',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/usage/token')) {
        return new Response('Not Found', { status: 404 });
      }
      if (String(url).endsWith('/v1/dashboard/billing/subscription')) {
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unauthorized');
});

test('P1-fix: queryProxyAdapter reports unauthorized when token endpoint 401 and subscription endpoint 404', async () => {
  const res = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://proxy.example.com/v1',
    secret: 'sk-invalid',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/usage/token')) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (String(url).endsWith('/v1/dashboard/billing/subscription')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unauthorized');
});

test('P1-fix: queryProxyAdapter distinguishes 500 server error, redirect and invalid JSON from unauthorized', async () => {
  // 1. 500 内部错误必须报告 unavailable，绝不能误判为 unauthorized 或 proxy_unsupported
  const res500 = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://proxy.example.com/v1',
    secret: 'sk-test',
    fetchImpl: async () => new Response('Internal Server Error', { status: 500 }),
  });
  assert.equal(res500.ok, false);
  assert.equal(res500.code, 'unavailable');

  // 2. 302 重定向必须被拦截并报告 network，绝不冒充 401 或跟随重定向
  const resRedirect = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://proxy.example.com/v1',
    secret: 'sk-test',
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.com' } }),
  });
  assert.equal(resRedirect.ok, false);
  assert.equal(resRedirect.code, 'network');

  // 3. 200 返回 HTML 或损坏 JSON 必须报告 shape，不能误判为未配置或不支持
  const resBadJson = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://proxy.example.com/v1',
    secret: 'sk-test',
    fetchImpl: async () => new Response('<html>Error Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(resBadJson.ok, false);
  assert.equal(resBadJson.code, 'shape');

  // 4. 双 404 准确报告 proxy_unsupported
  const res404 = await queryProxyAdapter({
    proxyType: 'oneapi',
    baseURL: 'https://proxy.example.com/v1',
    secret: 'sk-test',
    fetchImpl: async () => new Response('Not Found', { status: 404 }),
  });
  assert.equal(res404.ok, false);
  assert.equal(res404.code, 'proxy_unsupported');
});

test('P2-fix: isDeepSeekScheduleModel supports slash-prefixed names from gateways like OpenRouter', () => {
  assert.equal(isDeepSeekScheduleModel('deepseek/deepseek-chat'), true);
  assert.equal(isDeepSeekScheduleModel('deepseek/deepseek-v4.1-flash-1017'), true);
  assert.equal(isDeepSeekScheduleModel('deepseek-flash'), true);
  assert.equal(isDeepSeekScheduleModel('deepseek.v3'), true);
  assert.equal(isDeepSeekScheduleModel('openai/gpt-4o'), false);
  assert.equal(isDeepSeekScheduleModel('claude-3-5-sonnet'), false);
});

test('P4-fix: cleanDict and normalizeDisplayConfig protect against real enumerable prototype keys via JSON.parse', () => {
  const parsedAliases = JSON.parse('{"__proto__": "evil", "constructor": "evil", "prototype": "evil", "deepseek/chat": "DeepSeek V3"}');
  assert.equal(Object.prototype.hasOwnProperty.call(parsedAliases, '__proto__'), true, 'JSON.parse 必须产生真实的可枚举 __proto__ 自身属性');

  const cfg = normalizeDisplayConfig({
    modelAliases: parsedAliases,
    accountAliases: JSON.parse('{"__proto__": "polluted", "constructor": "polluted", "prototype": "polluted", "acc-1": "Primary"}'),
  });

  assert.equal(Object.prototype.hasOwnProperty.call(cfg.modelAliases, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.modelAliases, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.modelAliases, 'prototype'), false);
  assert.equal(cfg.modelAliases['deepseek/chat'], 'DeepSeek V3');

  assert.equal(Object.prototype.hasOwnProperty.call(cfg.accountAliases, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.accountAliases, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.accountAliases, 'prototype'), false);
  assert.equal(cfg.accountAliases['acc-1'], 'Primary');
  assert.equal({}.polluted, undefined, '全局原型绝不能被污染');
});

test('P4-fix: normalizeProxyRoutes ignores entries with prototype property names as provider', () => {
  const routes = normalizeProxyRoutes([
    { provider: '__proto__', adapter: 'oneapi' },
    { provider: 'constructor', adapter: 'oneapi' },
    { provider: 'my-proxy', adapter: 'oneapi', baseURL: 'https://proxy.example.com' },
  ]);
  assert.equal(routes.has('__proto__'), false);
  assert.equal(routes.has('constructor'), false);
  assert.equal(routes.has('my-proxy'), true);
});

test('P4-fix: mutateRoutingConfig rejects prototype property name as modelId', async () => {
  const ctx = {
    get(name) {
      if (name === 'settings') return { mutate: async () => {} };
      return null;
    },
  };
  const res = await mutateRoutingConfig(ctx, {
    action: 'configureRoute',
    routeId: 'custom-provider',
    modelId: '__proto__',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_model');
});
