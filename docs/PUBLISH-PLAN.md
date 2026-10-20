# dsh-rule-proxy：让这两个界面看到它

> 目标面（按截图）：
> ① 官方 **添加插件** 弹窗（`@deepseek-ai/dsh-client-ui-plugin-manager`）
> ② **dsh-market** 插件市场（`dshmarket` v1.66.42）
>
> 依据：本机 `@deepseek-ai/dsh@0.2.1-rc.2` 源码、`dshmarket@1.66.42` 源码、社区目录 `awesome-dsh-plugin`
> 的 `contributing.md` 与 `check-submission.mjs`。结论均已核对实现。

## 状态：已完成 / 待你执行

| 项 | 状态 |
|---|---|
| LICENSE、publishConfig、repository/homepage/bugs、keywords | ✅ 已提交 `692d4fe` |
| README 安装段重写（npm 为主、GitHub 与本地目录为备选）+ "接管什么、数据去哪" | ✅ 同上 |
| GitHub topic `dsh-plugin` 等 5 个、仓库描述与 homepage | ✅ 已设置 |
| lockfile 从 npmmirror 统一到 npmjs（integrity 未变，`npm ci` 实测通过） | ✅ `7fd2bdd` |
| 自建 format-1 索引生成器 + 官方校验器自检 | ✅ `74fc553` |
| 修掉发布包里泄漏的内网代理地址 | ✅ `68911ae` |
| **npm publish** | ⏸ **需要你的 npm 凭证** |
| 社区列表 PR | ✅ [PR #8205](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8205) 已开，CI `check` SUCCESS，等人工评审 |

## 0. 这两个面不是一种机制

| | ① 官方「添加插件」弹窗 | ② dsh-market 市场页 |
|---|---|---|
| 本质 | **安装器**：按你输入的 spec 装，没有目录可浏览 | **目录浏览器**：读社区目录 JSON |
| "被扫描" | **不存在**。不扫 npm、不扫磁盘 | 存在，条目来自 awesome 列表 |
| 被看见的条件 | 可安装 spec：包名 / `github:owner/repo` / tarball / 本地路径 | 被合并进 `data/plugins/*.yml` |

官方弹窗会先 `pluginManager.inspect` 读出 spec 指向什么（包名、版本、是否声明组合包），再跑 pnpm；
包内没有 `dsh.bundle` patch 会被直接拒绝。本插件有 `cordis.patch.yml`。

dsh-market 是纯目录驱动：`https://awesome-dsh-plugin.com/plugins.json`（大陆走 npm 包 `dsh-plugin-catalog` 同一份数据），
每日刷新，并按 manifest 的 `engines.dsh`（以及 `dsh.engines.dsh`、相关 peerDependencies）自过滤——
截图里「已隐藏 424 个与 DSH 0.2.1-rc.2 不兼容的插件」就是这层。它用
`satisfiesRange(hostVersion, range, { includePrerelease: true })`，与本插件的
`>=0.2.0-rc.2 <0.3.0` 相容，不会被隐藏。

## 1. 已做的验证

**本地**

```
npm run check          → 语法通过
npm test               → 40/40 通过
npm run test:package   → tarball 安装、后端导入、默认规则、client 产物、
                         Cordis 注册/卸载全通过
npm run test:index     → 官方 parseMarketIndex 校验索引，安装 spec = dsh-rule-proxy@0.1.1
npm pack --dry-run     → 20 个文件，含 cordis.patch.yml 与 LICENSE
```

**真实宿主**

在独立 profile 里用 tarball 安装并启动 `dsh web`：

- `dsh plugin --profile <name> add <tarball>` 自动把 `dsh-rule-proxy` 写进
  `dsh.profile.bundles`——这正是官方插件页识别 bundle 的依据；
- 启动无插件激活错误；
- 插件自有路由 `/dsh-rule-proxy/api/config` 返回 **200**，而故意拼错的
  `/no-such-plugin/api/config` 返回 **404**：说明插件在宿主里真实挂载了路由，不是纸面推断。

**兼容性**

用 `evaluatePluginCompatibility` 实测：0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.2 均 COMPATIBLE，0.3.0 不满足
`<0.3.0` 上限。

## 2. 过程中发现并修掉的发布阻塞项

**发布包泄漏了开发机的内网代理地址。** `src/client.js` 里「上游 HTTP(S) 代理」输入框的
`placeholder` 写死为 `http://10.20.15.242:10880`，会随 npm 包发给每个下载者。已改为
`http://127.0.0.1:7890`（通用本地示例），并重新打包确认 tarball 里该地址出现次数为 0。

**lockfile 指向国内镜像。** 原 `package-lock.json` 全部 155 条 `resolved` 指向
`registry.npmmirror.com`，海外用户 `npm ci` 会被拖住。已统一为 `registry.npmjs.org`，
`integrity` 一字未变，`npm ci` 实测通过。

## 3. 你还需要做的一件事：npm publish

发布配置已就绪（`publishConfig.registry` 钉住 npmjs、`access: public`），`npm publish --dry-run`
显示目标为 `https://registry.npmjs.org`、public、20 个文件。登录后执行：

```sh
cd /home/incam/Software/dsh-rule-proxy
npm login                                                  # 或 npm adduser
npm publish                                                # publishConfig 已指定 npmjs
npm view dsh-rule-proxy version repository.url             # 核对回指本仓库
git tag v0.1.1 && git push origin v0.1.1
```

核对 `repository.url` 很重要：社区目录的 `probe-npm.mjs` 用「npm 包的 repository 是否回指该
GitHub 仓库」来排除抢名，写错会导致探不到、目录里退回 `github:` 安装方式。

发布完成后生成市场索引（脚本从 npm 读真实发布时间，未发布时会直接报错，不会写入装不上的版本）：

```sh
npm run build:index && git add docs/index.json && git commit -m "生成市场索引" && git push
```

## 4. 官方 Discover 自测（可选）

官方 Discover 需要实验性市场 bundle：

1. 插件 → 实验性插件 → 启用「自定义插件市场」；
2. 插件 → 发现 → 索引源，加入：
   `https://raw.githubusercontent.com/xiaoyi728/dsh-rule-proxy/main/docs/index.json`
3. 应看到条目，状态随安装变为 `installed`。

这条路径**只影响官方 Discover**，对 dsh-market 无效——后者只认自己的社区目录。

## 5. dsh-market 收录进度

[PR #8205](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8205) 新增一个文件
`data/plugins/xiaoyi728__dsh-rule-proxy.yml`：

```yaml
url: https://github.com/xiaoyi728/dsh-rule-proxy
name: xiaoyi728/dsh-rule-proxy
category: tools
description:
  en: 'Routes web_fetch, GitHub and optional SearXNG requests through an HTTP(S) proxy by hostname rule, falling back to a direct connection when the upstream proxy is unreachable; it owns its own transport and leaves model requests and the global fetch/dispatcher untouched.'
  zh: '按主机名规则让 web_fetch、GitHub 与可选的 SearXNG 请求走指定 HTTP(S) 代理，上游代理不可达时自动回退直连；它自持独立传输，不修改模型请求与全局 fetch/dispatcher。'
```

- 本地跑过仓库自带的 `check-submission.mjs`：`ok https://github.com/xiaoyi728/dsh-rule-proxy`、`all checked entries pass`。
- PR 上 `check` 为 **SUCCESS**，`Submission gate` 为 **NEUTRAL**（等待人工评审），`mergeable: MERGEABLE`。
- 合并后：`data/plugins/*.yml` → `probe-npm` → `build-index` → 发布目录包 → 每日刷新 → dsh-market 出现条目。

评审要点（已核对 `contributing.md`）：需声明 `dsh.bundle`（✅）、真实可用代码（✅）、仓库满 1 天（✅）、
`dsh-plugin` topic（✅）、描述属实（评审会核对代码）、非纯聚合包（✅ 自带规则引擎、传输、设置面）。

## 6. 维护项

| 项 | 说明 |
|---|---|
| `<0.3.0` 上限 | DSH 0.3 发布后，dsh-market 会把本插件归入"不兼容"并隐藏。0.3 前需发版放宽区间。 |
| 目录滞后 | dsh-market 每日刷新，PR 合并后不是立即出现。 |
| 依赖固定版本 | `@deepseek-ai/dsh-tools` / `dsh-web-fetch-http` 固定 0.2.0-rc.2（npm 上存在）。宿主 0.2.1-rc.2 时插件用自带副本，二者 `WebError` 是不同的类对象；已确认宿主侧不依赖该 `instanceof`，因此安全。若将来宿主改为依赖身份比较，需把这两个包改为 peer。 |
| 源码装 vs npm 装 | npm 装免 pnpm `allowBuilds` 构建授权；本仓库无 build 脚本，源码装同样免授权。 |

## 7. 未验证的部分（不夸大）

真实公网 HTTPS 代理、上游认证、真实 GitHub API 调用需要提供上游后在隔离 profile 验收；
本地测试用的是假目标与假上游。这一点 README 的「待完成和验收限制」与 PR 描述里都写明了。
