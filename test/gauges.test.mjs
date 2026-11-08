// P3 & P4 表盘样式、百分比模式、3 级阈值预警与设置草稿测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_sub, snap) => snap(),
};

const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
new Function('window', 'require', source)(win, (id) => (id === 'react' ? reactStub : {}));
const mod = win.__def.factory((id) => (id === 'react' ? reactStub : {}));
const I = mod.__internals;

test('P3: 3 级阈值预警判定（0-59% 正常、60-79% 注意、80-100% 预警）与自定义阈值', () => {
  // 默认按已用比例：0~59 normal, 60~79 warn, 80~100 alert
  assert.equal(I.thresholdLevel(0), 'normal');
  assert.equal(I.thresholdLevel(59.9), 'normal');
  assert.equal(I.thresholdLevel(60), 'warn');
  assert.equal(I.thresholdLevel(79.9), 'warn');
  assert.equal(I.thresholdLevel(80), 'alert');
  assert.equal(I.thresholdLevel(100), 'alert');
  assert.equal(I.thresholdLevel(null), 'unknown');

  // 剩余百分比输入模式：剩余 35% 等于已用 65% -> warn；剩余 15% 等于已用 85% -> alert
  assert.equal(I.thresholdLevel(50, { inputMode: 'remaining' }), 'normal');
  assert.equal(I.thresholdLevel(35, { inputMode: 'remaining' }), 'warn');
  assert.equal(I.thresholdLevel(15, { inputMode: 'remaining' }), 'alert');

  // 自定义阈值（如 warn=50, alert=90）
  assert.equal(I.thresholdLevel(55, { warnThreshold: 50, alertThreshold: 90 }), 'warn');
  assert.equal(I.thresholdLevel(85, { warnThreshold: 50, alertThreshold: 90 }), 'warn');
  assert.equal(I.thresholdLevel(90, { warnThreshold: 50, alertThreshold: 90 }), 'alert');

  // 3 种颜色区分明确且均为主题变量混合色
  const cNorm = I.thresholdColor(20);
  const cWarn = I.thresholdColor(65);
  const cAlert = I.thresholdColor(85);
  assert.notEqual(cNorm, cWarn);
  assert.notEqual(cWarn, cAlert);
  assert.notEqual(cNorm, cAlert);
});

test('P3: 表盘中心数值支持「剩余百分比」与「已使用百分比」两种模式', () => {
  assert.equal(I.formatCenterPercent(25, 'remaining'), '75');
  assert.equal(I.formatCenterPercent(25, 'used'), '25');
  assert.equal(I.formatCenterPercent(null, 'remaining'), '—');
  assert.equal(I.formatCenterPercent(NaN, 'used'), '—');
});

test('P3: 5 种表盘样式（原始 D 形、圆环、半圆、紧凑卡片、详细卡片）均可正常渲染且无上限数据不画假进度环', () => {
  const sampleWin = { key: '5h', percent: 30, resetsAt: Date.now() + 3600_000 };

  const dGauge = I.renderGaugeWindow(sampleWin, { style: 'd-gauge', percentMode: 'remaining' });
  assert.ok(dGauge);
  assert.equal(dGauge.children[0].type, 'svg');

  const ring = I.renderGaugeWindow(sampleWin, { style: 'ring', percentMode: 'remaining' });
  assert.ok(ring);
  assert.equal(ring.props['data-gauge-style'], 'ring');
  assert.equal(ring.children[0].type, 'svg');

  const semi = I.renderGaugeWindow(sampleWin, { style: 'semicircle', percentMode: 'used' });
  assert.ok(semi);
  assert.equal(semi.props['data-gauge-style'], 'semicircle');
  assert.equal(semi.children[0].type, 'svg');
  // used 模式下中心数值应为 30
  assert.equal(semi.children[1].children[0], '30');

  const compact = I.renderGaugeWindow(sampleWin, { style: 'compact', percentMode: 'remaining' });
  assert.ok(compact);
  assert.equal(compact.props['data-gauge-style'], 'compact');

  const detailed = I.renderGaugeWindow(sampleWin, { style: 'detailed', percentMode: 'remaining' });
  assert.ok(detailed);
  assert.equal(detailed.props['data-gauge-style'], 'detailed');

  // 缺失或无上限百分比绝不绘制虚假进度环
  assert.equal(I.renderGaugeWindow({ key: '5h', percent: null }, { style: 'ring' }), null);
  assert.equal(I.renderGaugeWindow(null, { style: 'd-gauge' }), null);
});

test('P4: displayDraftOf 兼容旧配置并提供完整默认值', () => {
  const empty = I.displayDraftOf(null);
  assert.equal(empty.mode, 'auto');
  assert.equal(empty.gaugeStyle, 'd-gauge');
  assert.equal(empty.percentMode, 'remaining');
  assert.equal(empty.warnThreshold, 60);
  assert.equal(empty.alertThreshold, 80);

  const custom = I.displayDraftOf({
    display: {
      mode: 'multi',
      gaugeStyle: 'ring',
      percentMode: 'used',
      selectedModelKeys: ['deepseek-official/deepseek-chat'],
    },
  });
  assert.equal(custom.mode, 'multi');
  assert.equal(custom.gaugeStyle, 'ring');
  assert.equal(custom.percentMode, 'used');
  assert.deepEqual(custom.selectedModelKeys, ['deepseek-official/deepseek-chat']);
});


test('中文周期标签和所有表盘随额度变色，显示模式不改变健康程度', () => {
  assert.equal(I.windowBadge('5h', 'zh'), '5时');
  assert.equal(I.windowBadge('7d', 'zh'), '周额');
  assert.equal(I.windowBadge('5h', 'en'), '5H');
  for (const style of ['d-gauge', 'ring', 'semicircle', 'compact', 'detailed']) {
    const render = (percent, mode = 'remaining') => I.renderGaugeWindow({ key: '7d', percent }, { style, lang: 'zh', percentMode: mode });
    const text = (node) => typeof node === 'string' ? node : (node?.children || []).map(text).join(' ');
    assert.ok(text(render(18)).includes('周额') || style === 'detailed');
    assert.ok(JSON.stringify(render(18)).includes('--dsw-alias-state-success-primary'));
    assert.ok(JSON.stringify(render(65)).includes('--dsw-alias-state-warn-primary'));
    assert.ok(JSON.stringify(render(90)).includes('--dsw-alias-state-error-primary'));
    assert.ok(JSON.stringify(render(90, 'used')).includes('--dsw-alias-state-error-primary'));
  }
});


test('表盘颜色在预警阈值两侧连续混合，周期标签使用较轻字重', () => {
  const gauge = (used) => I.renderGaugeWindow({key: '5h', percent: used}, {lang: 'zh'});
  const color = (used) => gauge(used).children[0].children[0].props.style.stroke;
  assert.ok(color(30).includes('50.000%'));
  assert.ok(color(59.99).includes('0.017%'));
  assert.ok(color(60.01).includes('99.950%'));
  assert.ok(color(79.99).includes('0.050%'));
  assert.ok(color(80).includes('--dsw-alias-state-error-primary'));
  assert.equal(gauge(30).children.find(n => n.type === 'span' && n.children.includes('5时')).props.style.fontWeight, 500);
  const custom = I.renderGaugeWindow({key:'5h',percent:40}, {warnThreshold:40,alertThreshold:90});
  assert.ok(custom.children[0].children[0].props.style.stroke.includes('0.000%'));
});
