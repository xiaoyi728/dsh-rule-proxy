# DSH 规则代理插件开发计划

## 状态与目标

- 当前阶段：后端首版与专用设置页已通过本地自动化测试和真实 Chromium 桌面/移动夹具验证；实际 DSH 宿主、完整 Git 操作和公网验收尚未完成，未安装或修改当前 DSH 配置。
- 实现与范围说明见 `README.md`；实际测试与未验证项目见 `TEST_REPORT.md`。
- 项目目录：`/home/incam/Software/dsh-rule-proxy/`。
- 已核对的本机 DSH 版本：`0.2.0-rc.2`。目标兼容性仍需原型和真实传输测试确认。
- 用户已明确：模型 API 请求保持原有网络路径，不允许按本插件名单分流。只针对 AI 调用网页工具向目标网站发出的请求。
- 原先请求的 web_fetch、web_search 和 GitHub 操作继续作为工具集成范围，但不能通过全局进程代理实现。
- 参考项目：https://github.com/yanglaofish/dsh-proxy-pro 。只参考配置与诊断思路，不沿用其全局代理安装架构。

## 硬约束

- 不调用 `installProxyFromEnvironment` 安装进程级代理，不更换全局 dispatcher 或 globalThis.fetch。
- 不修改父进程 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、NO_PROXY 或对应小写变量。
- 不修改模型 provider、baseURL、认证、重试、流式处理和模型网络客户端。
- “保持正常”指保持模型现有网络路径，而非强行直连；已有用户网络配置不被覆盖。
- 先判断请求是否来自插件覆盖的工具路径，再判断目标 hostname 是否命中名单。同一个域名也可因请求来源不同采用不同路径。
- 不以执行前开启全局代理、执行后关闭的办法模拟工具隔离；并发模型请求会被误伤。

## 输入规则

原始附件：`/home/incam/.dsh/attachments/v1/files/09/096fcbabae47f1ff340a939a19708b65a8d2d32745b589474ae11afdb26a7fd1/规则_sccchendx_2026-10-09.json`。

开发用副本：`rules.json`。保持 include、type、title、pattern、active 字段和顺序，不静默改写。

当前包含 12 条已启用 include/regex 规则，关键词为 github、google、chatgpt、argilla、unsloth、opencode、aihub、huggingface、aireiter、oaistatic、manus、openai。

默认建议对规范化 hostname 执行正则，不匹配路径、查询参数或正文，待确认。`.*github.*` 也会匹配 `notgithub.example.com`，并非严格域名白名单。提供命中解释，后续可增加精确域名模式。

例如：工具读取 developers.openai.com 可命中代理；模型调用 api.openai.com 不进入本插件的规则判断。即使工具与模型访问同一 origin，也必须按来源隔离。

## 修订架构：工具专用传输

独立 Cordis 插件，使用工具/provider 专用 HTTP 传输与独立连接池，不依赖进程全局代理。

1. 检查当前 ctx.web 的 provider 扩展接口、工具作用域与执行入口，验证能否保留原来的 web_fetch/web_search 名称和呈现。
2. 对可接入的网页工具，通过自有 transport 按 hostname 选择上游代理连接或明确的直连连接；不依赖全局 dispatcher。
3. 保留网页工具的 URL 校验、SSRF 防护、DNS 地址固定、取消、大小限制和重定向限制。
4. 若当前标准 HTTP provider 不开放请求级传输注入，则在插件中提供兼容其结果契约的 web provider；优先复用现有解析和安全能力，不绕过限制。
5. GitHub API 使用工具专用 HTTP 客户端；HTTPS Git 通过专用工具/执行路径启动子进程，仅该子进程使用专用代理环境或命令级配置。
6. 只有 Git 等子进程确实需要时才增加工具专用 loopback 分流代理，用成熟组件支持 HTTP/CONNECT；不让模型或整个 DSH 接入它。

接口是否支持上述替换必须先验证，不能仅凭现有全局代理接口宣称插件天然支持。如果只能注册新的显式代理网页工具，需要报告名称/使用方式差异并确认，不偷偷替换所有网络请求，也不默认改 DSH 本体。

## 搜索和 GitHub 的边界

