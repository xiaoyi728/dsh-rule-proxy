# dsh-rule-proxy

一个 DeepSeek Harness（DSH）插件：按 **hostname 规则**为网页工具（web_fetch / GitHub 工具 / 可选纯搜索）提供**隔离的 HTTP(S) 代理通道**——命中规则走你指定的上游代理，未命中走独立直连；两条路径都不触碰模型请求与全局网络环境。

区别于“全局代理接管”类插件（dsh-plugin-proxy / dsh-proxy-pro）的核心差异：

- **按规则分流，而非全局接管**：`registerFetchProvider` 自持独立传输（每请求新建 Agent/ProxyAgent、公网 IP/DNS 钉选、NAT64 检查），不修改模型 provider、全局 fetch、全局 Undici dispatcher 或父进程代理环境；模型请求与第三方子进程保持原网络路径。
- **上游不可用自动回退直连**：命中规则优先走上游；上游未配置或连接失败时自动改走直连、不向工具报错，只有直连也失败才返回工具错误。
- **域名精确匹配优先**：`domain` 类型按精确域名及子域匹配（`github.com` 匹配 `api.github.com`，不匹配 `notgithub.com`），`regex` 类型用 RE2-WASM 线性时间匹配 hostname，拒绝正则通配误匹配。
- **规则引擎内存安全**：re2-wasm 编译实例无法释放（固定 16 MiB 堆），pattern 编译一次终身复用、配置快照按值比较，杜绝 OOM（见 [`docs/LESSONS.md`](docs/LESSONS.md) §1–2）。
- **对话头部一键开关**：每会话头部胶囊按钮（绿 = ON / 红 = OFF），一点切换工具代理；与设置页共享同一状态 store，两处显示永远一致。
- **设置页可视化排障**：「设置 → 工具规则代理」内含不联网的路由诊断（输入 URL → 命中规则 / 代理或直连）；保存、导入前先校验规则，非法表达式当场拒绝。
- **干净卸载**：仅释放本插件资源，不残留全局状态。

> 踩坑与设计决策见 [`docs/LESSONS.md`](docs/LESSONS.md)（必读），测试报告见 [`TEST_REPORT.md`](TEST_REPORT.md)。

## 安装

**方式 A：DSH 插件命令（推荐）**

```sh
dsh plugin --profile web add dsh-rule-proxy
```

在 GUI 里也可以 **插件 → 添加插件** 直接输入包名 `dsh-rule-proxy`。

**方式 B：从 GitHub 源码安装**

```sh
dsh plugin --profile web add github:xiaoyi728/dsh-rule-proxy
```

本插件没有 `prepare` / `build` 脚本，`files` 直接指向 `src`，因此源码安装不会触发 pnpm 的 `allowBuilds` 构建授权。

**方式 C：本地目录（开发自测）**

在 **插件 → 添加插件** 中输入本仓库的绝对路径，例如 `/path/to/dsh-rule-proxy`。

无论哪种方式，装完后都需要把 web 服务的 `fetchProvider` 指向 `rule-proxy`：DSH 原生 profile 使用 `cordis.patch.yml`，不应把普通条目列表误当成 patch；将以下 patch **合并**进 profile 现有 patch 数组（不要覆盖其他条目）：

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

其中 `web` 必须换成该 profile 实际 WebRuntime 的 entry id；独立配置覆盖行用于让原生 ConfigEditor 正确读写用户层。profile 需已有 web 服务，使用标准工具还需启用原生 tool-web，设置页需已有原生设置和插件管理客户端服务。若使用自建 Cordis 基准文件而不是 DSH profile patch，才使用普通插件条目结构。安装完成后启动 `dsh web`。

### 它会接管什么、数据去哪

只接管**命中规则的网页工具请求**（web_fetch / GitHub 工具 / 可选的 SearXNG 纯搜索）：这些请求通过你在设置里填的上游代理发出；未命中规则、或上游不可用时的回退请求，走本插件自持的直连传输。模型请求、全局 fetch、全局 Undici dispatcher 和父进程代理环境都不被修改。插件不发送任何遥测；规则、代理地址和 `proxyToken` 只存在于你的 profile 配置文件中，`proxyToken` 永不通过接口回传。

## 使用

**对话头部胶囊按钮** —— 每会话头部右侧的「● 代理 ON/OFF」：绿点 = 工具代理生效、红点 = 关闭；一点切换总开关，悬停显示活动规则数与上游地址。

