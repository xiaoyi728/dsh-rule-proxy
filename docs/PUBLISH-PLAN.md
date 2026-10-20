# dsh-rule-proxy：让这两个界面看到它

> 目标面（按截图）：
> ① 官方 **添加插件** 弹窗（`@deepseek-ai/dsh-client-ui-plugin-manager`）
> ② **dsh-market** 插件市场（`dshmarket`，你的 profile 已装 v1.66.42）
>
> 依据：本机 `@deepseek-ai/dsh@0.2.1-rc.2` 源码、`dshmarket@1.66.42` 源码、社区目录 `awesome-dsh-plugin`
> 的构建脚本。结论均已核对实现。

## 0. 先分清：这两个面不是一种机制

| | ① 官方「添加插件」弹窗 | ② dsh-market 市场页 |
|---|---|---|
| 本质 | **安装器**：按你输入的 spec 装，没有目录可浏览 | **目录浏览器**：读社区目录 JSON，展示别人提交的条目 |
| 有"被扫描"这回事吗 | **没有**。不扫 npm、不扫磁盘；输入什么装什么 | **有**。条目来自 awesome 列表生成的目录 |
| 被看见的条件 | 提供可安装 spec：npm 包名 / `github:owner/repo` / tarball / 本地绝对路径 | 被合并进 `awesome-dsh-plugin` 的 `data/plugins/*.yml` |
| 现状 | ✅ 已经能装（本地路径、GitHub 地址都行） | ❌ 未收录 |
| 要做的事 | 发 npm（给别人"一条命令"的入口）+ README 写清 spec | 提一个 YAML 的 PR |

弹窗说明文字也印证它只做安装：先 `pluginManager.inspect` 读出 spec 指向什么（包名/版本/是否声明组合包），再跑 pnpm；
没有 `dsh.bundle` patch 的包会以「不是组合包」被拒。你的包有 `cordis.patch.yml` ✅。

dsh-market 是纯目录驱动：`https://awesome-dsh-plugin.com/plugins.json`（中国大陆走 npm 包 `dsh-plugin-catalog`
的同一份数据），**每日刷新**；它自己按仓库 manifest 的 `engines.dsh`（以及 `dsh.engines.dsh`、peerDependencies）过滤——
截图里「已隐藏 424 个与 DSH 0.2.1-rc.2 不兼容的插件」就是这层。你的区间 `>=0.2.0-rc.2 <0.3.0` 在 0.2.1-rc.2
上实测 COMPATIBLE，不会被隐藏。

## 1. 对 ① 官方弹窗：不需要"上架"，只要一个装得上的 spec

官方面只有三个可见位置，都与"已安装"绑定：侧栏插件页卡片、设置→插件清单、弹窗里的安装/启用流程。
所以对官方而言，目标不是"被扫到"，而是**别人拿到一行 spec 就能装、装完能看到**。三种形态：

| 形态 | 输入 | 现状 | 评价 |
|---|---|---|---|
| 本地绝对路径 | `/home/incam/Software/dsh-rule-proxy` | ✅ 现在就能用 | 只适合开发自测（截图里的「本地目录路径」） |
| GitHub | `github:xiaoyi728/dsh-rule-proxy` | ✅ 现在就能用 | 大陆 raw/git 不稳定，装时会跑 pnpm |
| npm 包名 | `dsh-rule-proxy` | ❌ 未发布（registry 404） | **推荐**：预构建、免构建授权、可用镜像 |

有利条件：仓库没有 `prepare`/`build` 脚本，`files` 直接指向 `src`。所以从 GitHub 源码装**不会**触发 pnpm 的
`allowBuilds` 构建授权（多数插件卡在这里），安装门槛本来就低。

### 要做的事（约 30 分钟）

1. `package.json` 加 `"publishConfig": { "registry": "https://registry.npmjs.org" }`（本机 registry 是 npmmirror，防发错源）。
2. 重写 README 安装段：主推 `dsh plugin --profile web add dsh-rule-proxy`，留 `github:` 作备选，删掉过期的 0.1.0 手工 tgz 步骤。
3. 补 `LICENSE`（MIT），GitHub 仓库加 topic `dsh-plugin`。
4. `npm run check && npm test && npm run test:package && npm pack --dry-run`（确认 `cordis.patch.yml` 进了 tarball）。
5. `npm publish --registry=https://registry.npmjs.org`；`npm view dsh-rule-proxy version` 核对；npmmirror 同步通常几分钟。

做完后，官方弹窗输入 `dsh-rule-proxy` 即可安装，插件页出现卡片。