- web_search 按真实搜索服务端点分流，不按查询词或搜索结果域名分流。
- 本机安装的 DeepSeek 搜索后端默认请求 `https://api.deepseek.com/anthropic/v1/messages`，按当前名单不命中。需验证活动 profile 的实际搜索 provider。
- 搜索服务可能内部调用模型 API。用户禁止模型请求受影响：此类推理端点保持原样，不仅因为它从 web_search 发起就套用代理。对纯搜索 HTTP 端点才按工具策略接入。不能控制远端服务内部访问网站的网络路线。
- 支持 GitHub HTTPS API 和专用 HTTPS Git 调用；普通任意 bash/git/gh 命令不自动获得代理，除非已接入明确的工具执行路径。
- 不修改用户全局 Git 配置，不给所有 bash 子进程注入代理；SSH Git 不在首版自动支持范围。
- 插件开关可以持久化，但不能宣称新建会话自动恢复。工具级隔离与会话级隔离是不同能力。
- 插件关闭或卸载只释放插件资源，不改变模型网络环境。

## 开发步骤

### 1. 工具接口与隔离原型

在独立测试 profile 核对 Cordis 生命周期、settings/volatile 更新、tools 注册和 ctx.web provider API。做最小真实传输原型：同时执行网页工具与模型请求，证明只有网页工具进入专用传输。检查同 origin 隔离及标准工具名称能否保留。未证明隔离前不继续全量集成。

### 2. 规则引擎与导入

校验 JSON 数组及字段；预编译、启停、hostname 规范化和命中解释。覆盖上传规则。不支持的 include/type 明确报错。限制数量、长度和正则复杂度，采用安全执行策略避免事件循环阻塞。导入失败不破坏生效规则。

### 3. 工具专用网络传输

使用成熟 HTTP/HTTPS 代理组件与独立连接池；未命中使用明确直连传输。实现超时、取消、流式读取、响应大小限制、连接回收和认证保护。不做 TLS 解密。代理和直连路径都保持公共地址校验、防 DNS rebinding 和重定向检查；私网目标不能被通配规则放行。

### 4. web_fetch、web_search 与 GitHub 集成

实现工具/provider 接入，保留结果契约、工具呈现和网页解码。保留 web_fetch 原有跨源重定向拒绝行为。检查实际搜索 provider；推理类搜索端点保持原样，纯搜索端点用显式传输接入。GitHub API 使用专用客户端，HTTPS Git 只针对受控子进程设置路由；复核环境变量和 Git 配置冲突。不能对未接入的第三方 SDK 或任意 bash 命令承诺代理覆盖。

### 5. 配置与诊断

提供工具代理开关、上游地址、规则 JSON 导入与编辑、URL 路由测试、命中解释和覆盖范围显示。诊断必须区分“工具请求可代理”和“模型请求不受插件管理”。日志不记录认证头、密钥、正文或完整查询串。GUI 设置页按当前 client-plugin API 接入；承诺热更新前验证构建 watcher，否则构建并刷新现有 GUI。

### 6. 验收与交付

先用假目标、假模型端点和假上游观测真实路线，再在隔离 profile 验证真实工具。交付插件包、安装/卸载说明与测试报告；未经确认不接入当前 GUI。

## 验收标准

- 全部活动规则可导入并解释，停用规则无效。
- 命中网页工具请求确实访问上游；未命中网页工具请求直连。
- 上游故障时命中请求明确失败，不静默回退直连；模型请求和非命中请求不受影响。
- 模型请求始终保持此前路线，即使域名命中名单、与网页工具使用同一个 origin、工具同时执行或代理发生故障。
- 插件启停、规则修改、卸载、重启均不改变父进程代理环境、全局 dispatcher 或模型 provider 配置。
- web_fetch、可接入纯搜索端点、GitHub API、专用 HTTPS Git 分别用真实传输验证。
- DeepSeek 等推理类搜索端点保持原有路径；不宣称远端搜索访问也受本插件控制。
- 覆盖并发、取消、超时、非法和危险正则、私网目标、DNS、重定向、认证失败、资源清理。
- 配置持久化和新会话行为有明确说明，不将工具隔离误报为会话隔离。

## 开发前待确认

- 已确认：模型请求不得按插件名单分流，保持现有网络路径。
- 尚未提供：网页工具使用的上游代理协议、主机及端口。这仅配置工具传输，不配置模型；不要在对话中提供密码、API Key 或 Token。
- 待确认：默认 hostname 正则匹配，还是需要完整 URL 匹配。
- 按此前范围保留：GitHub HTTPS 工具操作；SSH 与任意 bash 的透明代理不默认纳入。

## 已核对接口依据

- DSH 版本：`/home/incam/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/package.json:4`。
- 全局代理安装接口（新架构禁止调用来管理整个进程）：`/home/incam/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-http-proxy/lib/types/install.d.ts:84`。
- web_fetch 现有路由分支：`/home/incam/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js:501`。
- web_fetch 工具通过 ctx.web.fetch 发起：`/home/incam/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js:805`。
- DeepSeek 搜索默认端点：`/home/incam/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek/README.zh.md:36`。