**设置 → 工具规则代理** ——

- **工具代理开关**：关闭后规则仍然匹配，但网页工具改为直连。注意与 Cordis 的 `disabled` 不同——那是整个插件卸载。
- **上游 HTTP(S) 代理**：命中规则的请求通过此地址连接。必须是 origin（不含路径、查询串、内嵌凭据）；暂不支持 SOCKS。需要认证时在 secret 字段 `proxyToken` 配置完整 `Proxy-Authorization` 值——只写字段，接口永不返回；schema 的 secret 标记只负责 UI 隐藏，不等于配置文件已加密，请按 profile 权限策略保护文件，不要在对话中发送凭据。
- **SearXNG 接口**（可选）：仅用于纯搜索服务；该服务需开启 JSON 输出，且其 hostname 命中规则才会走代理，不按查询词或结果域名分流。
- **规则 JSON 编辑与导入**：保存、导入前校验，非法表达式当场拒绝，不会写进配置导致下次启动失败。
- **路由诊断**：输入 URL 预览规则命中（不联网，在有时限的 Worker 中执行）；最终以宿主 RE2 校验和 `rule_proxy_diagnose` 工具为准。

**模型侧工具** ——

| 工具 | 说明 |
| --- | --- |
| `rule_proxy_diagnose({url, source})` | 不联网，返回路由与命中原因；`source=model` 表示不受插件管理 |
| `github_api_get({path})` | 匿名 GitHub API GET；`path` 可为 `/repos/owner/repo` 或 api.github.com 的 HTTPS URL |
| `github_git_refs({repository})` | 公共 `owner/repository` 的 HTTPS Git 引用查询（isomorphic-git 协议解析器 + 独立传输） |

普通 bash/git/gh、第三方 SDK 和 SSH 不自动代理。GitHub 工具不提供私有仓库凭据、clone、fetch、push；不修改全局 Git 配置或子进程环境。

**CLI** —— `npm run diagnose -- <url> <source> <rules.json>` 本地验证路由；`RuleEngine.replace` 导入失败不会覆盖旧规则。

## 配置

