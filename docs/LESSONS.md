# 踩坑记录（LESSONS）

写给后来的插件作者：这些坑我们在 dsh-rule-proxy 的开发与排障中真实踩过，每条都附症状、根因与做法。同类参考：[dsh-proxy-pro](https://github.com/yanglaofish/dsh-proxy-pro) 的 docs/LESSONS.md（全局代理路线，坑高度重合）。

## 1. re2-wasm 固定 16 MiB 堆，编译过的正则无法释放（致命）

**症状**：插件运行一段时间后，所有网络工具开始报 `Error: Tool request failed` / `WEB_PROVIDER_ERROR`，`rule_proxy_diagnose` 抛出：

```
abort(Cannot enlarge memory arrays to size 16781312 bytes (OOM). Either (1) compile with -s INITIAL_MEMORY=X with X higher than...
```

**根因**：re2-wasm 的 `WrappedRE2`（embind 包装）**没有 delete()/dispose()**，编译出的 RE2 实例永远留在固定大小的 WASM 堆里。每次读配置都重建 `RuleEngine`（schema transform 里也建），约 5500 个实例就把堆耗尽，之后所有 RE2 操作全部 abort。实测 5000 次引擎构造循环在 ~460 次时炸（测试：`test/leak.test.js`）。

**做法**：模块级 `compiledCache`（pattern → RE2 实例）终身复用，每种 pattern 只编译一次（`src/rules.js` 的 `compilePattern`）。**堆一旦毒化无法恢复，必须重启宿主**。JS 正则（`RegExp`）每次新建可被 GC，类比不成立，这是 re2-wasm 独有的坑。

## 2. settings 读取返回新数组，快照必须按值比较

**症状**：每发一个网络请求就重建一次引擎和传输层（放大坑 1）。

**根因**：`ref.get()` 每次读都重新 parse，`rules` 是全新数组，引用比较永远不等。

**做法**：`src/index.js` 的 `sameSnapshot()` 对数组做 JSON 比较、其余用 `===`，未变则沿用旧快照；配 `test/leak.test.js` 的 1000 次 `plugin.create()` 回归。

## 3. 不要把编译放进 schema transform

**症状**：启动阶段或设置页多次读 schema 就累积 RE2 实例，加速坑 1。

**根因**：`z.transform(value => new RuleEngine(value).rules)` 每次 schema 校验都会执行，50 次 schema 读取 = 100 次引擎构造。

**做法**：transform 里只做轻量校验（或走缓存后的构造），重对象在 `apply()`/请求路径按需构建。

## 4. dsh-settings 只允许写 volatile 字段

**症状**：设置页改了值，刷新后弹回旧值，无报错。

**做法**：Config 每个字段用 `.volatile()` 标记（dsh-proxy-pro LESSONS §36 同款结论）：

```js
export const Config = z.object(Object.fromEntries(
  Object.entries(InputConfig.dict).map(([key, schema]) => [key, schema.volatile()]),
));
```

## 5. webServer 在插件 apply 之后才挂载

**症状**：`apply()` 里 `ctx.get('webServer')` 得到 `undefined`，自注册 HTTP 接口消失。

**做法**：晚绑定 `ctx.inject(['webServer'], child => …)`，两种时机都试（`src/index.js`）。

## 6. 浏览器半不能依赖 ctx.configForms / ctx.settingsScope

**症状**：`ctx.configForms` 随 `@deepseek-ai/dsh-client-ui-settings` 打包，profile 未必安装；`ctx.settingsScope` 在 dsh 0.2 已移除。

**做法**：自注册 HTTP 配置接口（`src/api.js`，loopback + sec-fetch-site + Origin 围栏，proxyToken 只写不读）+ `slots.inject('settings.section')` 挂面板。客户端工厂注册 id 必须等于包名（dsh-client-modules 按插件行 id 查工厂）。

## 7. undici 双实例会 UND_ERR_INVALID_ARG

**症状**：`Client was destroyed` / `UND_ERR_INVALID_ARG_TYPE`。

**根因**：两个 undici 实例混用（顶层依赖一份、`@deepseek-ai/dsh-web-fetch-http` 又一份），ProxyAgent 跨实例传。

**做法**：代理传输只经一条通道构造 dispatcher；dsh-rule-proxy 走 `registerFetchProvider` 自持 `ToolTransport`（按请求建 Agent/ProxyAgent + 公网 IP 钉选），不碰全局 env/dispatcher。对比：dsh-proxy-pro 走 `installProxyFromEnvironment()` 全局接管（为了官方 web_fetch 通道也走代理），两条路线按插件定位选一。

## 8. RE2 与 JavaScript 正则不兼容的部分

RE2 不支持反向引用（`\1`）和前瞻断言（`(?=`、`(?!` 等）。设置页保存前用 JS 正则做结构预检并明确拒绝这些构造（`src/client.js` 的 `validateRules`），宿主 RE2 是最终权威——错误消息带 `Rule N: invalid or unsupported RE2 expression (...)`。

## 9. 会话头部插槽

`conversation.session.header.utilities`（list 插槽，升序）可挂会话级按钮，注册形如：

```js
ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
  name: 'conversation.session.header.utilities', id: '<包名>', order: 10,
}, Component));
```

插槽归 `@deepseek-ai/dsh-client-ui-conversation` 所有，记得列入 `dsh.client.inject`。头部按钮与设置面板必须共享同一个状态 store，否则两处显示不一致。

## 10. 修改源码后必须重启宿主

`~/.dsh/profiles/web/package.json` 以 `link:` 指向源码目录，运行中的 DSH 加载的是旧进程内存里的代码；改完不重启 = 没改（坑 1 的毒化堆也必须靠重启清理）。

---

## 团队约定

- 提交信息使用中文。
