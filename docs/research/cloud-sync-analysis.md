# @dickpy/dsh-cloud-sync 0.20.9 逆向调研报告

- 调研对象：`C:\Users\wangyi\.dsh\profiles\web\node_modules\@dickpy\dsh-cloud-sync\`
- 版本：0.20.9（`package.json:3`），`client.js` 内自带 `clientVersion = '0.20.4'`（`lib/client.js:5`），存在版本号不一致
- 方式：只读静态分析（rg / 分段读取 / 测试文件交叉验证），未运行插件
- 标注约定：**【事实】** = 代码或文档直接可见；**【推断】** = 基于代码行为的合理推理，未在运行时验证

---

## 0. 结论摘要（TL;DR）

**【事实】** 这个插件的本质是「**每个 profile 6 个配置文件的 gzip JSON 快照同步器**」，外加「本地插件源码归档」和「插件安装编排」。

- 同步范围只有 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml`、`.npmrc`，加上 `profiles/<name>/.dsh-market/*.yml`（`lib/core.js:11`、`933-951`）。
- **明确不覆盖**：skills、插件自身配置文件（如 `pet.json`）、会话数据（sessions）、用户全局 `AGENTS.md`、`$DSH_HOME/settings.yaml`。对 `lib/core.js` 与 `lib/client.js` 逐一 grep，`skill`、`session`、`AGENTS`、`settings.yaml` 的命中数均为 0（README 里的 `sessions` 只是「不复制会话」的声明）。
- 存储后端 7 种：WebDAV / S3 / OSS / COS / MinIO / Kodo（后 5 种复用同一个手写 SigV4 的 `S3Provider`）+ GitHub Gist，**同一时间只启用一个**（`lib/core.js:241`、`849-859`）。
- 同步模型：整包快照 + ETag 乐观并发 + 内容相等比较 + 显式冲突列表；**没有 mtime/hash manifest，没有增量分块**。
- 设置 UI：唯一入口是客户端 `settings.section` 插槽，自绘 CSS + `React.createElement`，通过 22 个 loopback-only 的 `POST /api/dsh-cloud-sync/*` 与 host 通信。
- 没有 slash command、没有 tool、没有 CLI、没有 HTTP 公共 API 之外的触发方式（`lib/index.js` 全文 62 行）。

对我们新插件的判断：**provider 抽象、快照编解码、冲突对话、历史保留、恢复前备份、可移植化清洗（storeDir 等）这几块可以直接抄；同步范围、目标模型（单激活 → 多目标）、增量策略、清单模型、UI 信息架构需要重写或扩写。**

---

## 1. 包结构与注册方式

### 1.1 文件布局【事实】

```text
package.json            1015 B
cordis.patch.yml        137 B
.dshsyncignore.example  121 B
README.md               11916 B（中文）
README.en.md            11036 B
LICENSE                 MIT © 2025 dickpy
lib/index.js            4729 B    / 62 行    host 入口（路由 + 定时器）
lib/core.js             110696 B  / 1772 行 全部业务逻辑（零运行时依赖）
lib/client.js           122788 B  / 926 行  浏览器端 UI（IIFE 式模块，非打包工具产物）
test/core.test.mjs      29114 B   / 341 行   集成测试（node:assert，自带假 WebDAV/S3/Gist 服务器）
test/client-locale.test.mjs 1010 B / 16 行   客户端 bundle 结构 + 插值语法断言
docs/screenshots/*.png  5 张 README 截图
logo/*.webp
```

**【事实】** 没有 `src/`、没有构建步骤、没有 `node_modules` 依赖声明：`package.json` 完全没有 `dependencies` / `devDependencies` / `peerDependencies`。`lib/core.js:1-8` 只 import Node 内置模块（`crypto`、`fs`、`fs/promises`、`zlib`、`os`、`path`、`child_process`、`url`）。**这是重要的可借鉴点：手写 SigV4 + 手写 WebDAV，换取零依赖、免构建。**

### 1.2 `package.json` 的 `dsh` 字段【事实 + 推断】

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale"],
    "platform": "web",
    "immediately": true
  }
}
```

- `bundle.patch`：告诉 DSH 这个包是一个「bundle 插件」，启动时把该 yml 的 loader 补丁合并进 profile 的 cordis 配置。这也是它被写进 profile `package.json` 的 `dsh.profile.bundles` 的原因（`lib/core.js:1554-1566` 的 `packageBundle()` 正是靠 `manifest.dsh.bundle.patch !== undefined` 判断一个包是否为 bundle）。
- `client.inject`：客户端 bundle 里通过 `require(...)` 拿到的注入模块（对应 `lib/client.js:2` 的 `require('react')` 与 `lib/client.js:924` 用到的 `ctx.locale` / `ctx.slots`）。**【推断】** 这两个包分别提供 React 与 locale/slots 客户端运行时。
- `client.platform: "web"`：只在 web（浏览器）客户端注入；TUI/desktop 不注入 UI。**【推断】**
- `client.immediately: true`：启动即加载客户端 bundle，而不是等设置面板打开才懒加载（体现为 UI 一打开就能立刻发 `release/check` 请求，`lib/client.js:902`）。**【推断】**
- `exports` 暴露三个入口：`.` → host、`./client` → 浏览器 bundle、`./core` → 纯逻辑（测试与二次开发直接 import core，`test/core.test.mjs:11`）。

**【事实】** 本机无法读取 DSH 自身实现（`resources/app.asar/dsh` 不可作为普通目录访问），因此 `dsh.client.*` 的精确语义为推断，但插件侧用法是自洽的。

### 1.3 `cordis.patch.yml` 插入方式【事实】

```yaml
# Adds the host API and the small Sync panel to the DSH web profile.
- insert:
    - id: cloud-sync
      name: '@dickpy/dsh-cloud-sync'