配置由 Cordis profile 持久化，所有字段按原生 SettingsForms 的逐字段 volatile 契约暴露（见 [`docs/LESSONS.md`](docs/LESSONS.md) §4）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` = 规则仍匹配但改为独立直连 |
| `proxyUrl` | `''` | 上游 HTTP(S) 代理 origin；为空或连接失败时自动直连 |
| `proxyToken` | `''` | 只写 secret：完整 `Proxy-Authorization` 值 |
| `rules` | 随包 `rules.json` | 分流规则数组（见下） |
| `searxEndpoint` | `''` | 可选 SearXNG 纯搜索端点 |
| `maxResponseBytes` | `5000000` | 响应字节上限；Content-Length 超限拒绝，未知长度流式截断并标记 `truncated` |
| `maxBodyChars` | `100000` | 正文转文本字符上限 |
| `timeoutMs` | `30000` | 请求超时 |
| `maxRedirects` | `5` | 重定向上限（同源限制） |

**规则格式**：数组，每项必须包含 `include`、`type`、`title`、`pattern`、`active` 五个字段，只支持 `include/regex` 或 `include/domain`：

```json
[
  { "include": "include", "type": "domain", "title": "GitHub domain", "pattern": "github.com", "active": true },
  { "include": "include", "type": "regex", "title": "OpenAI hosts", "pattern": "(^|\\.)openai\\.com$", "active": true }
]
```

规则只匹配规范化 hostname（小写、去尾点），保持原始字段和顺序。最多 256 项，pattern 最多 512 字符。宿主使用 RE2：不支持反向引用与先行断言，设置页保存前会先行拒绝这些构造。

**web 服务挂接**：在 `@deepseek-ai/dsh-web` 配置中设置 `fetchProvider: rule-proxy`（同时保留 `http` 与 `rule-proxy` 时必须显式选一，否则 web 服务报告 provider 歧义）；启用纯搜索时设置 `searchProvider: rule-proxy-searxng`。保留标准网页工具插件与原搜索 provider，不修改模型插件。搜索查询须非空，`maxResults` 为 1–100 的整数（默认 8）；响应失败、截断或非法 JSON 拒绝，解析错误不回显正文；来源只接受不含凭据的 HTTP(S) URL，后续抓取仍执行公共地址校验。

## 卸载

1. 将 web 服务的 `fetchProvider` 改回 `http`、`searchProvider` 改回原值；
2. 移除 `rule-proxy` 插件条目与包。

卸载只释放本插件资源。已在隔离 profile 验证完整卸载、重新启动并读盘后恢复开关、搜索端点、规则停用状态和认证字段（这是配置持久化，不是会话状态恢复；新会话使用活动 profile 的 provider）。

## 技术方案

### 关键模块

| 模块 | 职责 |
| --- | --- |
| `src/index.js` | 插件装配：schema、按值快照、provider 注册、晚绑定配置接口 |
| `src/rules.js` | RE2 规则引擎 + 编译缓存（每 pattern 编译一次，终身复用） |
| `src/transport.js` | 隔离传输：每请求 Agent/ProxyAgent、HTTP(S) CONNECT 上游、超时/取消/限额 |
| `src/public-network.js` | 公共 IP/DNS 钉选、NAT64 检查 |
| `src/provider.js` | 匿名网页 fetch provider（同源重定向限制） |
| `src/search.js` | 可选 SearXNG 纯搜索 provider |
| `src/github.js` | 匿名 GitHub API 与 Git 引用工具 |
| `src/api.js` | 设置页宿主同源接口（loopback + sec-fetch-site + Origin 围栏） |
| `src/client.js` | 设置面板与头部胶囊按钮（双插槽注册，共享状态 store） |
| `src/tools.js` / `src/cli.js` | 模型工具注册 / 本地诊断 CLI |

### 关键设计细节

- 不修改模型 provider、全局 fetch、全局 Undici dispatcher 或父进程代理环境。
- 命中规则走独立 HTTP(S) CONNECT 上游；未命中或 `enabled=false` 使用独立直连传输。
- 上游不可用自动回退直连：命中规则优先走上游；上游未配置或连接失败时自动改走直连，只有直连也失败才返回工具错误（用户策略：有上游用上游，没上游直连，不报错）。
- 规则只匹配规范化 hostname：`.*github.*` 会匹配 `notgithub.example.com`，不是严格域名白名单，如需精确请使用 `domain` 类型。
- 当前 DeepSeek 搜索后端含推理请求，保持原路径；`rule-proxy-searxng` 只按该服务 hostname 分流。
- 纯 volatile 配置提交时新操作采用新快照，旧传输在其操作结束后释放；宿主 reconcile 可能重启插件效果，不能保证更新时在途请求继续。
- 设置页经宿主同源接口 `/dsh-rule-proxy/api/config` 读写配置，只接受同源或本机回环请求。

## 开发

```sh
npm test                # node --test，40 条单测
npm run check           # 语法检查
npm run test:browser    # Playwright 桌面/移动夹具（需 npx playwright install chromium）
npm run test:package    # 临时目录安装 tarball，验证生产依赖与 Cordis 注册/卸载
npm run diagnose -- https://github.com web-fetch rules.json
npm run diagnose -- https://api.openai.com model rules.json
```

`npm run test:browser` 使用本地 Playwright Chromium 测试独立 React 夹具的桌面/移动交互，不启动 DSH GUI、不安装插件到当前 profile，不能替代实际宿主页面验收。`npm run test:package` 在全新临时目录安装当前 tarball 的生产依赖并用独立 Node 进程验证后端导入、默认规则、client 文件、Cordis provider 注册/卸载和全局网络状态；需要 npm registry 网络，不会向当前 GUI/profile 安装，结束后删除临时目录。可用 `npm run test:package -- /absolute/path/package.tgz` 指定包。

## 待完成和验收限制

诊断只显示 hostname 与命中信息，不联网、不会验证 DNS/上游认证/TLS。日志不输出请求正文、认证值或查询串。完整 Git clone/fetch/push 尚未实现。公网 HTTPS 上游、真实 GitHub API/仓库、认证成功流程、实际 DSH 工具呈现与浏览器设置操作需要提供上游后在隔离 profile 验收；本地测试使用假目标和假上游，不能据此声称真实上游已可用。没有改动 DSH 本体。

详见 [TEST_REPORT.md](TEST_REPORT.md)。规则匹配、工具传输隔离不等于模型服务或远端搜索服务内部网络可控。

## 许可

MIT
