# dsh-rule-proxy

DSH 0.2.0-rc.2 的工具专用 hostname 规则代理插件。当前交付为可测试的后端首版，不是计划全部功能已完成的最终版本。

## 核心边界

- 不修改模型 provider、全局 fetch、全局 Undici dispatcher 或父进程代理环境。
- `web_fetch` 选择 `rule-proxy` provider 后，命中规则走独立 HTTP(S) CONNECT 上游；未命中或 enabled=false 使用独立直连传输。
- 上游失败不回退直连。未配置上游时命中请求失败，不能把“已匹配”误认为“可连通”。
- 规则只匹配规范化 hostname，保持原始字段和顺序。`.*github.*` 会匹配 `notgithub.example.com`，不是严格域名白名单；如需精确域名请使用 `domain` 类型。
- 当前 DeepSeek 搜索后端含推理请求，保持原路径。可选 `rule-proxy-searxng` 只用于显式配置的 SearXNG 纯搜索服务，按该服务 hostname 分流，不按查询词或结果域名分流。

## 已实现

默认导入 rules.json 的规则；RE2-WASM 线性时间正则；原子校验；插件配置 schema；匿名网页 provider；公共 IP/DNS 固定、NAT64 检查；同源重定向限制；取消、超时、响应限制和卸载清理；CLI 和显式工具诊断。

显式工具：

- `rule_proxy_diagnose({url, source})`：不联网，返回路由和命中原因。source=model 表示不受插件管理。
- `github_api_get({path})`：匿名 GitHub API GET，path 可为 `/repos/owner/repo` 或 api.github.com 的 HTTPS URL。
- `github_git_refs({repository})`：公共 `owner/repository` 的 HTTPS Git 引用查询，使用 isomorphic-git 协议解析器及独立传输。

普通 bash/git/gh、第三方 SDK 和 SSH 不自动代理。GitHub 工具首版不提供私有仓库凭据、clone、fetch、push；无全局 Git 配置或子进程环境修改。

## 安装到隔离 Profile

当前 GUI 未安装本插件，当前 profile 未改动。先在独立测试 profile 安装打包文件：

```sh
npm install /home/incam/Software/dsh-rule-proxy/dsh-rule-proxy-0.1.0.tgz
```

先确认终端工作目录是独立测试 profile，而不是当前 GUI 的 profile；上述 npm 命令会修改当前目录的依赖。DSH 原生 profile 使用 `cordis.patch.yml`，不应把普通条目列表误当成 patch。将以下 patch 合并到测试 profile 的现有 patch 数组（不要覆盖其他条目）：

```yaml
- insert:
    - id: rule-proxy
      name: dsh-rule-proxy
- id: rule-proxy
  config:
    enabled: true
    proxyUrl: http://127.0.0.1:7890
- id: web
  config:
    fetchProvider: rule-proxy
```

其中 `web` 必须换成该 profile 实际 WebRuntime 的 entry id。独立配置覆盖行用于让原生 ConfigEditor 正确读写用户层；测试已覆盖这一结构。测试 profile 必须已有 web 服务，使用标准工具还需启用原生 tool-web，设置页需已有原生设置和插件管理客户端服务。若使用自建 Cordis 基准文件而不是 DSH profile patch，才使用普通插件条目结构。

以上上游仅为示例，应换成实际 HTTP/HTTPS 代理，暂不支持 SOCKS。URL 必须是 origin，不允许内嵌凭据、路径或查询串。需要认证时在本机 secret 字段 `proxyToken` 配置完整 Proxy-Authorization 值，不要在对话中发送凭据。schema 的 secret 标记负责 UI 隐藏，不意味着配置文件已加密，请按 profile 的权限策略保护文件。

在已有 `@deepseek-ai/dsh-web` 配置中设置 `fetchProvider: rule-proxy`。保留标准网页工具插件及原搜索 provider。不修改模型插件。

纯搜索可选配置 `searxEndpoint: https://your-search-host/search`，并在 web 服务显式选择 `searchProvider: rule-proxy-searxng`。该搜索服务需要启用 JSON 输出；它的 hostname 必须在规则中才会代理。不能用模型 API URL 冒充 SearXNG。搜索查询须非空，maxResults 为 1–100 的整数（默认 8）；响应失败、截断或非法 JSON 拒绝，解析错误不回显正文。返回来源只接受不含凭据的 HTTP(S) URL；这不代表搜索结果已访问或可信，后续抓取仍执行公共地址校验。

