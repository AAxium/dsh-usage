# dsh-usage v1.0.2 — Maintenance & Hardening (Preview)

基于 [dougen/dsh-deepseek-usage](https://github.com/dougen/dsh-deepseek-usage) 二次开发的非官方独立分支。感谢原作者 dougen 及贡献者。

这是由 AAxium 主导、AI 辅助实现和验证的 **vibe coding** 项目，不宣称完全原创，也不将 AI 辅助检查等同于独立人工安全审计。

## 本次修复与加固 (v1.0.2)

- **反代状态精确鉴别**：优化 `lib/adapters.js` 中的 `queryProxyAdapter`，不再使用宽泛的 `!body` 判断错误类型，而是精细区分 401/403（未授权）、404（接口不存在）、5xx（服务器故障）、3xx（重定向拦截）以及 200 非 JSON 响应（损坏格式），避免将服务故障或网络重定向误报为密钥错误。
- **网关命名空间斜杠前缀识别**：在 `isDeepSeekScheduleModel` 中增加 `deepseek/` 前缀识别，支持 OpenRouter 等聚合网关上的 DeepSeek 官方计费模型激活峰谷指示。
- **原型污染防御加固**：
  - `cleanDict` 过滤模型与账户别名中的 `__proto__`、`constructor`、`prototype` 键。
  - `normalizeProxyRoutes` 拦截以原型属性名作为 Provider 的代理项。
  - `mutateRoutingConfig` 在初始参数校验阶段直接拦截 `modelId` 为原型属性名的请求，返回 `invalid_model`。
- **真实本机 HTTPS 自动化硬性校验**：
  - 在 `test/https-independent.test.mjs` 中对不受信任自签证书进行错误类型断言，同时确认未向 HTTP 处理器发送凭据。
  - 严格校验 `ERR_TLS_CERT_ALTNAME_INVALID` 域名不匹配。
  - 服务端实际记录并双重断言 SNI 和 Host 标头。
  - OpenSSL 进程退出码硬性校验，测试生命周期由 `finally` 严格管理，临时密钥使用完毕后即刻销毁。

## 保持的核心功能

- Gemini 与 Claude/GPT 额度组隔离，5 小时和周窗口分别归属；缺失窗口不得跨组补值。
- 侧栏表盘、展开详情、手动刷新和多种显示样式。
- 中文标签为“5时”“周额”“月额”，下标字重较轻。
- 额度颜色从绿到橙再到红连续渐变，并保留自定义阈值。
- 设置页优先显示模型监控概览和额度分组。
- 提供商映射与 OAuth 配置放在默认折叠的高级设置。
- 监控目标与实际模型路由分离。
- 底部 DeepSeek 模块为说明卡片。

## 验证结论

- 本地 Node 24 (Windows)：8 个核心 JS 文件语法检查全部通过。
- 自动化测试套件：**222 项全部通过，0 失败，0 跳过**（包含 3 项独立真实本机 HTTPS 证书与域名硬性验证）。
- 私密安全扫描：在本次检查范围内，未发现真实私钥、Token、API Key 或明文个人邮箱。

## 发布状态与边界

本次为 **Pre-release**，包版本 `1.0.2`，Git 标签 `v1.0.2`。
仅发布于 GitHub Releases，**未发布 npm**。请先备份 DSH 配置，避免同时启用旧版与本分支。
安全网络层仅覆盖本插件发起的查询请求，DSH 宿主自身发起的模型推理连接不属于本插件的控制范围。
对于平台级孤立提交与底层对象缓存，删除或重建仓库不保证平台底层缓存或第三方镜像立即消失。