## 2. 对 ② dsh-market：只有一条路——进 awesome 列表

截图里的 **「申请收录插件 ↗」** 指向 `awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md`。流程：

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`。
2. 新建**一个**文件 `data/plugins/xiaoyi728__dsh-rule-proxy.yml`（文件名 = `owner__repo`，一插件一文件，减少 PR 冲突）：

   ```yaml
   url: https://github.com/xiaoyi728/dsh-rule-proxy
   name: xiaoyi728/dsh-rule-proxy
   category: tools          # 备选 browser / dev；选错维护者会改，不会因此被打回
   description:
     en: Hostname-rule transport for DSH web tools, falling back to a direct connection when the upstream is unreachable.
     zh: DSH web 工具的主机名规则传输层，上游不可达时自动回退直连。
   ```

3. 提 PR。README 由脚本生成，**不要手改**；CI 校验仓库是否声明 `dsh.bundle`、仓库是否满 1 天、描述是否与代码相符
   （评审会真的去核对）。
4. 合并后的链路：`data/plugins/*.yml` → `probe-npm`（读仓库 package.json 的 `name`，到 registry.npmjs.org 找同名包，
   且该 npm 包的 `repository` 必须回指同一 GitHub 仓库，防抢名）→ `build-index` → 发布 `dsh-plugin-catalog`
   → 目录每日刷新 → 你的 dsh-market 发现页出现条目。

评审要点（已核对 contributing.md）：

- `package.json` 必须声明 `dsh.bundle.{patch}`——**只写 `dsh.client` 是最常见的被拒原因**；你已有 ✅。
- 仓库要有真实可用代码，占位仓库不收。
- 仓库满 1 天（你 2026-10-09 创建 ✅）。
- 需要长期维护，长期停更会被 decay 扫描移出。

### npm 是必需的吗

对 dsh-market **不是**：没有 npm 也能用 `github:` 装（走 gh-proxy 中转，成功率低一档）。但有三点实际影响，建议还是发：

- 目录能显示 npm 版本，才有"更新到 x.y.z"提示；
- 预构建安装绕过构建脚本授权；
- 大陆镜像源可用（官方弹窗的安装源里就有这一项）。

## 3. 顺序建议

| 步 | 动作 | 耗时 | 立刻可见的效果 |
|---|---|---|---|
| 0 | 现在就能测：官方弹窗输入 `/home/incam/Software/dsh-rule-proxy` 或 `github:xiaoyi728/dsh-rule-proxy` | 2 min | 验证安装链路本身没问题 |
| 1 | README / LICENSE / topic / publishConfig | 30 min | Git 安装体验达标 |
| 2 | `npm publish` 到 npmjs | 10 min | 官方弹窗一条包名即可装 |
| 3 | awesome 列表 PR | 30 min + 评审 1–3 天 | dsh-market 收录（唯一路径） |
| 4 | 可选：自建 format-1 索引，在官方 Discover 先看效果 | 1 h | 不依赖别人合并 |

第 4 步只对**官方 Discover**（需另启用 `dsh-experimental-plugin-market-bundle`）有用，对 dsh-market 无效——
它只认自己的目录。若目标就是截图这两个界面，第 4 步可跳过。

## 4. 坑

| 坑 | 说明 |
|---|---|
| npm 发到镜像 | 本机默认 `registry.npmmirror.com`；发布必须 `--registry=https://registry.npmjs.org` |
| `repository.url` 写错 | `probe-npm` 用"npm 包 repository 是否回指该 GitHub 仓库"排除抢名；写 fork 或子目录都会探不到 |
| `<0.3.0` 上限 | DSH 0.3 发布后，dsh-market 会把你归入"不兼容"隐藏；0.3 前必须发版放宽 |
| 描述夸大 | 评审会点数；写"主机名规则路由 + 回退直连"，别写"隐私代理/加速器" |
| 目录滞后 | dsh-market 每日刷新，PR 合并后不是立刻出现；高级页可手动刷新目录 |
| 源码装的锁文件 | 将来若加了 `pnpm-lock.yaml`，镜像用户会因 tarball URL 指向 npmjs 被 pnpm 11 拒绝——保持无锁、无构建脚本最省事 |

## 5. 现状小结

- 官方插件系统：**已经能装**（本地路径/GitHub），缺的是 npm 包名与 README 安装文案。
- dsh-market：**未收录**，需要那个 YAML PR；npm 发布是加分项而非门槛。
- 两者都不需要"被扫描"——一个是安装器，一个是人工策展的目录。
