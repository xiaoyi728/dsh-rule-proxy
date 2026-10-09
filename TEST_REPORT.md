# 测试报告

日期：2026-10-09。环境：Node 22.22.3；DSH Web/provider/tools 0.2.0-rc.2；Cordis 4.0.4。

## 自动化结果

`npm test`：32 项通过，0 失败。新增 client-plugin 模块测试覆盖规则文件暂存、原始修订号冲突保护、认证字段不覆盖、超限文件拒绝和只读部署禁写。客户端入口通过 node --check。`npm run test:browser` 在 Chromium 156、1280px 和 390px 视口通过真实 React 夹具交互测试：导入、原子保存、认证字段保留、代理/模型诊断、无页面异常和横向溢出；已检查移动截图。此夹具模拟 configForms/slots，不等于实际 DSH 页面集成验收。测试需要本机 OpenSSL 来生成临时自签名 TLS 证书，不关闭证书校验。

- domain 规则前后端均支持域名本身及子域的边界匹配；本次浏览器回归在桌面/移动视口验证 domain 文件导入、保存、真实 Worker 诊断、大小写和尾点 hostname 规范化、相似域名/路径不命中、停用无效及非法 domain 模式拒绝。原始 regex 规则未改写。规则引擎的命中解释包含 ruleType。
- 原始规则保留、hostname 规范化、停用和开关、路径不参与匹配、模型来源不管理。
- 非法字段/协议/正则拒绝，RE2 不支持的回溯引用拒绝，失败导入保留原规则。
- Schemastery 默认规则及限额校验，真实 Cordis 注册、合法配置重载、非法更新不破坏旧实例、卸载。
- 私网 IP、混合 DNS 公私地址、空解析及取消拒绝。
- 真实 HTTP CONNECT：同 origin 的工具请求走假上游，模拟模型 Undici 客户端保留原路，并发后环境变量/global fetch/global dispatcher 不变。
- 命中上游故障不回退；非命中和 disabled 请求使用独立直连。
- 同源重定向成功，跨源重定向拒绝，跳数限制、大小限制/截断、超时、取消和 dispose 后拒绝。
- SearXNG 真实 socket 测试按 endpoint 路由并返回受限搜索来源。
- 纯搜索失败/截断拒绝；非法 JSON、null 和非 results 数组使用固定错误，不回显响应正文。过滤 javascript/file/相对 URL 和内嵌凭据 URL 后再限制结果数量；空查询、非整数或不在 1–100 的 maxResults 在联网前拒绝。此安全边界测试使用 provider 响应夹具，实际 CONNECT 搜索另有测试。
- isomorphic-git 解析实际 smart HTTP pkt-line 响应；既有 HTTP wire adapter 测试之外，新增原始 HTTPS github.com 路径的 Git 引用查询和 api.github.com API GET 测试，验证 Host、SNI、路径、结果以及代理认证头不进入目标请求。
- 显式工具 schema 编译和诊断执行。
- 内存中真实 Cordis + SystemPrompt + ToolRuntime + WebRuntime + 原生 dsh-tool-web 组合：标准 web_fetch/web_search 经规则 provider 到真实 CONNECT 连接，检查原生输出、同 origin 并发模拟模型客户端的原路线、显式工具可调用及插件卸载后的注销/失败。此测试未读写任何 profile，也未启动 GUI 或真实模型 SDK，不等于完整 DSH 产品启动验收。
- 原生 Loader/Include + ConfigEditor + SettingsForms 在新建临时 profile 中暴露逐字段 volatile 配置；验证 YAML 持久化、修订冲突、非法正则拒绝、secret 脱敏且保存保留、更新后 provider 生效及搜索开启。测试夹具曾将同一目录同时当 profile/home 导致重复 overlay，后分离；插入行的配置需独立覆盖行以符合编辑器分层契约。宿主 reconcile 会重启效果，保留 Fiber 身份不代表 provider 身份或在途请求保持。
- 同一临时 profile 完整卸载并新建 Context/Loader 后重新读盘：恢复 disabled、搜索端点、合法停用规则和保留认证字段；旧 provider 不再可用。保存、失败写入和重启全流程不改变父进程环境、global fetch 或全局 dispatcher。
- 纯 volatile 引用提交的边界测试：阻塞一个 provider 操作后提交新开关，新操作取得新传输，旧操作保持原快照，完成前旧传输不关闭，完成后恰好关闭一次；卸载关闭新传输。本项在 provider 边界阻塞，不作为新的真实网络测试，也不意味着宿主 reconcile 重启能保留请求。
- 代理 407 认证拒绝不回退且错误不泄漏认证值。
- HTTPS CONNECT 将公共固定 IP 用于 CONNECT authority，保留原始 hostname 的 TLS SNI，拒绝不可信证书。
- 本地认证成功路径、HTTP/HTTPS 上游的可信目标 TLS 成功路径通过；HTTPS 上游自身证书也受正常校验。仅给独立测试子进程设置 NODE_EXTRA_CA_CERTS 信任临时证书，父进程环境和信任设置不变，未关闭 TLS 校验。

`npm run test:package`：全新临时目录通过 npm 安装 tarball 的生产依赖，独立 Node 子进程验证包后端导入、12 条默认规则、model 来源不管理、client 文件存在、实际 Cordis/WebRuntime provider 注册和卸载、环境/global fetch/global dispatcher 保持原样。此项不是 GUI 安装或完整 DSH 启动验收，也不访问真实目标/模型 API；临时目录验证绝对路径后清理。README 安装示例已改为原生 profile patch 的 insert + 独立配置覆盖结构。

测试专用 resolver 会允许本地假目标或把假目标映射为公共地址；生产默认 resolver 不接受这种绕过。

## 未验证

真实公网代理及其 TLS/认证成功、公网 GitHub API/仓库、SearXNG 公网服务、DNS64 实际网络、全部公共 IPv6 网络、实际 DSH Web GUI 设置交互和完整模型 provider 客户端。模拟模型客户端证明插件不污染共享全局状态，但不等于每一种模型 SDK 都已公网验收。

## 未实现

Git clone/fetch/push 和私有仓库认证；任意 bash/git/gh/SSH 自动代理；会话级独立开关。专用 GUI 设置页与 JSON 文件上传已通过真实浏览器夹具验证，尚未完成实际 DSH 宿主验收。

当前 GUI/profile 未安装或修改。尚未提供上游协议、地址和端口，无法完成真实上游验收。后端首版可交付，不应把计划全量验收标记完成。