```

即：在 profile 的 loader 配置里 `insert` 一个 id 为 `cloud-sync`、模块名为包名的条目。host 侧插件实例因此被 `apply(ctx)` 加载。没有 `config:` 段——**该插件不使用 cordis 配置段，所有设置自己落在 `$DSH_HOME/dsh-cloud-sync/settings.json`**（见 5.1）。

### 1.4 host 入口写法【事实】

`lib/index.js`：

```js
export const name = 'dsh-cloud-sync'
export const inject = ['webServer']
export function apply(ctx) { ... }
```

- 只注入 `webServer` 一个能力（`lib/index.js:4`）。
- `apply` 内构建 22 个 `route(path, operation)`（`lib/index.js:23-29`、`32-55`）。
- `ctx.effect(() => { ... }, 'dsh-cloud-sync: routes')`（`lib/index.js:56-61`）统一注册路由并挂一个 **60 秒**的 `setInterval`，回调 `runAutomaticSync()`；`active` 布尔量做重入保护；返回 disposer 清除定时器与全部路由。
- 路由注册形态：`ctx.webServer.register({ kind: 'exact', path, handler })`（`lib/index.js:23-24`、`57`）。
- 请求处理：强制 loopback（`isLoopback`）、强制 POST、body 上限 128 KiB、返回统一 `{ ok, value }` / `{ ok:false, message }` 信封（`lib/index.js:6-29`）。

### 1.5 client 入口写法【事实】

`lib/client.js` 是浏览器可直接执行的模块包，不是 ESM：

```js
window.__ModuleLoader__.load({ id: '@dickpy/dsh-cloud-sync', factory: (require) => {
  const React = require('react'); const h = React.createElement
  ...
  const inject = ['slots', 'locale']
  function apply(ctx) {
    ctx.locale.register(NS, { zh, en })
    locale = ctx.locale.bind(NS)
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: 'cloud-sync', order: 25, locale: NS, label: () => t('ui.173') },
      CloudSyncSection))
  }
  return { inject, apply }
}})
```

证据：`lib/client.js:1`、`923-925`。要点：

- `window.__ModuleLoader__.load({id, factory})` + `factory(require)` 是 DSH 客户端 bundle 的约定格式；返回 `{ inject, apply }`。
- `inject = ['slots','locale']`（`lib/client.js:923`），且 `test/client-locale.test.mjs:6` 用正则锁死了这一行，防止改坏。
- 面板通过 `ctx.slots.inject('settings.section', ...)` **声明依赖插槽存在**再 `ctx.slots.register({name, id, order, locale, label}, Component)` 注册，`order: 25` 决定在设置页中的排序。
- 语言包：`ctx.locale.register(NS, { zh, en })`，键名是 `ui.1`…`ui.204` 这类编号（`lib/client.js:8-`），`t()` 支持 `{{var}}` 插值（`test/client-locale.test.mjs:12`）。
- 语言切换监听用 `MutationObserver` 观察 `<html lang>` 属性（`lib/client.js:438-441`），测试也锁定了这个特征（`test/client-locale.test.mjs:7`）。

---

## 2. 同步范围：声明 vs 实现

### 2.1 README 的声明【事实】

中文 README：

- `README.md:30`：「不复制会话、附件、`node_modules`、pnpm 缓存或明文凭据」——**会话数据明确排除**。
- `README.md:50`：「同步 `package.json`、lockfile、workspace、patch 和市场热更新 YAML」。
- `README.md:51`：「自动发现可达的 `file:` / `link:` 插件源码，归档后换盘符、换电脑也能恢复」。
- 英文 README 更精确（`README.en.md:33`）：`package.json`、`pnpm-lock.yaml`、`.npmrc`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`cordis.yml`，以及 marketplace hot-update YAML files。
- `README.en.md:27`：`never copies sessions, attachments, pnpm cache, node_modules, or credentials`。

### 2.2 代码实际打包的路径【事实】

```js
const CONFIG_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', '.npmrc']   // core.js:11
```

打包函数 `profileFiles(name, home)`（`core.js:933-951`）：

| 序号 | 路径/模式 | 证据 |
| --- | --- | --- |
| 1 | `$DSH_HOME/profiles/<name>/package.json` | `core.js:11`, `936-941` |
| 2 | `.../pnpm-lock.yaml`（经 `sanitizePnpmLock`） | 同上 |
| 3 | `.../cordis.patch.yml`（经 `sanitizeCordisPatch`） | 同上 |
| 4 | `.../cordis.yml` | 同上 |
| 5 | `.../pnpm-workspace.yaml`（经 `sanitizePnpmWorkspace`） | 同上 |
| 6 | `.../.npmrc`（经 `sanitizeNpmrc`） | 同上 |
| 7 | `.../.dsh-market/*.yml`（只取一层、仅 `.yml`、仅文件） | `core.js:943-948` |
| 8 | 本地插件源码包 `sources/<slug>-<sha16>.json.gz` | `core.js:1190-1213` |

`package.json` 缺失直接抛错（`core.js:949`）；`listProfiles` 只把「含 `package.json` 的目录」当 profile（`core.js:953-958`），排除 `node_modules`。

### 2.3 覆盖矩阵（对照我们的需求）【事实】

| 我们的目标 | 插件是否覆盖 | 证据 |
| --- | --- | --- |
| 全局 `AGENTS.md` | 否（0 命中） | `lib/*.js` 全文无 `AGENTS` |
| skills 目录 | 否（0 命中） | 全文无 `skill` |
| 插件自身配置文件（pet.json 等） | 否。只有 `.dsh-market/*.yml` 与 profile 根 6 文件 | `core.js:11`、`943-948` |
| 会话数据 sessions | 否，且文档明确拒绝 | `README.md:30`、`README.md:27` |
| `$DSH_HOME/settings.yaml` | 否 | 全文无 `settings.yaml` |
| profile 包管理配置 | 是 | `core.js:11` |
| 本地 `file:`/`link:` 插件源码 | 是（自动发现 + 手动备份） | `core.js:963-965`、`1231-1247`、`1190-1213` |
| 附件 / node_modules / pnpm 缓存 | 否（默认忽略） | `core.js:12` |

---

## 3. 存储后端与同步目标

### 3.1 Provider 抽象【事实】

统一鸭子类型接口（`core.js:470-547`、`638-703`、`744-818`、`841-847`）：

```text
put(key, body, { ifMatch, ifNoneMatch }) -> etag?
getWithMeta(key) -> { body: Buffer, etag?: string }
get(key) -> Buffer
probe() -> void（失败抛错）
remove(key)?  // 仅 GistProvider 实现（core.js:794-799）
```

`providerFrom(settings, home)`（`core.js:849-859`）按 `provider.type` 实例化，若 `encryption.enabled === true` 再套一层 `EncryptedProvider`（`core.js:841-847`）。

### 3.2 支持的 provider 一览

| type | 类/实现位置 | 认证方式 | 端点约束 | 一致性控制 |
| --- | --- | --- | --- | --- |
| `webdav` | `class WebDavProvider` `core.js:470-547` | HTTP Basic（`authorization` 头由 username/password base64） | 强制 HTTPS（仅 `NODE_ENV==='test'` 允许 HTTP），`core.js:472`、`385` | `if-match` ETag，412 视为远端已变（`core.js:496-502`） |
| `s3` / `oss` / `cos` / `minio` / `kodo` | `class S3Provider` `core.js:638-703`，签名 `signAwsV4` `core.js:603-619` | AccessKeyId + SecretAccessKey，AWS SigV4（手写，含 `x-amz-content-sha256`） | `normalizeObjectStorageEndpoint`：必须 HTTPS（`minio` 允许 HTTP），禁止 URL 内嵌凭据/query/hash（`core.js:564-573`） | `if-match`；`oss` 不使用 If-Match（`core.js:669-672`），改用 409/412 判定 |
| `gist` | `class GistProvider` `core.js:744-818` | GitHub token（device flow 或手填，scope `gist`） | 单一受管 secret Gist，`dsh-cloud-sync-v1.json` 作为归属标记（`core.js:17`、`806`、`813-816`） | Gist 整体 ETag；弱 ETag（`W/`）时禁用 If-Match（`core.js:756-767`） |

补充事实：

- 对象存储虚拟主机风格：`oss`/`cos` 用 `<bucket>.<host>`，其余路径风格（`core.js:648-651`、`659-665`）。
- 默认 region：s3 `us-east-1`、oss `cn-hangzhou`、cos `ap-guangzhou`、kodo `cn-east-1`（`core.js:551-557`）。
- WebDAV 会**自动建目录**：`ensureCollections` 逐级 MKCOL，把 405/301/302 视作已存在，409 时 `probe()` 后再试一次（`core.js:477-495`）；`probe()` 会从最深的已存在祖先开始补齐路径段（`core.js:519-546`）。这对坚果云 / NAS 很实用。
- 重试策略：WebDAV 2 次、20s 超时（`core.js:453-468`）；S3 2 次、30s 超时（`core.js:621-636`）；Gist 3 次 + 指数退避 + 尊重 `retry-after`、30s 超时（`core.js:710-742`）。
- Gist 硬限制：单对象 700 KiB（`core.js:14`、`770`）、文件数 200（`core.js:15`、`776`）；连接 Gist 时 `syncScope.sources` 被强制 `false`（`core.js:419`），`synchronizeSnapshots` 里也二次判断（`core.js:1128`）。
- **没有**本地路径、rclone、Git、FTP/SFTP 后端。本地路径 provider 完全缺失——这正是我们要新增的。

### 3.3 认证/授权流程

- **GitHub Device Flow**：`startGithubDeviceAuthorization`（`core.js:897-905`）→ 存 `{requestId -> {home, clientId, deviceCode, intervalSeconds, expiresAt}}` 内存表；`pollGithubDeviceAuthorization`（`core.js:907-922`）按 interval 节流，处理 `authorization_pending` / `slow_down`（interval +5s），拿到 token 后直接 `connectProvider({provider:{type:'gist', token}})`。
- OAuth App client id 默认硬编码 `Ov23liqTnhZ79x2hJZpd`（`core.js:21`），可用环境变量 `DSH_CLOUD_SYNC_GITHUB_CLIENT_ID` 覆盖（`core.js:882`）。**【事实】写死 client id 的可借鉴性与风险并存：方便，但无法感知被吊销。**
- 每个渠道的**非敏感**参数（endpoint/region/bucket/prefix/accessKeyId/username/url/gistId）保存在 `settings.json` 的 `savedProviders[type]`（`core.js:299-311`、`372`），切回旧渠道可自动回填；**密钥按 type 存一份**（`credentials.json` 的 `secrets[type]`，`core.js:255-266`）。

### 3.4 远端对象布局【事实】

```text
snapshots/latest.json.gz                     // 全量快照（唯一真源）
snapshots/history/<ISO时间戳>-<sha12>.json.gz // 历史快照
snapshots/history/index.json                 // 历史索引 {schema, entries:[{key,createdAt,sha256,deviceId,deviceName,changes}]}
sources/<slug>-<sha16>.json.gz                // 单个本地插件源码归档
[dsh-cloud-sync-v1.json]                      // 仅 Gist：归属标记
```

证据：`core.js:1001`、`1103-1113`、`1333-1342`、`1202-1203`、`29`、`17`。

本地侧（`$DSH_HOME/dsh-cloud-sync/`）：

```text
settings.json           // 非敏感设置（provider 字段已打码）  core.js:239
credentials.json        // secrets[type] = {scheme:'dpapi'|'file-0600', secret}  core.js:240,255-266
sources.json            // 源码目录：name -> {archive, objectKey, sha256, sourceBytes, backedUpAt}  core.js:960-961
archives/<archive>      // 本地源码归档缓存  core.js:1204-1206
backups/<ISO时间戳>/<profile>/files.json   // 恢复前备份  core.js:1421-1427
local-plugins/<slug>/<sha16>/             // 恢复出来的源码  core.js:1259
releases/<tgz>          // 自更新下载缓存  core.js:1589
```

### 3.5 快照格式与压缩

**【事实】** 快照是一个 JSON：

```js
{ schema: 'dsh-cloud-sync/v1', createdAt, profiles: [{ name, files: { '<相对路径>': '<base64>' }, localDependencies: [] }], sources: [...] }
```

（`core.js:10`、`986`、`977-989`）→ `gzipSync(JSON.stringify(snapshot))`，`sha256` 只用于展示/历史比对，不参与远端寻址。**所有文件内容 base64 内联进同一个 JSON**，没有 manifest，没有分块，没有按文件独立对象（除源码归档外）。

源码归档：`{ schema: 'dsh-cloud-sync/v1/source', packageName, version, files: [{path, data(base64)}] }` → gzip（`core.js:1199-1201`），archive 名含内容 hash 前 16 位，天然可缓存/去重（`core.js:1202`）。

### 3.6 增量与冲突策略

**【事实】没有基于 mtime/hash 清单的增量。** 每次同步都重建全量快照并上传（`core.js:987-1001`、`1153-1158`），增量只体现在两个地方：

1. **本地源码归档按内容 sha256 命名**，内容不变则远端对象名不变，`putMergedSnapshot` 只上传本地存在的新归档（`core.js:1103-1113`），等于隐式去重。
2. **Gist 单文件上限**迫使它把每个对象拆成独立 gist file（`gistObjectFileName`，`core.js:705`）。

冲突检测（`mergeProfile` `core.js:1015-1049`、`mergeSources` `1051-1062`、`diffSnapshots` `1292-1312`）：

- 以**内容字符串完全相等**判断是否变化（`equalFile`，`core.js:1012`），不看 mtime、不看 hash 字段。
- `dependencies` 逐项三方比较：只有两端都存在且不同才算冲突（`core.js:1025-1032`）；两端都是本地 spec 时取云端。
- `pnpm-lock.yaml` 冲突时**默认取云端**（`core.js:1043`）。
- 其余文件按 `resolveConflicts`（`'cloud' | 'local' | undefined`）决定；`undefined` 时把冲突推入 `conflicts[]` 并**放弃写入**，返回 `direction: 'needs-choice'`（`core.js:1154-1155`），由 UI 弹窗让用户勾选。
- `bundles` 数组做并集，并过滤掉「依赖里没有且不是 `@deepseek-ai/dsh-` 前缀」的孤儿项（`core.js:1036`）。
- 并发控制用 ETag：`put(..., { ifMatch: cloudEtag, ifNoneMatch: cloud === undefined })`（`core.js:1147`），412/409 时抛「Remote snapshot changed during sync. Refresh and retry.」（`core.js:500`、`682`）。注意历史索引的写入也用 `ifMatch/ifNoneMatch`（`core.js:1339`）。
- 精确选择：`selectedItems` 形如 `dependency:<profile>:<name>` / `config:<profile>:<fileName>`（`core.js:1084`、`1093`），`applySelectedItems` 只把这些项替换成云端值（`core.js:1074-1101`）。

三种策略（`normalizeSyncPolicy`，`core.js:425-429`；`synchronizeSnapshots`，`core.js:1115-1160`）：

| 策略 | 行为 | 证据 |
| --- | --- | --- |
| `smart`（默认） | 读远端 → 合并 → 有冲突则 `needs-choice` → 否则合并上传 | `core.js:1151-1159` |
| `cloud` | 直接 `pullSnapshot({apply:true})` 覆盖本地 | `core.js:1124-1127` |
| `local` | 用本地快照覆盖远端 | `core.js:1145-1149` |

### 3.7 加密

**【事实】** AES-256-GCM + scrypt：

```js
scryptSync(passphrase, salt(16B), 32) → aes-256-gcm(iv 12B) → {format:'dsh-cloud-sync/encrypted/v1', salt, iv, tag, data}
```

（`core.js:820-840`）每个对象新 salt、新 iv；只加密 `snapshots/` 与 `sources/` 前缀的 key（`core.js:820`），历史索引 `snapshots/history/index.json` 因此也被加密。口令**只存在进程内存** `encryptionKeys: Map<home, passphrase>`（`core.js:32`、`856`、`1376-1392`），重启需重新输入；`settings.json` 里只留 `encryption:{enabled, salt:''}`，不存任何可验证口令的东西（`core.js:1376-1387`、`440-447`）。

---

## 4. 设置 UI 与 host↔client 通信

### 4.1 面板构建方式【事实】

- 技术栈：`require('react')` + `React.createElement`（`lib/client.js:2-4`），`useState`/`useEffect` 手写状态机；**没有用任何 DSH 官方 UI 组件库**（未出现 `dsh-client-ui` 之类 import）。
- 样式：一个巨大的 `css` 模板字符串 + 组件内 `<style>{css}</style>` 注入（`lib/client.js:454-475`、`905`），并有多组 `@media` 与 CSS 变量主题适配（`lib/client.js:473`）。全文件 926 行 / 118 385 字符，构成大致为：CSS 约占 29 KB（`client.js:454-475`），中英语言包各约 204 条（`client.js:8-437`），两处内联 base64 webp 图标合计约 4.4 KB（`client.js:444-445`），其余是压缩成超长行的组件逻辑（最长单行 6 583 字符，`client.js:470`）。
- 结构：`CloudSyncSection` → 顶部 sticky header（标题 + 版本徽章 + GitHub 链接 + 更新提示）→ 三个 tab（`services` 云服务 / `history` 配置与历史 / `status` 同步状态）→ 结果条 `Result`（`lib/client.js:896-921`）。
- 子组件抽样：`ProviderLogo`、`Field`、`DiffDialog`（冲突勾选表格，`lib/client.js:515`）、`GithubConnectDialog`（设备码，`lib/client.js:624`）、`DisableProviderDialog`（`lib/client.js:691`）、`ReleaseUpdateNotice`、`ServicesTab`、`ConfigurationHistoryTab`、`StatusTab`。历史上还有 `LegacyConfigurationHistoryTab`（`lib/client.js:727-755`）未被使用但保留在 bundle 中。
- 无障碍：`role="tablist"/"tab"/"tabpanel"`、`aria-selected`、`aria-pressed`、`aria-modal`、`aria-label`、`focus-visible` 样式，做得相当规范，值得照抄。

### 4.2 通信方式：22 个 loopback HTTP 路由【事实】

客户端只有一个 `api()` 封装：

```js
const api = async (path, value = {}) => {
  const response = await fetch(`/api/dsh-cloud-sync/${path}`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(value) })
  const body = await response.json()
  if (!body.ok) throw new Error(body.message || `HTTP ${response.status}`)
  return body.value
}
```

（`lib/client.js:447-452`）→ **不是 RPC 框架，就是同源 POST JSON**，靠 cookie/session 与 loopback 校验，没有额外鉴权头。

完整路由表（`lib/index.js:32-55`，全部 `{kind:'exact', path, handler}`）：

| # | 路径 | 入参 | core 函数 |
| --- | --- | --- | --- |
| 1 | `/status` | – | `status()` `core.js:1765` |
| 2 | `/settings/get` | – | `getPublicSettings()` `core.js:449` |
| 3 | `/release/check` | – | `checkSelfUpdate()` `core.js:158` |
| 4 | `/release/update` | – | `updateSelf()` `core.js:1584` |
| 5 | `/webdav/connect` | provider 对象 | `connectWebDav()` `core.js:878` |
| 6 | `/provider/connect` | provider 对象 | `connectProvider()` `core.js:861` |
| 7 | `/github/device/status` | – | `getGithubDeviceAuthorizationStatus()` `core.js:895` |
| 8 | `/github/device/start` | – | `startGithubDeviceAuthorization()` `core.js:897` |
| 9 | `/github/device/poll` | `{requestId}` | `pollGithubDeviceAuthorization()` `core.js:907` |
| 10 | `/settings/clear-provider` | – | `clearSyncProvider()` `core.js:924` |
| 11 | `/settings/preferences` | `{deviceName,autoSync,syncScope,historyLimit}` | `updateSyncPreferences()` `core.js:1361` |
| 12 | `/security/unlock` | `{passphrase,enable}` | `unlockEncryption()` `core.js:1376` |
| 13 | `/security/lock` | – | `lockEncryption()` `core.js:1389` |
| 14 | `/snapshot/diff` | – | `previewSyncChanges()` `core.js:1349` |
| 15 | `/snapshot/history` | – | `listSnapshotHistory()` `core.js:1344` |
| 16 | `/snapshot/push` | `{strategy,resolveConflicts,selectedItems}` | `synchronizeSnapshots()` `core.js:1115` |
| 17 | `/snapshot/pull` | `{apply,snapshotKey}` | `pullSnapshot()` `core.js:1413` |
| 18 | `/source/backup` | `{directory}` | `backupLocalPlugin()` `core.js:1190` |
| 19 | `/inventory` | `{profile}` | `getSyncInventory()` `core.js:1648` |
| 20 | `/plugin/adopt-configured` | `{packageName}` | `adoptConfiguredPlugin()` `core.js:1633` |
| 21 | `/plugin/install-configured` | `{packageName}` | `installConfiguredPlugin()` `core.js:1740` |
| 22 | `/plugin/uninstall` | `{packageName}` | `uninstallPlugin()` `core.js:1597` |

**【事实】当前客户端 bundle 实际调用的子集**：`settings/get`、`release/check`、`release/update`（`client.js:527`）、`provider/connect`（`621`、`662`）、`github/device/*`（`596`、`603`、`613`）、`settings/clear-provider`（`704`、`797`）、`settings/preferences`（仅传 `historyLimit`，`client.js:837`）、`source/backup`（`753`、`871`）、`snapshot/diff`（`738`、`843`）、`snapshot/history`、`snapshot/push`（`742`、`846`）、`snapshot/pull`、`inventory`（`762`、`880`）、`plugin/install-configured`（`767`、`882`）、`plugin/uninstall`（`768`、`883`）。

**未被子集覆盖、属于「有接口无 UI」的**：`webdav/connect`（被 `provider/connect` 取代）、`security/unlock`、`security/lock`、`plugin/adopt-configured`、`status`。README `README.md:56` 也承认「界面只保留更容易理解的核心操作」「保留已有 AES-256-GCM……配置」——**加密与自动同步在 0.20.x 的 UI 里已被隐藏**：`client.js` 全文无 `autoSync`、`syncScope` 字样；`sources` 只以结果字段 `missingLocalSources` 出现在提示文案里（`client.js:745`、`849`），不是可切换的同步项。`deviceName` 仅用于历史行展示（`client.js:752`、`869`），没有输入框。`updateSyncPreferences` 服务端仍支持这四个字段（`core.js:1361-1374`）。

### 4.3 设置项保存位置【事实】

- 不走 cordis `config`，不用 `$DSH_HOME/settings.yaml`；落在 `$DSH_HOME/dsh-cloud-sync/settings.json`（`core.js:239`、`313-319`）。
- 写入统一走 `writeJson`：`mkdir -p` + `mode 0o600` + `chmod 0o600`（`core.js:81`）。
- 默认设置结构（`core.js:242`）：

```js
{ provider:{type,url,username,password|secretAccessKey|token,gistId,...}, savedProviders:{[type]:{...}},
  syncPolicy:'smart', historyLimit:30, deviceId:'', deviceName:'',
  autoSync:{enabled:false, intervalMinutes:30}, syncScope:{sources:true},
  encryption:{enabled:false, salt:''} }
```

- 首次使用时生成 `deviceId`（UUID）+ `deviceName`（`COMPUTERNAME`/`HOSTNAME`/「未命名设备」）（`core.js:1314-1320`）。
- `historyLimit` 1..200（`core.js:431-436`）；`autoSync.intervalMinutes` 5..1440 且必须整数（`core.js:1363-1364`）。

---

## 5. 安全

### 5.1 凭据存储【事实】

- `credentials.json`：`{version:2, secrets:{[type]:{scheme,secret}}}`，文件 0600（`core.js:255-266`、`81`）。
- Windows：`scheme:'dpapi'`，通过 `powershell.exe -NoProfile -NonInteractive -Command` 调用 `[Security.Cryptography.ProtectedData]::Protect(...,CurrentUser)`，把明文经 stdin 传入、base64 经 stdout 返回（`core.js:244-253`）。**这是子进程 + stdin 传密钥的写法，比写临时文件安全。**
- 非 Windows：`scheme:'file-0600'`，即**明文 + 文件权限**（`core.js:262`）。**【事实】macOS/Linux 上没有 Keychain/Secret Service 集成，这是明确的降级。**
- `settings.json` 里密钥一律替换为占位符：`<stored-locally>`（`core.js:282-287`、`438-447`）或 `<stored-in-credentials>`（`core.js:283-287`）。前端拿到 `<stored-locally>` 就知道「留空即复用」。
- 旧格式迁移：`version !== 2` 且存在 `secret` 字段时自动升级（`core.js:258`）。

### 5.2 网络与暴露面【事实】

- 路由**只允许 loopback**：`remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`，且 `Host` 头解析出的主机名必须是 `127.0.0.1|localhost|[::1]`（防 DNS rebinding），且 `sec-fetch-site !== 'cross-site'`（防 CSRF）（`lib/index.js:6-13`）。
- 只接受 `POST`，其它方法 405（`lib/index.js:26`）。
- body 上限 128 KiB，非对象 JSON 回 `{}`（`lib/index.js:15-19`）。
- 响应头带 `cache-control: no-store`、`referrer-policy: no-referrer`（`lib/index.js:20`）。
- **【事实】没有 CSRF token、没有 Origin 白名单、没有本地进程鉴别**：任何本机进程都能调这些接口做同步/恢复。风险等级取决于本机信任模型。
- 远端必须 HTTPS：WebDAV 强制（`core.js:385`），对象存储强制（`core.js:568`，`minio` 与 `NODE_ENV=test` 例外）；endpoint 禁止内嵌凭据/query/fragment（`core.js:569`）。

### 5.3 路径穿越【事实】

| 位置 | 防护 |
| --- | --- |
| profile 名 | `/^[A-Za-z0-9._-]+$/` 且非 `node_modules`（`core.js:44`） |
| 源码归档解包 | `validateArchiveEntry`：拒绝空串、含 `..`、以 `/` 开头、含 `\`（`core.js:1249-1252`）+ `isInside(target, output)` 二次校验（`core.js:72-76`、`1261`） |
| 源码归档完整性 | 下载后 `sha256` 必须等于目录记录，否则拒绝（`core.js:1256`） |
| 快照恢复写文件 | 拒绝含 `..` 或以 `/` 开头的文件名（`core.js:1429`），但**未拒绝 `\`**（对比 `1250` 有拒绝） |
| 对象 key | 前缀规范化时拒绝空段、`.`、`..`、控制字符（`core.js:558-563`）；bucket 名走严格正则且排除 IP 形态（`core.js:643`） |
| WebDAV 路径 | 逐段 `encodeURIComponent`（`core.js:476`） |

### 5.4 命令注入【事实】

- 一律 `spawn(..., { shell: false, windowsHide: true })`（`core.js:248`、`1492`、`57`）。
- Windows 下 pnpm 通过 `cmd.exe /d /v:off /c <exe> <args...>` 调用，**可执行文件与参数分开传**，避免二次引号问题（`core.js:1480-1488`，含注释说明）。
- 参数黑名单：`validatePnpmArgument` 拒绝 `\0 \r \n " ' \` $ & | < > ^ % !`与超长（`core.js:1475-1478`）。
- 包名正则：`/^(?:@[-a-zA-Z0-9_.]+\/)?[-a-zA-Z0-9_.]+$/`（`core.js:1598`、`1634`）。
- pnpm 可执行文件路径也做 `[\r\n"%]` 检查（`core.js:1484`）。

### 5.5 值得注意的风险点（【推断】，按严重度）

1. **远端快照里的 `allowBuilds` 会被自动写进本地 `pnpm-workspace.yaml`**：`installConfiguredPlugin` 调 `mergeApprovedBuilds(remoteProfile, directory)`（`core.js:1753`、`1705-1738`），而 `allowBuilds` 正是「允许执行包 install 脚本」的开关。恶意/被污染的云端快照可以在用户点「安装缺失插件」时**顺手批准任意依赖的 build 脚本**，随后 `pnpm add` 即可能执行任意代码。README 只在 FAQ 里轻描淡写（`README.en.md:200`）。这是我认为**最需要在我们的设计里修掉**的一点：从远端继承 `allowBuilds` 必须显式二次确认，且只能白名单继承用户已批准的 key。
2. **远端 `dependencies` 的 spec 会直接进 `pnpm add`**（`core.js:1750-1762`）：虽然过了字符黑名单，但 `https://` tarball / `github:` 之类仍可指向任意来源，构成供应链面。
3. **`ensureProfilePnpmShim` 会把 `pnpm.cmd` 写进 profile 目录**（`core.js:62-65`），而 `pnpmCommand` 优先使用 `join(dir,'pnpm.cmd')`（`core.js:1483`）——profile 目录一旦可写（本来就是可写的），该文件就是本地提权/劫持点。属于「信任边界内」但仍值得在新插件里改成绝对路径 + 内容校验。
4. **恢复前备份只备份 `CONFIG_FILES`**（`core.js:1426-1427` 调 `profileFiles`），如果我们的插件要恢复 skills/sessions/AGENTS.md，备份范围必须跟着扩，否则会出现「恢复了但回不去」。
5. **快照恢复不校验整体 sha256**：`latest.json.gz` 没有随对象存 hash（只有历史索引里存），加密关闭时快照完整性依赖 gzip/JSON 解析 + `schema` 校验（`core.js:1265-1276`）。
6. **`clientVersion` 硬编码 0.20.4**（`lib/client.js:5`），只在 `release/check` 返回后才被覆盖（`client.js:902`），离线/接口失败时显示错版本号。

---

## 6. 公开 API / 事件 / 命令（用户可触发的入口）

**【事实】插件对外只有三类入口，没有任何「命令」类集成：**

| 类型 | 是否存在 | 说明 |
| --- | --- | --- |
| HTTP 路由（host） | 是，22 个 | `/api/dsh-cloud-sync/*`，loopback-only，POST JSON（见 4.2） |
| 客户端 UI | 是，1 个设置页 | `settings.section` + `id: cloud-sync` + `order: 25` |
| 设置页按钮 | 是 | 「开始同步」「备份源码」「预览远端」「从快照恢复」「回滚到某历史」「安装/卸载插件」「更新插件」「连接/停用渠道」 |
| 定时任务 | 是 | host 内 60s tick → `runAutomaticSync()`（`lib/index.js:59`），受 `autoSync.enabled` + interval 双重节流（`core.js:1394-1406`） |
| Slash command | **否** | `lib/index.js` 全文无 command 注册 |
| Agent tool | **否** | 无 tool 注册；插件的 `inject` 只有 `webServer` |
| CLI 子命令 | **否** | 无 bin 字段 |
| 事件 / EventEmitter | **否** | 只有 `ctx.effect` 的 dispose；无对外事件 |
| 编程 API | 是 | `exports['./core']` 导出 40+ 个具名函数（`core.js` 全部 `export function`），测试即通过这条路径驱动（`test/core.test.mjs:11`） |

`runAutomaticSync` 的返回值语义值得借鉴：`{attempted:false, reason:'disabled'|'locked'|'not-due'|'unchanged'}`；有冲突时 `{attempted:true, synchronized:false, reason:'conflicts', conflicts}`（`core.js:1394-1406`）——**明确区分「没做」和「做了但没成功」，比布尔好得多。**

---

## 7. 可借鉴点与需要重写的部分

### 7.1 可直接复用（结构/算法级）

| 设计 | 位置 | 复用理由 |
| --- | --- | --- |
| Provider 鸭子接口 `put/get/getWithMeta/probe/remove?` | `core.js:470-547` 等 | 4 个方法就能覆盖 WebDAV/S3/Gist，**新增「本地路径」只需 40 行**；装饰器 `EncryptedProvider` 天然可叠加（`841-847`） |
| 手写 AWS SigV4 + 手写 WebDAV，零依赖 | `core.js:603-619`、`470-547` | 免 SDK、免构建、跨平台；OSS/COS/MinIO/Kodo 全靠 region + 虚拟主机开关区分（`648-651`） |
| ETag 乐观并发（`ifMatch`/`ifNoneMatch`，412/409 即「远端已变」） | `core.js:496-502`、`680-685`、`1147`、`1339` | 多设备场景最小可用的并发控制，不需要服务端锁 |
| 冲突「先返回列表，再让用户逐项勾选」 | `core.js:1015-1101`、`1154-1155`、`client.js:515` | UI 与算法解耦，`needs-choice` 是一种干净的状态返回 |
| 历史 + 索引 + 保留上限 + 超限删除 | `core.js:1333-1342`、`1344-1347` | 索引一个对象、快照一对象，读历史不用列目录（S3 无 list 也能跑） |
| 恢复前备份 profile 快照到本地 `backups/<ts>/` + 只留 10 份 | `core.js:1421-1427`、`1215-1220` | 极低成本的回滚保险 |
| 恢复时「依赖安装延后到重启」 | `core.js:1448-1450`、`pullSnapshot` 返回 `installDeferred/restartRequired` | 避免热替换正在加载的 bundle，这个坑我们一定会踩 |
| 可移植性清洗（去 `storeDir`/`store-dir`、去 `[]` 空 patch、去自身依赖） | `core.js:168-198`、`967-975`、`199-237` | 换机器/换盘符必踩的坑，逻辑都写好了；测试也覆盖（`core.test.mjs:120-131`、`155-158`） |
| 源码归档 = 内容寻址（`<slug>-<sha16>.json.gz`）+ 解包 `sha256` 校验 + 路径校验 | `core.js:1199-1213`、`1249-1263` | 天然去重、可缓存、可验证 |
| `.dshsyncignore`（每行一个 glob/名字，`**`、`*` 支持）+ 内置忽略集 | `core.js:12`、`1162-1188`、`1196-1197` | 用户可控的排除表，实现仅 20 行 |
| loopback + 方法 + body 上限 + 安全响应头 的统一 `route()` 包装 | `lib/index.js:6-29` | 21 个接口的安全策略集中在一处，新插件照抄即可 |
| 客户端 `window.__ModuleLoader__.load` + `inject:['slots','locale']` + `settings.section` 注册 | `lib/client.js:1`、`923-925` | 这是 DSH 插件的客户端接入标准姿势 |
| 语言包编号键 + `{{var}}` 插值 + `MutationObserver` 跟 `<html lang>` | `lib/client.js:8-`、`438-441` | 中英双语零依赖实现 |
| `ctx.effect(() => disposers, 'label')` + 重入锁的定时器 | `lib/index.js:56-61` | 插件卸载时不泄漏 |
| `runAutomaticSync` 的 `{attempted, reason}` 返回契约 | `core.js:1394-1406` | 状态可解释 |
| 测试策略：单文件线性脚本 + `node:http` 假 WebDAV/S3/Gist + `NODE_ENV=test` 放宽 HTTP | `test/core.test.mjs`（341 行，含 `objects`/`webdavMkcols`/`objectStorageRequests` 断言表） | 不引测试框架就能端到端跑通同步 |

### 7.2 必须重写 / 扩展（对照新需求）

| 需求 | 现状 | 建议 |
| --- | --- | --- |
| **多目标并存**（本地路径 / 网盘 / OSS 同时生效） | 单 `provider` + `savedProviders[type]` 仅做「记忆」；切渠道时旧渠道停用（`core.js:861-931`、`README.md:113`）；密钥按 **type** 而非 target 存（`core.js:255-266`） | 改成 `targets: [{id, name, kind, config, enabled, secretRef}]`；`credentials.json` 的 key 换成 `targetId`；每个 target 独立 `lastSyncAt` / `remoteEtag` / `historyIndex`；同步结果按 target 聚合。**这是最大的一处重写。** |
| **可选同步项**（skills / 插件配置 / sessions / AGENTS.md 分别开关） | 只有 `syncScope:{sources:boolean}` 一个开关，且 UI 已隐藏（`core.js:242`、`1128`、`1369`；`client.js` 无 `sources` 字样） | 需要 `scope: { profiles, skills, pluginConfig, sessions, agentsMd }` 的**按项选择模型**，并且每项自带「路径集合 + 默认忽略 + 体积上限 + 冲突策略」。现有 `CONFIG_FILES` 白名单直接泛化成「scope → paths[]」。 |
| **skills 同步** | 完全不覆盖 | 新增目录树 scope：`~/.agents/skills/**`（或 `$DSH_HOME/skills`）。注意 skills 是**大量小文件 + 可执行脚本 + 可能含二进制**，`base64 in one JSON` 的快照格式会爆（见下条）。 |
| **插件自身配置文件** | 只 `.dsh-market/*.yml`（`core.js:943-948`） | 需要「插件配置发现」：扫描各插件文档里声明的配置路径，或维护 `$DSH_HOME/plugins/*.json` 白名单；不能像现在这样硬编码。 |
| **会话数据 sessions** | 明确拒绝（`README.md:27,30`） | 体量与隐私都变了：需要**单文件对象 + 分块/分片上传**，不能整包 base64。还要考虑 `sessions/*.jsonl` 追加写 → 用 `size+mtime` 快速判定是否变化。 |
| **全局 `AGENTS.md`** | 不覆盖 | 单文件、文本、**天然适合三方合并**（现在只有「整文件二选一」）。建议对文本类 scope 提供 `merge3`（行级 diff）策略，而不是 `cloud`/`local` 二选一。 |
| **增量同步** | 无 mtime/hash manifest，每次全量重传（`core.js:987-1001`、`1153-1158`） | 必须有 `manifest.json`：`{path: {size, mtimeMs, sha256, blobKey}}`。远端对象按 `blobs/<sha256>` 内容寻址，manifest 只传差异。这是我们现在最该补的能力（sessions 与 skills 体量下，全量重传不可接受）。 |
| **压缩格式** | 仅 `gzipSync`（`core.js:4`、`987`、`1200`、`1110`） | 大对象建议 zstd（Node 22+ 有 `zlib.zstdCompress`）；要么保留 gzip 但改成「每 blob 独立压缩」，避免整包一次性进内存（现在 100 MiB 源码上限就是被内存约束逼出来的，`core.js:13`、`1182`）。 |
| **本地路径 target** | 不存在 | 新增 `LocalDirProvider`：`put` 写临时文件 + `rename` 原子替换；`getWithMeta` 读 `stat` 算 etag（size-mtime）；`.dshsyncignore` 复用。 |
| **UI 信息架构** | 3 tab（云服务/配置与历史/同步状态）+ 一个 980px 宽的自绘卡片 | 我们要的是「同步项选择 + 目标列表 + 每项进度/冲突」，需要**列表化 + 逐项状态**，不能再用「一个巨大 tab」。可保留：sticky header、结果条、DiffDialog 勾选表、禁用渠道确认弹窗、设备码弹窗。 |
| **凭据（非 Windows）** | 明文件 0600（`core.js:262`） | 至少支持 `keytar` 式系统密钥库或「主口令 + AES」；至少不要比现在更弱。 |
| **从远端继承 `allowBuilds`** | 自动合并进本地 workspace（`core.js:1705-1738`、`1753`） | 改成「默认拒绝 + 显式确认 + 只允许用户已批准的 key」，见 5.5。 |
| **加密易用性** | 口令只在内存，重启必重输；UI 已移除入口（`core.js:32`、`856`、`1376`；`client.js` 无 `security/`） | 要么做「口令 + 系统密钥库缓存」，要么明确「每次启动输入」并在 UI 上给出入口。 |
| **自更新** | 绑死 GitHub Releases + 硬编码仓库与 OAuth client id（`core.js:21-27`、`158-166`、`1584-1595`） | 可保留作为「可选」，但别把更新通道和同步通道耦合进业务逻辑。 |
| **单文件快照 700 KiB 限制** | Gist 上限被迫降级为「仅配置」（`core.js:14`、`770`、`1128`） | 一旦换成 manifest + blobs，这个限制自然消失（Gist 仍可用，只是对象更多）。 |

### 7.3 建议的新架构骨架（供设计参考）

```text
core/
  targets/            // 每个后端一个文件，实现 {put,get,getWithMeta,probe,remove}
    local-dir.js      // 新增
    webdav.js         // 移植 WebDavProvider（含 MKCOL 兼容策略）
    s3.js             // 移植 S3Provider + signAwsV4
    gist.js           // 可选
  scopes/             // 每个同步项一个文件，声明 paths + 默认忽略 + 冲突策略
    profile-config.js // 复用 CONFIG_FILES + sanitize*
    skills.js         // 新增
    plugin-config.js  // 新增
    sessions.js       // 新增
    agents-md.js      // 新增（文本三方合并）
  manifest.js         // {path:{size,mtimeMs,sha256,blobKey}} 生成/比对/差异
  snapshot.js         // 打包：manifest + blobs；不再把文件内容塞进一个 JSON
  merge.js            // 逐 scope 策略：binary=二选一，text=merge3，json=结构化合并
  history.js          // 复用 index.json + 保留上限
  crypto.js           // 复用 AES-256-GCM + 装饰器
  secrets.js          // DPAPI / 系统密钥库 / 0600，按 targetId 存
  restore.js          // 复用「备份→写入→延后安装」
server/
  routes.js           // 复用 loopback 包装
client/
  panel.js            // settings.section：目标列表 + 同步项勾选 + 逐项状态 + DiffDialog
```

---

## 8. 证据索引（关键文件:行号）

| 主题 | 证据 |
| --- | --- |
| 包元数据 / dsh 字段 | `package.json:13-25` |
| cordis 插入 | `cordis.patch.yml:2-4` |
| host 入口 / 注入 / 路由 / 定时器 | `lib/index.js:3-4`、`23-29`、`32-55`、`56-61` |
| loopback / body 上限 | `lib/index.js:6-13`、`15-19` |
| client 入口 / 插槽 / 语言 | `lib/client.js:1`、`447-452`、`896-921`、`923-925` |
| 同步范围常量 | `lib/core.js:11`、`12`、`943-948` |
| 本地源码归档 | `lib/core.js:963-965`、`1190-1213`、`1231-1247` |
| 快照打包 | `lib/core.js:977-1003`、`986-988` |
| 冲突/合并 | `lib/core.js:1012-1101` |
| 同步主流程 | `lib/core.js:1115-1160` |
| 恢复流程 | `lib/core.js:1413-1454` |
| 历史 | `lib/core.js:1322-1347` |
| 加密 | `lib/core.js:820-859`、`1376-1392` |
| 凭据 | `lib/core.js:239-287`、`313-319` |
| provider 实现 | `lib/core.js:470-547`、`551-573`、`603-703`、`705-818` |
| 命令执行安全 | `lib/core.js:1456-1495` |
| 可移植化清洗 | `lib/core.js:168-237`、`967-975` |
| 测试 | `test/core.test.mjs`（341 行）、`test/client-locale.test.mjs:5-8` |

---

## 9. 事实与推断的边界说明

- 本报告中的**行号**全部来自 0.20.9 的已安装产物，未做任何修改。
- 以下结论是**【推断】**，未在运行时验证：
  1. `dsh.client.inject` / `platform` / `immediately` 的精确语义（DSH 实现为 asar 打包，本机不可读）；
  2. `order: 25` 在设置页的相对位置；
  3. 5.5 中「远端 `allowBuilds` → 自动批准 build 脚本 → 供应链 RCE」的完整利用链（代码路径成立，但触发需要用户在「同步状态」页点安装）；
  4. 各 provider 在真实服务（坚果云、七牛、COS）上的兼容性，仅从代码与 README 声明推断。
- 未做的事：没有运行 `npm test`（只读任务，且需要在该包目录执行），没有连接任何真实云端。