如果同时保留 http 与 rule-proxy provider，必须显式选择一个，否则 web 服务按其既有规则报告 provider 歧义。配置的 `enabled=false` 是关闭分流、改用独立直连；Cordis 的 disabled 是卸载插件，两者不同。

## 配置与持久化

默认使用随包提供的 rules.json。自定义 `rules` 为数组，每项必须包含 include、type、title、pattern、active，且只支持 include/regex 或 include/domain。`domain` 类型匹配精确域名及其子域（如 `github.com` 匹配 `github.com` 和 `api.github.com`，但不匹配 `notgithub.com`），解决正则通配误匹配问题。最多 256 项，pattern 最多 512 字符。包内 client-plugin 提供工具开关、上游和搜索接口编辑、规则 JSON 编辑/文件导入、带修订号的原子保存以及不联网的草稿路由预览。安装时 profile entry id 必须为 `rule-proxy`，并加载 DSH 原生客户端设置和插件管理服务；已通过模块和独立 Chromium 夹具测试，实际 DSH 宿主呈现尚未验收。草稿预览在有时限的 Worker 中使用浏览器正则，不能代替宿主 RE2 校验或实际工具诊断。CLI 接受规则 JSON 文件，使用 RuleEngine.replace 导入时失败不会覆盖旧规则。

限额默认：maxResponseBytes=5000000、maxBodyChars=100000、timeoutMs=30000、maxRedirects=5。复用标准 HTTP provider 的解码与截断契约：明确 Content-Length 超限拒绝，未知长度流式正文按限额截断并标记 truncated。

配置由 Cordis profile 持久化。所有配置字段按原生 SettingsForms 的逐字段 volatile 契约暴露，已在新建临时 profile 的真实 Loader/Include + ConfigEditor + SettingsForms 中验证保存、修订冲突、secret 保留与非法规则拒绝。宿主 reconcile 可能重启插件效果，不能保证更新时在途请求继续；纯 volatile 提交时新操作采用新快照，旧传输在其操作结束后释放。已验证同一隔离 profile 完整卸载、重新启动并读盘后恢复开关、搜索端点、规则停用状态和认证字段；这不是会话状态恢复。新会话使用活动 profile 的 provider，不提供独立会话开关或会话状态恢复。卸载先将 web fetchProvider 改回 http、searchProvider 改回原值，然后移除 rule-proxy 条目与包；仅释放本插件资源。

## 本地验证

```sh
npm test
npm run check
npm run test:browser
npm run diagnose -- https://github.com web-fetch rules.json
npm run diagnose -- https://api.openai.com model rules.json
npm pack
npm run test:package
```

`npm run test:browser` 需要先安装开发依赖并执行 `npx playwright install chromium`。它使用本地 Playwright Chromium 测试独立 React 夹具的桌面/移动交互，不启动 DSH GUI，也不安装插件到当前 profile；它不能替代实际宿主页面验收。

`npm run test:package` 在全新临时目录安装当前 tarball 的生产依赖，再用独立 Node 进程验证后端导入、默认规则、client 文件、Cordis provider 注册/卸载和全局网络状态。需要 npm registry 网络；不会向当前 GUI/profile 安装，结束后删除其临时目录，不联网调用模型或目标网站。可用 `npm run test:package -- /absolute/path/package.tgz` 指定包。

## 待完成和验收限制

诊断只显示 hostname 与命中信息，不联网、不会验证 DNS/上游认证/TLS。日志不输出请求正文、认证值或查询串。

专用设置页已通过真实 Chromium 桌面/移动夹具测试，但未在实际 DSH 宿主验收；完整 Git clone/fetch/push 尚未实现。公网 HTTPS 上游、真实 GitHub API/仓库、认证成功流程、实际 DSH 工具呈现与浏览器设置操作需要提供上游后在隔离 profile 验收。本地测试使用假目标和假上游，不能据此声称真实上游已可用。没有改动 DSH 本体，也没有启动另一个 GUI 服务。

详见 TEST_REPORT.md。规则匹配、工具传输隔离不等于模型服务或远端搜索服务内部网络可控。
