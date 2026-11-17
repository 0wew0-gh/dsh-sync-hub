# DSH 数据同步插件 设计文档

> 状态：草案 v0.1（待评审）
> 项目代号：`dsh-sync-hub`（正式包名待定，见 §14.2）
> 目标读者：实现者、评审者、后续接手的 AI Agent
> 调研附录：[本地插件机制与数据盘点](research/data-inventory.md)、[同类插件逆向报告](research/cloud-sync-analysis.md)

---

## 1. 背景与目标

### 1.1 现状与痛点

DSH（DeepSeek Harness）把用户资产分散在多个位置：

| 资产 | 本机实际位置 | 现状 |
| --- | --- | --- |
| 全局 skills | `~/.agents/skills/`（95 个，约 25 MB） | 只能手动拷目录 |
| 插件设置 | 各 profile 的 `cordis.patch.yml`（按 entry id 的 config）+ 插件自有 json | 换机后逐项重配 |
| 插件文件 | `$DSH_HOME/plugins/`、`.agent-presets/`、`file:`/`link:` 本地插件源码 | 换盘符即失效 |
| 会话数据 | `$DSH_HOME/sessions/`（236 会话，压缩后约 313 MB） | 完全没有备份/迁移手段 |
| 全局 AGENTS.md | `$DSH_HOME/AGENTS.md`（约 12 KB） | 手动拷 |

已有插件 `@dickpy/dsh-cloud-sync` 只同步每个 profile 的 6 个配置文件（`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / `.npmrc`）+ `.dsh-market/*.yml` + 本地插件源码归档，**明确不覆盖 skills、插件自有配置、会话、全局 AGENTS.md**，且同一时间只能启用一个同步渠道、没有本地路径目标。详见[逆向报告](research/cloud-sync-analysis.md)。

### 1.2 目标（用户视角）

1. 在 DSH 的 **设置 → 插件** 里有一个属于自己的设置页，可以勾选要同步哪些数据。
2. 同步目标可配置多个：本地路径（含 UNC 共享、映射网盘、OneDrive/坚果云等同步盘目录）、WebDAV（坚果云、Nextcloud、群晖）、S3 兼容对象存储（阿里云 OSS、腾讯 COS、MinIO、Cloudflare R2、Backblaze B2），后续可扩展 rclone 覆盖原生网盘。
3. 一键「预览变更 → 同步」，冲突可见、可逐项选择，历史快照可回滚。
4. 换机/重装后能恢复出一致的 DSH 环境（先装回插件依赖，再恢复配置与会话）。
5. 全程不传凭据、不传 `node_modules`、不传缓存与日志。

### 1.3 非目标（v1 明确不做）

- 不做实时逐条增量（不监听文件系统变化做流式同步），只做「手动 + 定时」的批次同步。
- 不做多端同时在线协同（无冲突锁定服务），冲突按 §5.4 策略处理。
- 不做账号体系/服务端；不提供托管云。
- 不自动执行 `pnpm install`（恢复时提示用户在重启 DSH 后执行，见 §5.10）。
- 不接管 `$DSH_HOME/.credentials.yaml`（DSH 登录凭据），永久排除。
- 不做会话内容的加密端到端方案（提供可选 AES-256-GCM 加密，见 §9.6）。

---

## 2. 调研结论（摘要）

### 2.1 DSH 插件接入机制（有代码证据）

| 机制 | 结论 | 证据 |
| --- | --- | --- |
| 插件包结构 | `package.json` 的 `dsh.bundle.patch` 指向一个 YAML，内容是 loader 补丁 `- insert: [{id, name: '<包名>'}]`；装进 profile 后由 cordis 加载 | `@dickpy/dsh-cloud-sync/package.json`、`cordis.patch.yml` |
| host 入口 | 纯 ESM：`export const inject = ['webServer']`、`export function apply(ctx)`；`ctx.webServer.register({kind, path, handler})` 注册同源路由；`ctx.effect(fn, label)` 统一释放 | `dsh-builtin-toggles/lib/index.js`、`dsh-cloud-sync/lib/index.js` |
| client 入口 | 非 ESM 的单文件 bundle：`window.__ModuleLoader__.load({id, factory: (require) => { ... return {inject, apply} }})`，内部 `require('react')` | 同上 `lib/client.js:1` 附近 |
| 客户端插槽 | `ctx.slots.inject('<slot>', () => ctx.slots.register({name, id, order, label, locale, inject}, Component))`；插件可用的插槽有 `settings.section`（设置里的一级页）、`settings.plugins.tab`（内置「插件」设置页里的一个 Tab）、`plugins.item` / `plugins.bundle.config` / `plugins.row.config`（插件管理页的配置卡片/表单）等 | 插槽契约在 `dsh-client-ui-settings`、`dsh-client-ui-plugin-manager` 的 `slot-contract.d.ts`；`cloud-sync` 用 `settings.section`（order 25），`dsh-builtin-toggles` 用 `settings.plugins.tab`（order 20） |
| 客户端服务注入 | 模块级 `export const inject = ['slots', 'locale']` 注入的是 **cordis 服务名**；`dsh.client.inject` 则是**包名列表**，只参与模块图排程，不是服务注入（两者混淆会导致插件永不激活或图排序报环） | `dsh-client-modules` 运行时校验代码、编写指南 `ui-plugin.md` |
| 客户端文件形态 | `lib/client.js` 必须是**单文件 CJS 工厂包装**：`window.__ModuleLoader__.load({id: '<包名>', factory(require){...}})`，`id` 必须等于包名，且 `exports["./client"]` 必须存在；浏览器按 `/plugins/??<id>/client.js` 加载，包内其它资源默认不可达 | `dsh-client-modules` 的 `resolveMeta()` / `bundle ... loaded without registering` 报错 |
| 设置持久化 | 插件可不使用 cordis config，自行落盘（例如 `$DSH_HOME/dsh-cloud-sync/settings.json`） | `cloud-sync lib/core.js` |
| 本地开发安装 | `dsh plugin --profile web add <本地目录>`，本质是转发给 profile 目录里的 pnpm；安装后需完全重启 DSH Web | `dsh --help`、`dsh plugin` 行为、cloud-sync README |
| 构建 | 可以做到零依赖、零构建：手写 WebDAV/AWS SigV4，`node --check` 级验证 + `node --test` | cloud-sync（零依赖、无 src、无 bundler） |

### 2.2 本机数据盘点（详见[附录](research/data-inventory.md)）

- `$DSH_HOME` 总 68,099 文件 / 2.86 GB，其中 `node_modules` 1,704 MB、`.pnpm-store` 451 MB、`dsh-runtimes` 257 MB、`temp` 56 MB、缓存约 38 MB —— 全部排除。
- 真正要同步的「配置」不到 1 MB；体积主体是**会话 313 MB**（解压后 1,034 MB，最大单文件 12.58 MB）与**附件 101 MB**。
- 会话文件是 `session.v*.jsonl.zstd`：**首尾相接的独立 zstd 帧序列**（每帧内是 JSONL），不是单个 zstd 流；直接整文件解压只能得到第一帧。同步时应按不透明二进制处理，不做重编码。
- 会话目录名由「工作区绝对路径」编码而来（`D:\object\agents\sync` → `--D-object-agents-sync--`），跨机恢复需要路径映射选项。
- 插件设置的真实存储是三层：profile 的 `package.json`（依赖 + `dsh.profile.bundles`）、`cordis.patch.yml`（按 entry id 的 config/disabled）、插件自有文件（`$DSH_HOME/*.json`、`storages/<unit>.json`、`@scope/pkg/config.json` 等）。`$DSH_HOME/settings.yaml` 已不是配置源（只剩一次性导入存档 `settings.yaml.imported`）。
- skills 只在 `~/.agents/skills/`（rank 500），目录结构只发现一层 `<root>/<name>/SKILL.md`；`$DSH_HOME/skills` 不存在。注意：Web profile 在 bundle 层把宿主级 `skill-filesystem` 行禁用了，实际发现由 agent preset 层负责，所以「往 profile patch 里加 skill 根」未必生效；同步直接写 `~/.agents/skills` 即可。
- 全局 AGENTS.md 只有 `$DSH_HOME/AGENTS.md` 一个位置（`~/.agents/AGENTS.md` 不会被读取）；项目级按 `.git` 定根逐层查找 `AGENTS.md`/`CLAUDE.md` 与 `.local` 覆盖层，本项目仓库内的 AGENTS.md 属于项目资产、由项目自己管理。
- `cordis.patch.yml` 的 patch 语义是**整段替换 `config`，不是深合并**：写回时任何被覆盖的行都必须重述全部键，否则会丢配置。

### 2.3 参考实现的可复用/需重写

| 可复用 | 需重写 |
| --- | --- |
| Provider 鸭子接口（`put/get/getWithMeta/probe/remove`） | 单渠道 → 多目标 `targets[]` |
| 手写 WebDAV（MKCOL 兼容）与手写 SigV4 | 6 个文件白名单 → 可插拔 scope 抽象 |
| ETag 乐观并发（`If-Match`/`If-None-Match`，412/409 视为远端已变） | 全量 base64 快照 → manifest + 内容寻址 blob |
| 「先返回冲突列表、再让用户逐项选择」的 `needs-choice` 协议 | 「整文件二选一」→ 按 scope 的 merge3/结构化合并 |
| 历史快照 + 索引 + 保留上限 | 「明确不同步会话」→ 会话为一等公民 |
| 恢复前备份 + 依赖安装延后到重启 | 单 provider 密钥 → 按 targetId 存密钥 |
| loopback 路由包装（方法/Host/body 上限/安全头） | 硬编码 GitHub 自更新通道（v1 不做自更新） |

---

## 3. 总体架构

### 3.1 组件图

```text
┌──────────────────────────── DSH Web 前端 ────────────────────────────┐
│  设置 → 插件 → 「数据同步」tab（lib/client.js，React + __ModuleLoader__）│
│    · 同步项勾选 / 目标管理 / 预览与同步 / 冲突选择 / 历史恢复 / 高级   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ ctx.connection.rpc.call('/dsh-sync', ...)
                                │ （内建 Host/Origin 围栏 + 浏览器令牌）
┌───────────────────────────────▼──────────────────────────────────────┐
│  host 插件（lib/index.js，cordis，inject: ['connection','webServer']）│
│    · RPC 端点（首选，复用内建鉴权）/ 裸路由（兜底，自建 loopback 围栏）│
│    · 调度器：ctx.effect 定时器（禁用/加密未解锁时直接返回原因）        │
└───────────────────────────────┬──────────────────────────────────────┘
│  core（lib/core/*.js，纯逻辑、可单测、零依赖）                          │
│    scopes/  → 扫描本机数据，产出候选文件集（含默认排除规则）           │
│    manifest → 生成/比对本地清单（size + mtimeMs + sha256）             │
│    targets/ → local-dir / webdav / s3 /（rclone）统一读写接口          │
│    merge    → 按 scope 策略做二进制/文本/结构化合并                    │
│    history  → 远端快照索引、保留上限、恢复与回滚                       │
│    secrets  → DPAPI（Windows）/ 0600 文件，按 targetId 存              │
│    state    → 本地 base 清单、日志、备份目录                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              ▼                                    ▼
   远端仓库（每个 target 一份）            本地状态目录
   meta.json / manifests/ / blobs/         $DSH_HOME/dsh-sync-hub/
   snapshots/                              (settings.json / state / backups)
```

### 3.2 技术选型

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 运行时依赖 | **0 个**（仅 Node 内置模块） | 免供应链风险、免装依赖、跨平台；WebDAV 与 SigV4 各约 100 行 |
| 语言/模块 | ESM，Node >= 22.19（本机 24.21） | 与 DSH 插件要求一致 |
| 构建 | **无构建**，`lib/*.js` 直接分发 | 参考实现已证明可行；`node --check` + `node --test` |
| 类型 | JSDoc + `tsc --checkJs`（可选，devDependency） | 不引入构建也能获得类型检查 |
| 前端 | React（由外壳模块表提供）手写组件，不 `require` 任何 `@deepseek-ai/dsh-client-*` 包 | 官方规范：客户端 bundle 禁止跨插件值导入，且 primitives 等包随时可能变 |
| 通信 | 首选 `ctx.connection.rpc.handle('/dsh-sync', handler)` + 客户端 `ctx.connection.rpc.call`（内建 Host/Origin 围栏与浏览器令牌）；兜底 `ctx.webServer.register` + 自建 loopback 围栏 | 参考实现的裸路由需要自己防 CSRF/DNS rebinding；RPC 通道有内建鉴权。注意 RPC 宿主侧第三方先例缺失，需实测，故保留兜底 |
| 客户端 bundle | 单文件 CJS 工厂包装，`id` = 包名；图标等资源内联（包内 `assets/` 浏览器不可达） | `dsh-client-modules` 的加载契约；否则报 `loaded without registering "<id>"` |
| 压缩 | 传输层不重复压缩（会话本身已 zstd）；文本 blob 可选 gzip | 避免对帧序列做错误重编码 |
| 存储格式 | 内容寻址 blob + JSON manifest（git 式对象/树模型，§5.11） | 天然去重、可断点、可校验；同内容不重复存储/传输 |

### 3.3 开发与调试链路

| 环节 | 做法 |
| --- | --- |
| 本地挂载 | `dsh plugin --profile web add file:D:/object/agents/sync`（或 `link:`，改代码即生效）；随后把包名加入 profile `package.json` 的 `dsh.profile.bundles`，或在 profile `cordis.patch.yml` 里 `insert` 一行 |
| 生效范围 | 宿主 JS 与配置改动由 dsh-hmr 热重载；**客户端 bundle 与已安装包替换需要完全重启 DSH** |
| 自检 | `dsh --profile web --dump-config` 看本插件的行是否进去、被谁覆盖；`--dump-config-schema` 不挂载即可看 Config schema |
| 前端排障 | 插槽条目崩溃只在控制台报 `slot entry crashed in '<slot>'`；bundle id 不匹配报 `bundle ... loaded without registering` |
| 测试 | `node --check lib/*.js` + `node --test test/*.mjs`；假 WebDAV/S3 用 `node:http` 起在本机随机端口 |

---

## 4. 数据模型

### 4.1 同步项（Scope）

每个 scope 是一段**声明式描述**：`paths`（要收哪些）、`defaultExclude`（默认排除）、`maxFileBytes`、`conflictPolicy`、`restoreOrder`。

| scope id | 名称 | 本机来源 | 体积 | 默认 | 冲突策略 |
| --- | --- | --- | ---: | --- | --- |
| `plugin-settings` | 插件设置 | 各 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`.npmrc`、`pnpm-lock.yaml`、`compatibility.json` | < 0.1 MB | 开 | 结构化合并（§5.6） |
| `plugins` | 插件 | 所选插件在 `profiles/<profile>/node_modules/<name>/` 下的安装包 | 按插件大小 | 开 | `keep-both` |
| `plugin-files` | 插件文件 | `$DSH_HOME/plugins/**`、`$DSH_HOME/.agent-presets/**` | 1.4 MB | 开 | 按文件 newer（可选 keep-both） |
| `skills` | 全局 Skills | `~/.agents/skills/**`、`~/.agents/.skill-lock.json` | 25 MB | 开 | 按文件 newer；删除走 tombstone |
| `memes` | 表情包 | `$DSH_HOME/meme-packs/**`、`$DSH_HOME/dsh-expression.json` | 7 MB | 开 | per-file keep-both |
| `skins` | 外观皮肤 | `$DSH_HOME/skins/**`、`$DSH_HOME/skin-center/**`、`$DSH_HOME/skin-center-active.json` | 85 MB | 开 | per-file keep-both |
| `pets` | 宠物外观 | `$DSH_HOME/pets/**`、`$DSH_HOME/pet.json` | 211 MB | 开 | per-file keep-both |
| `sessions` | 会话数据 | `$DSH_HOME/sessions/**` | 313 MB | 开 | per-file keep-both（§5.4） |
| `attachments` | 会话附件 | `$DSH_HOME/attachments/**` | 101 MB | 关（可选/懒同步） | 内容寻址、缺失即补 |
| `agents-md` | 全局 AGENTS.md | `$DSH_HOME/AGENTS.md` | 12 KB | 开 | 文本 merge3 |
| `storages` | 工作区与统计 | `$DSH_HOME/storages/workspace.json` 等 | 0.1 MB | 关（含绝对路径，风险） | newer |

补充约定：

- `plugin-settings` 的 profile 范围可勾选（默认只同步 `web`；`desktop` 可加选；`cc-tui`、`dsh-tui` 体积小可一并）。
- 单个 scope 可再加「额外包含」与「额外排除」规则（glob），存于 `settings.json`。
- 附件按内容寻址且不可变，只需补缺失对象，不需要冲突处理；默认关闭是为了控制首同步体积。

### 4.2 同步目标（Target）

```ts
type Target =
  | { id, name, kind: 'local',  enabled, path }                       // 本地目录/UNC/映射盘/同步盘目录
  | { id, name, kind: 'webdav', enabled, url, username, allowHttp }   // 坚果云/Nextcloud/群晖/AList
  | { id, name, kind: 's3',     enabled, endpoint, region, bucket, prefix,
      accessKeyId, forcePathStyle, providerHint }                     // OSS/COS/MinIO/R2/B2/S3
  | { id, name, kind: 'rclone', enabled, remote, remotePath };        // 可选，调用本机 rclone
```

- 多目标可同时启用；每次同步对每个启用的 target 依次执行，结果分别汇总。
- 每个 target 可单独选择「同步哪些 scope」（默认继承全局勾选）。
- 每个 target 的凭据单独保存（`secrets[targetId]`），**永不写入 `settings.json`、永不同步**。
- 「网盘」的落地建议：坚果云/Nextcloud/群晖 → WebDAV；OneDrive/阿里云盘/百度网盘 → 本机同步盘目录（`local`）或 rclone（v0.3）；不做各家 OAuth 原生 API（审核与不稳定性成本过高）。

### 4.3 远端仓库布局

每个 target 下固定版本前缀（默认 `dsh-sync-v<插件版本>/`，可配；旧默认 `dsh-sync/v1/` 会自动迁移到新前缀）：

```text
dsh-sync-v0.4.0/
  meta.json                         # { schema, dshVersion, updatedAt, scopes, devices: {id: {name, lastSeenAt, version}} }
  manifests/<deviceId>.json         # 每设备、每 scope 的清单（同一文件内按 scope 分组）
  blobs/<aa>/<bb>/<sha256>          # 原始字节，内容寻址（aa/bb 为 sha256 前两段，避免大目录）
  snapshots/index.json              # 历史索引 { schema, entries: [{key, createdAt, deviceId, scopes, totalBytes}] }
  snapshots/<ISO-ts>/manifest.json  # 历史快照（只含清单，blob 复用 blobs/）
  plugin-states/<profile>.json      # 插件启动与配置 { schema, profile, bundles, disabled, rows, updatedAt }
```

设计要点：

- **清单与内容分离**：清单很小（几百 KB），每次同步必传；内容块只在第一次或变更时上传。
- **blob 只增不减**：由「保留策略」定期清理无引用的 blob（v0.3），v1 不做 GC，只报告占用。
- 不使用对象存储的 list 能力：所有对象名都来自清单，S3/MinIO 的 `ListObjects` 权限可以不授予。

### 4.4 清单格式

```json
{
  "schema": "dsh-sync/v1/manifest",
  "deviceId": "f3c2...",
  "deviceName": "DESKTOP-01",
  "updatedAt": "2026-11-13T03:00:00.000Z",
  "scopes": {
    "sessions": {
      "files": {
        "sessions/--D-object-agents-sync--/session-xxx/session.v4.jsonl.zstd": {
          "size": 116366,
          "mtimeMs": 1793080548669,
          "sha256": "9a1b...",
          "blob": "9a/1b/9a1b...",
          "deletedAt": null
        }
      },
      "removed": []
    }
  }
}
```

字段说明：

- `size` + `mtimeMs` 用于**快速判定未变化**；只有两者之一变化才计算 `sha256`（大目录扫描不至于每次全量哈希）。
- `sha256` 是内容寻址与完整性校验的唯一依据，也是「同内容不覆盖」的判定依据：**两个路径的 `sha256` 相同即视为同一内容**，远端只存一份 blob；写目标文件前先比 `sha256`，相同则跳过写入（§5.2.1）。
- `removed` 是 tombstone（删除意图），用于把删除传播到其他设备；只有「基线里存在、本地已删、远端未改」时才生效。

### 4.5 本地状态目录

```text
$DSH_HOME/dsh-sync-hub/
  settings.json                      # 非敏感设置（targets、scopes、策略、定时、设备名）；密钥字段打码
  secrets.json                       # { version: 1, secrets: { [targetId]: { scheme: 'dpapi'|'file-0600', secret } } }
  state/
    <targetId>/
      base-manifest.json             # 上次成功同步后的合并清单（三方比较的 base）
      last-run.json                  # 上次运行结果摘要（UI 直接读）
      log.jsonl                      # 最近 N 次操作日志（可关闭）
  backups/<ISO-ts>/<scope>/...       # 恢复/覆盖前的本地备份
  locks/                             # 进程内互斥 + 跨进程锁文件（尽力而为）
```

设置里只出现 `<stored-locally>` 占位符，客户端据此知道「留空即复用」。

---

## 5. 同步引擎

### 5.1 扫描（scan）

1. 按 scope 的 `paths` 枚举文件，应用内置排除规则与用户规则（§9.4）。
2. 对每个文件记录 `relPath / size / mtimeMs / mode`；目录也记录（用于恢复空目录，如 skills 的 `assets/`）。
3. 单文件超过 `maxFileBytes`（默认 64 MB）跳过并计入报告（不静默丢弃）。
4. 符号链接默认不跟随（防止把工作区外的内容带进同步集）；scope 可显式允许。

### 5.2 三方比较

对每个 scope：

```text
L = 本机本次扫描清单
B = 本地 state/<targetId>/base-manifest.json 中该 scope 的清单（上次同步结果）
R = 远端 manifests/ 中「其他设备」清单按 updatedAt 合并后的并集（同路径多设备取最新）

localChanged  = L[p] != B[p]   （新增/修改/删除）
remoteChanged = R[p] != B[p]
```

判定表：

| localChanged | remoteChanged | 动作 |
| --- | --- | --- |
| 否 | 否 | 无操作 |
| 是 | 否 | 上传（写 blob → 更新本地清单） |
| 否 | 是 | 下载（按需取 blob → 原子写） |
| 是 | 是 | 内容相同则无操作；不同则按 §5.4 冲突策略 |
| 删除 | 未改 | 传播删除（写 tombstone） |
| 删除 | 已改 | 冲突：保留远端并恢复本地，或按策略 |

### 5.2.1 「同内容不覆盖」与快进（git 式语义）

核心原则：**内容相同就是同一个对象** —— 不写入、不上传、不改 mtime。每次写文件之前先比较内容，只有内容不同才谈「合并」或「覆盖」。

1. **同一路径的判定顺序**：
   - 快速路径：`size` 与 `mtimeMs` 都相同 → 视为未变，直接 noop（不哈希、不传输）。
   - 慢路径：`size`/`mtimeMs` 有变化 → 计算 SHA-256 后与 base、远端比较：
     - 与远端一致 → noop（不下载、不写、**不改本地 mtime**）；
     - 与 base 一致、只有远端变化 → 远端是唯一改动方 → 快进下载（这是「更新」，不是「覆盖」）；
     - 与 base 一致、只有本地变化 → 快进上传；
     - 与 base 和远端都不同 → 进入冲突流程（§5.4）。
2. **跨路径去重**：不同路径的 SHA-256 相同 → 远端只存一份 blob（内容寻址天然去重）；恢复时每个路径都写，但只传输一次。
3. **写前比较（禁止无意义覆盖）**：下载/恢复写目标文件前，先计算目标文件的 SHA-256；**相同则跳过写入**，保留原文件的 mtime/权限/ACL，避免杀毒扫描、mtime 抖动、HMR 误触发与无谓 IO。
4. **fast-forward**：只有一侧有改动、另一侧未变时直接采用改动侧，不做合并；日志记为 `fast-forward(local→remote)` 或 `fast-forward(remote→local)`。
5. **三方合并**：两侧都改且内容不同，才进入 §5.4/§5.5 的合并或裁决；**默认不覆盖**，无法自动合并时返回 `needs-choice`，绝不静默选边。
6. **判定依据**：内容是否相同以 SHA-256 为准，mtime 只用于快速跳过，不做最终判断；设备时钟不同不会造成误判。
7. **例外开关**：设置里的「强制覆盖」（默认关）跳过第 3 条的写前比较，仅用于修复损坏文件；开启时 UI 二次确认，并在结果里标红。

### 5.3 上传/下载

- **先内容后清单**：新 blob 全部上传成功后再写 `manifests/<deviceId>.json`，最后更新 `snapshots/index.json`；中途失败不会产生「清单指向不存在 blob」的状态。
- **同内容不传**：上传前若远端已有同 SHA-256 的 blob（被任一路径引用），跳过上传；下载时若目标路径已存在且内容相同，跳过写入。若同内容存在于本地其它路径，可复制一份到目标路径（**不做硬链接**：会话文件会追加写，硬链接会导致两个路径互相污染）。
- **原子写**：本机写入一律 `tmp` 文件 + `fs.rename`；远端 WebDAV/S3 用整对象 PUT（S3 单对象 PUT 本身原子；WebDAV 用 `PUT` 到临时名再 `MOVE`，不支持 MOVE 的服务器退回直接 PUT 并记录日志）。
- **下载校验**：下载后校验 `sha256` 与 `size`，不一致重试一次后报错，绝不写坏文件。
- **并发**：`If-Match`（有远端 ETag 时）/ `If-None-Match: *`（首次创建）；412/409 视为「远端已变化」，中止本次并提示重新预览，不盲目重试。
- **重试**：网络错误指数退避 3 次（1s/3s/9s）；S3 与 WebDAV 单请求超时 30s。

### 5.4 冲突策略矩阵

| scope | 数据类型 | 默认策略 | 可选策略 | 说明 |
| --- | --- | --- | --- | --- |
| `sessions` | 二进制 | `keep-both` | `newer` / `local` / `remote` | 默认：本地版本继续使用，远端版本另存为同目录下 `<原名>.conflict-<device>-<ts>` 并上传，绝不丢任一侧 |
| `attachments` | 不可变对象 | 缺失即补 | — | 内容寻址，理论上无冲突 |
| `skills` | 文件树 | `newer` | `keep-both` | 以 mtime 较新者为准；同 mtime 时本地优先并记录 |
| `plugin-files` | 文件树 | `newer` | `keep-both` | 同上 |
| `agents-md` | 文本 | `merge3` | `newer` / `local` / `remote` | 行级三方合并；无法合并时阻止自动完成并展示 diff |
| `plugin-settings` | YAML/JSON | `local`（临时） | `local` / `remote` / 结构化合并（§5.6，待实现） | 冲突时保留本机，避免旧备份还原插件开关 |
| `storages` | JSON | `newer`（默认关） | — | 含绝对路径，仅同构环境使用 |

全局策略（设置页可选）：`smart`（默认，逐项按上表）、`local-first`、`remote-first`。`smart` 遇到无法自动裁决的项时返回 `needs-choice` + 冲突列表，由 UI 逐项勾选后二次提交，不做静默覆盖。

所有 scope 共通：**内容相同一律 noop（§5.2.1），冲突策略只在内容确证不同后才生效**；任何策略（包括 `local-first`/`remote-first`）都不允许在「内容相同」时改写文件，也不允许借策略之名绕过写前比较。

### 5.5 文本三方合并（merge3）

实现一个最小 LCS 行级 diff3（约 150 行，无依赖）：

- 输入：`base`（上次同步内容）、`ours`（本地）、`theirs`（远端）。
- 双方都未改的行原样保留；只有一侧改动的行取改动侧；两侧改动相同则取其一；两侧不同则产生冲突块。
- 冲突块默认**不写入**，而是返回冲突位置（行号 + 两侧片段）；用户在 UI 选择「用本地 / 用远端 / 手工编辑后重试」。
- 若设置里允许，可用行内冲突标记（`<<<<<<< local` / `=======` / `>>>>>>> <device>`）写入并标注为「未解决冲突」，但默认关闭（AGENTS.md 被 DSH 读取，缺标记会造成指令误读）。

### 5.6 结构化合并（plugin-settings）

**`cordis.patch.yml`**（顶层是 patch 条目数组，按 `id` 定位）：

1. 解析为条目列表；按 `id` 建索引（无 id 的条目按序列化内容建 pseudo-id）。
2. 合并前先比较**语义等价**：若两侧解析后的条目与配置完全相同，则整文件 noop（不写回、不改 mtime），即使注释或空行不同。
3. 同一 id：比较 `config`/`disabled`；只有一侧变化则取变化侧；两侧都变则冲突（默认取较新文件的一侧并备份另一侧，同时列出差异）。
4. 本机独有条目保留；远端独有条目追加（保持远端原有顺序，追加到末尾）。
5. 输出前做可移植性清洗：删除空 `[]` 占位、剥离本插件自身条目、不写入 `storeDir` 之类机器相关字段。
6. 写回前备份原文件到 `backups/<ts>/`，用 YAML 序列化（保持注释的代价过高，v1 明确「合并后注释可能丢失」，在 UI 提示；可选择「本地优先，不合并」以避免丢注释）。

**`package.json`**：

1. `dependencies` 取并集；同一包版本冲突时以较新写入时间的文件为准，并在结果里列出差异供用户确认。
2. `dsh.profile.bundles` 保序并集：先按本地顺序，再追加远端独有项；过滤「不在 dependencies 且不是 `@deepseek-ai/dsh-` 前缀」的孤儿项。
3. 绝不合并 `pnpm.onlyBuiltDependencies` / `allowBuilds` 之外的可执行钩子；**远端带来的 build 白名单一律不自动继承**（§9.7）。
4. `pnpm-lock.yaml` 冲突默认取远端（与参考实现一致），随后提示执行 `pnpm install`。

### 5.7 会话数据专项

- **按不透明二进制传输**：不解压、不重编码、不解析内容。文件字节即 blob，回写后必须与原文件逐字节一致（测试用 SHA-256 断言）。
- **增量判定**：`size + mtimeMs` 未变则跳过；只对变化文件算 `sha256`。活跃会话在回合中会持续追加，扫描时若发现 `size` 在哈希前后变化，记为「写入中」并跳过本轮（下一轮再传）。
- **同内容不重写**：下载/恢复前先算目标文件 SHA-256，相同则跳过写入（§5.2.1）——不会因为一次同步触碰正在使用的会话文件，也不改 mtime。
- **追加即新内容**：活跃会话追加后整文件 SHA-256 变化，会上传为新 blob（旧 blob 保留给历史快照，由 P8 的 GC 清理）；未追加的会话保持「相同跳过」，不会重复传输。
- **最大单文件 12.58 MB**：整文件 PUT/GET 可接受；超 64 MB（未来版本）再引入分块。
- **冲突**：同一会话在两台机器各自追加后，zstd 帧序列无法安全拼接（序号/顺序会乱），因此默认 keep-both（§5.4），不做帧级合并。用户可手工决定保留哪一份。
- **路径重映射**：目录名编码了工作区绝对路径。恢复时提供三种模式：
  1. `as-is`（默认）：原样恢复，DSH 会把它当成一个「陌生路径」的工作区；
  2. `map`：按用户配置的映射表（`D:\object\agents` → `/home/me/object/agents`）重写目录名；
  3. `skip`：跳过其他设备的会话目录。
- **会话选择**：`scopes.sessions.mode = 'all' | 'selected'` + `selectedSessionIds`。`all` 保持全量行为（含以后新建的会话）；`selected` 只同步勾选的 session 目录，新会话默认不自动加入。扫描在遍历后按 session id 过滤，manifest 仍保留 `sessions/<projectDir>/<sessionId>/...` 的项目目录结构。
- **按 sessionId 归一**：一个 sessionId 就是一个会话。普通同步计划在比较前把本地/远端/base 中同一 id 的多份副本折叠到同一 canonical 项目目录（优先本地副本），因此不会因为重复目录重复上传；`.dedupe-backup-*` 隔离目录不参与同步。
- **追加快进**：sessions 的 keep-both 冲突先做字节前缀判断——本地含备份全部字节（或反之）时改为快进上传/下载；分叉才保留双方副本。
- **按电脑 + 用户保存路径**：`sessionPaths: { '<deviceName>|<osUserName>': { '<sessionId>': '<绝对路径>' } }`。迁移/恢复按 current device|user → sessionId 优先解析；找不到再回退旧 `sessionPathMappings`，最后才做「旧用户目录 → 当前用户目录」换算。旧版 session-first 结构在 `normalizeSettings` 中自动转换。迁移成功或恢复后自动写入；设置页可编辑/删除。
- **同一会话对比与覆盖**：会话页对比本地与最新备份 manifest 的 size / mtime / sha256 / 是否 append-only，提供「同步到备份」「从备份同步」「覆盖本机」「覆盖备份」。覆盖必须显式确认，且先备份被覆盖侧；分叉时由用户选择方向，不做帧级合并。
- **从备份恢复（最新 manifest）**：默认读取目标端最新 manifest，不读取历史快照。恢复前把本机同名 sessionId 的所有副本移动到本机备份目录（`state/backups/<ts>/sessions/`），再原子写文件、改写会话头 cwd；单会话时目标路径即会话路径，多会话时作为基础目录保留相对结构。`autoReplaceUserFolder`（默认 false）控制是否自动替换旧用户目录。
- **恢复后**：会话列表由 `storages/workspace.json` 与 `storages/session_projcache/` 支撑，恢复后提示「重启 DSH 或清理投影缓存」，插件提供「清理投影缓存」按钮（只删 `session_projcache`，可再生成）。

### 5.8 增量与断点

- 网络中断后重跑：已上传 blob 按 `HEAD`（S3/WebDAV）判断存在性，存在则跳过；清单未更新则整体重算，重复上传会被内容寻址去重。
- 大批量下载（首次换机）按 scope 分批，每批 200 个文件或 64 MB，UI 显示进度；中途取消不破坏本地（原子写）。
- 首次同步大目录（313 MB 会话）预估：本地目录目标 < 10s；WebDAV 视上行带宽（例如 10 Mbps 约 4–5 分钟）；S3 视网络。

### 5.9 历史与回滚

- 每次成功同步（有实际变更时）写一个快照：`snapshots/<ISO-ts>/manifest.json` + 追加 `snapshots/index.json`（`if-match` 乐观并发）。
- 保留上限默认 30（1–200 可配），超限删除最旧快照的 `manifest.json`（blob 不动）。
- UI「历史与恢复」：列出快照（时间、设备、包含 scope、变更文件数）→ 预览 diff → 恢复。
- 恢复粒度：整个快照 / 单个 scope / 单个文件（v0.3 支持单文件）。
- 恢复前自动备份当前本地对应 scope 到 `backups/<ts>/`，并在结果里给出备份路径。

### 5.10 恢复顺序

跨机恢复必须按依赖顺序，避免 DSH 读到半套配置：

1. `plugin-settings` 的 `package.json`（依赖 + bundles）
2. **提示用户**：完全退出 DSH → 在 profile 目录执行 `pnpm install`（或 `dsh plugin --profile web add <pkg>` 补齐）→ 再启动
3. `cordis.patch.yml`（插件启停与配置）
4. `plugin-files`（本地插件源码、预设）
5. `skills`
6. `storages`（可选，含工作区索引）
7. `sessions`
8. `agents-md`
9. 提示重启 DSH；按需「清理投影缓存」

恢复过程中任何一步失败都停止后续步骤并报告已完成/未完成清单，不半途覆盖。

### 5.11 与 git 的语义对照

本插件的同步模型刻意对齐 git 的「对象 + 三方合并」心智，便于解释行为：

| git 概念 | 本插件对应 | 说明 |
| --- | --- | --- |
| blob（内容寻址对象） | `blobs/<sha256>` | 相同内容只存一份，跨路径去重 |
| tree | `manifest` | 路径 → `{sha256, size, mtimeMs, mode, blob}` |
| commit | `snapshots/<ts>/manifest.json` + 索引 | 一次成功同步的快照，带设备与时间 |
| HEAD / 上次提交 | `state/<targetId>/base-manifest.json` | 三方比较的基准（base） |
| `git merge`（三方合并） | §5.2 三方比较 + §5.5/§5.6 合并 | 只有两侧都改才合并 |
| fast-forward | §5.2.1 第 4 条 | 一侧未改时直接采用改动侧 |
| conflict / 冲突标记 | `needs-choice` + DiffDialog | 默认不覆盖，逐项裁决 |
| `git checkout` / `reset` | `restore`（整快照/scope/文件） | 恢复前备份，原子写 |
| `.gitignore` | 硬排除 + `.dshsyncignore` | 用户规则只能追加，不能取消硬排除 |
| `git fsck` | 完整性校验 | 每个 blob 落盘/下载后校验 SHA-256 与大小 |
| `git gc` | blob GC（P8） | 按清单引用计数清理孤儿对象 |

与 git 的**不同**：不做提交图与分支、不做 rebase；`base` 是每个 target/设备各自维护的「上次同步结果」，因此多设备场景等价于「各自与上次同步点做三方合并」，而不是与所有历史合并。

---

## 6. 同步目标实现

### 6.1 统一接口（鸭子类型）

```ts
interface TargetProvider {
  probe(): Promise<void>                       // 连接/权限/前缀可写检查
  getWithMeta(key): Promise<{ body: Buffer, etag?: string }>   // 不存在返回 undefined
  put(key, body, opts?: { ifMatch?: string, ifNoneMatch?: boolean }): Promise<{ etag?: string }>
  head(key): Promise<{ size: number, etag?: string } | undefined>
  remove?(key): Promise<void>
}
```

所有 provider 只操作「相对仓库前缀的 key」，路径拼装与安全校验在 core 统一完成。

### 6.2 本地目录（`local`）

- 路径支持：绝对路径、UNC（`\\nas\share\dsh`）、映射盘符、同步盘本地目录（OneDrive/坚果云/百度网盘同步文件夹）。
- `put` 写 `<key>.tmp-<rand>` 后 `rename`；`getWithMeta` 的 etag 用 `size-mtimeMs`；`probe` 检查目录可写（写删一个探针文件）。
- 并发：同一 target 用 `.lock` 文件 + 进程内互斥；检测到别的设备正在写（lock 未过期）时提示。
- 不跟随符号链接；目标必须在用户显式选择的目录内（恢复时校验 `realpath` 前缀）。

### 6.3 WebDAV（`webdav`）

- Basic 认证；强制 HTTPS，局域网 HTTP 需显式开关并红色警告。
- 逐级 `MKCOL` 建目录，`405`/`301`/`302` 视为已存在，`409` 时先 `probe` 再重试一次（兼容坚果云、群晖）。
- ETag 用 `If-Match` / `If-None-Match`；`PUT` 到临时名再 `MOVE` 覆盖（不支持时退回直接 PUT 并记录）。
- 适配：坚果云、Nextcloud、群晖 WebDAV Server、AList/OpenList。

### 6.4 S3 兼容（`s3`）

- 手写 SigV4（约 120 行），不引 SDK；支持 path-style 与 virtual-hosted-style。
- 预置 provider 提示（只影响默认 region 与寻址方式）：AWS S3、阿里云 OSS、腾讯云 COS、MinIO、Cloudflare R2、Backblaze B2。
- 必须能只授予「对象读写 + 前缀内」权限；不要求 `ListBucket`。
- ETag 冲突语义：OSS 不支持 `If-Match` 时按 409/412 判定（与参考实现一致）。

### 6.5 rclone（可选，v0.3）

- 仅当用户本机已安装 rclone：`rclone copyto <remote>:<path> -`（stdin/stdout 管道）或临时文件；用 `--config` 指定配置。
- 覆盖 Google Drive、OneDrive、阿里云盘、百度网盘等无公开稳定 API 的网盘。
- 明确提示：rclone 需要用户自行安装与授权，插件不代管其配置。

### 6.6 凭据与并发

- 密钥按 `targetId` 存 `secrets.json`：Windows 用 DPAPI（`ProtectedData.Protect`，PowerShell 子进程 + stdin 传明文，兼容 `$env:DSH_SYNC_NO_DPAPI=1` 降级）；其他平台 0600 文件，并在 UI 标注「本机明文保存」。
- 内存中只在同步期间持有明文；日志、错误信息、`settings.json` 一律打码。
- 每个 target 记录上次成功的远端 ETag，用于并发检测；不做服务端锁。

---

## 7. 设置页 UI

### 7.1 入口与插槽

DSH 没有「注册设置页函数」，所有设置 UI 都是插槽贡献：

- **首选 `settings.plugins.tab`**：在 **设置 → 插件** 页里新增一个「数据同步」tab（与内置 tab 并列）。slot 契约是 list/root，`register` 选项为 `{name, id, order, label, locale, inject}`，owner props 为空。这与需求里的「dsh 插件页中的设置页」一致。
- **可选增强 `plugins.item`**：在插件管理页给本插件加一张卡片（`view: 'summary'` 显示「已同步 / 目标 n / 上次时间」，`view: 'page'` 打开同上面板），让用户从插件页直接看到状态。v0.2 再做。
- **兜底 `settings.section`**：若某版本没有 `settings.plugins.tab`，退化为设置页一级分区（`label` 可传 thunk，`order` 排位，owner 会传 `close()`）。注册前先探测插槽是否存在，不存在则换下一个。
- 插槽注册写法：`ctx.slots.inject(key, () => ctx.slots.register({...}, Component))`；返回的 disposer 自动绑定插件 fiber，卸载即回收。
- 客户端模块级服务注入：`export const inject = ['slots', 'locale', 'connection']`；**`dsh.client.inject` 只写包名（模块图排程）**，两者不可混用。
- 样式只用主题 token（`--dsw-alias-*`），支持明暗切换；不写 `document.body`/`#root`，不读其它插件 DOM；图标内联进 bundle（包内 `assets/` 浏览器不可达）。
- 不使用 `@deepseek-ai/dsh-client-ui-primitives` 等外壳包作为模块依赖（官方规范禁止跨插件值导入）。

### 7.2 信息架构

三个 tab（与参考实现的「三页」信息架构对齐，但内容改为本插件的语义）：

#### ① 同步（默认页）

- 顶部：设备名 + 目标选择器（多选，默认全部启用目标）+ 方向（双向/仅上传/仅下载）+ 策略（智能/本地优先/远端优先）。
- 同步项卡片列表（每项一行，可展开细节）：checkbox + 名称 + 预估文件数/体积 + 上次同步时间 + 状态徽标（未同步/已同步/有冲突/已跳过）。
  - `sessions` 展开：包含附件开关、路径映射模式、清理投影缓存按钮。
  - `plugin-settings` 展开：profile 勾选（web/desktop/cc-tui/dsh-tui）。
- 预览结果按动作分组展示：**相同（跳过）**、快进上传、快进下载、合并、删除、冲突；「相同（跳过）」置顶为可折叠的汇总行（只显示数量与前几个路径），避免几百个 noop 淹没真正要看的变更。
- 底部固定操作条：`预览变更` / `开始同步` / 进度条 / 结果摘要（上传 n、下载 n、相同跳过 n、合并 n、删除 n、冲突 n、失败 n）。
- 冲突出现时弹 `DiffDialog`：按 scope 分组，逐项显示路径与「本地/远端」摘要，单选或批量选择，确认后二次提交。
- 每个目标行展示「上次同步结果」小徽标：`+3 ↑2 ↓1 =120`（新增/上传/下载/相同跳过）。

#### ② 同步目标

- 目标列表卡片：名称、类型徽标、地址摘要、状态（已连接/未验证/错误）、上次同步、启用开关、编辑/删除。
- `添加目标` 抽屉：类型选择（本地路径 / WebDAV / S3 兼容 / rclone）→ 表单（按类型动态字段）→ `测试连接`（写探针并读回）→ 保存。
- 密钥输入框：占位符提示「已保存，留空复用」；从不回显明文。保存时若检测到明文从表单提交，提示「将存入本机凭据库」。
- 删除目标需二次确认（只删配置，不删远端数据；明确文案）。

#### ③ 历史与恢复

- 快照列表（时间倒序）：时间、设备、包含 scope、变更数、体积；行内 `预览` / `恢复`。
- 预览：按 scope 列出将新增/覆盖/删除的文件（只读清单，不含内容）。
- 恢复：选择 scope → 二次确认（列出将覆盖的文件数与备份位置）→ 执行 → 结果（含「需要重启 DSH」与 `pnpm install` 提示）。
- 保留上限输入（1–200）。

高级项（放在「同步」tab 底部的「高级」折叠区）：排除规则编辑、定时同步、加密口令、脱敏开关、设备名、日志导出、清空本地状态。

### 7.3 关键交互流

1. **首次使用**：打开 tab → 显示「还没有同步目标」空态 + 引导按钮 → 添加目标 → 测试连接 → 勾选同步项 → 预览 → 同步。全程无强制步骤，未配置目标时按钮禁用并说明原因。
2. **冲突**：同步返回 `needs-choice` → 弹窗 → 用户逐项选择 → 再次同步（只处理冲突项）→ 成功。取消则保留现场（不做任何写入）。
3. **恢复**：先 `预览` 确认影响面 → 恢复 → 显示「重启 DSH」提示与备份路径；若含 `package.json` 变更，额外显示 `pnpm install` 命令。
4. **长任务**：同步过程显示阶段（扫描 / 比较 / 上传 / 下载 / 写清单）+ 进度；可取消；取消后已完成部分保留（幂等）。

### 7.4 文案与国际化

- `ctx.locale.register(NS, { zh, en })`，键名用语义化 `sync.title` 这类（不用编号键，便于维护），支持 `{{var}}` 插值。
- 中英双语；语言跟随 `ctx.locale`，无需监听 `<html lang>`（由 locale 服务负责）。
- 危险操作（删除目标、恢复覆盖、清理投影缓存）统一二次确认 + 影响面数字。

---

## 8. 宿主 API

**首选通道**：`ctx.connection.rpc.handle('/dsh-sync', handler)`，客户端 `ctx.connection.rpc.call('/dsh-sync', endpoint, payload)`。该通道由 Connection 服务挂载 `/api` 桥，自带 Host/Origin 围栏与持久浏览器令牌，插件无需自建 CSRF 防护。

**兜底通道**：若目标 DSH 版本的 `connection` 服务不可用（第三方宿主侧先例缺失，需实测），退回 `ctx.webServer.register({kind: 'prefix', path: '/dsh-sync', handler})`，并自行实现 `127.0.0.1`/`::1` 的 `remoteAddress` 校验、`Host` 头 loopback 校验（防 DNS rebinding）、`sec-fetch-site: cross-site` 拒绝、`POST`-only、body 上限 1 MB、`cache-control: no-store`。

两条通道共用同一份路由表与信封：`{ ok: true, value }` / `{ ok: false, code, message }`。

| endpoint | 作用 | 入参要点 |
| --- | --- | --- |
| `status` | 插件版本、设备、目标状态、上次运行结果 | — |
| `settings.get` | 公开设置（密钥打码） | — |
| `settings.save` | 保存设置（scope、策略、定时、排除、映射） | settings 子集 |
| `scopes.estimate` | 各 scope 的预估（文件数、字节数、默认排除命中数） | `targetId?` |
| `targets.list` | 目标列表（打码） | — |
| `targets.upsert` | 新增/编辑目标 | `{ target, secret? }` |
| `targets.remove` | 删除目标 | `{ id }` |
| `targets.test` | 测试连接（写探针后删除） | `{ target, secret? }` |
| `preview` | 只读预览：每个 scope 的将上传/下载/删除/冲突清单 | `{ targetId, scopes, direction, strategy }` |
| `sync` | 执行同步 | `{ targetId, scopes, direction, strategy, resolutions? }` |
| `runs.get` | 长任务进度（v1 轮询；后续可换 `webServer.registerUpgrade` 的 SSE/WebSocket） | `{ id }` |
| `runs.cancel` | 取消 | `{ id }` |
| `snapshots.list` | 历史快照列表 | `{ targetId }` |
| `snapshots.preview` | 快照影响面 | `{ targetId, key }` |
| `restore` | 恢复（整快照/scope） | `{ targetId, key, scopes, pathMapping }` |
| `sessions.list` | 会话概览 + 选择状态 + 当前 device\|user 的映射/建议路径 | — |
| `sessions.compare` | 本机与最新备份按 sessionId 对比（size/mtime/sha256/append） | `{ targetId, sessionIds? }` |
| `sessions.backup.list` | 最新备份 manifest 中的会话列表 | `{ targetId }` |
| `sessions.sync` | 把选中会话写入备份 | `{ targetId, sessionIds, confirm }` |
| `sessions.restore` | 从最新备份恢复会话（先备份本机、原子写、改写 cwd） | `{ targetId, sessionIds, targetPath?, autoReplaceUserFolder?, confirm }` |
| `sessions.overwrite` | 用备份覆盖本机，或用本机覆盖备份 | `{ targetId, sessionIds, side: 'local'\|'backup', confirm }` |
| `sessions.relocate` / `sessions.relocateUser` / `sessions.dedupe` | 会话目录迁移与重复副本清理 | `{ dirName, newCwd, confirm }` 等 |
| `cache.clearProjections` | 清理 `session_projcache` | — |
| `security.unlock` | 输入加密口令（如启用） | `{ passphrase }` |
| `diagnostics.export` | 导出诊断日志（脱敏） | — |

约定：长任务（同步/恢复）立即返回 `runId`，前端轮询 `runs.get`；所有写操作必须幂等或带运行 id，避免前端重复提交造成二次写入。

---

## 9. 安全设计

### 9.1 信任边界

- 插件只服务本机 loopback；不监听对外端口。
- 首选走 `connection.rpc`（内建 Host/Origin 围栏 + 浏览器令牌）；兜底裸路由时自建同等级围栏（§8）。
- 不做「远端设备可主动推送」；同步由本机发起（远端数据永远是"数据"，不是"指令"）。
- 远端返回的所有路径、包名、YAML/JSON 结构都按不可信输入处理：先校验再落盘。

### 9.2 凭据

- 见 §6.6；密钥不进入日志、不进入 `settings.json`、不进入远端仓库。
- 参考实现把密钥按 provider 类型存（切换渠道会互相覆盖），本设计按 `targetId` 存，多目标不串味。

### 9.3 路径安全

- 所有远端路径先规范化；拒绝空段、`.`、`..`、控制字符、绝对路径、盘符、`\`。
- 恢复写入前校验 `isInside(targetRoot, resolvedRealPath)`，并拒绝符号链接指向目标外。
- profile 名白名单 `/^[A-Za-z0-9._-]+$/` 且非 `node_modules`。
- 备份目录名固定生成，不接受远端提供的路径。

### 9.4 排除规则（默认，不可被用户规则覆盖掉）

硬排除（任何 scope 都不能包含）：

```text
**/.credentials*
**/credentials.json
**/node_modules/**
**/.pnpm-store/**
**/dsh-runtimes/**
**/temp/**
**/cache/**
**/skin-center/**/.cache/**
**/*.install-*
**/.plugin-manager/logs/**
**/*.log
**/*.tmp
**/*.bak
**/*.bak-*
**/*.migrated.bak
**/session_projcache*
**/*.lock
```

软排除（可按 scope 覆盖）：`attachments/`（默认关）、`storages/`（默认关）、`~/.dsh/@wingsky-1/dsh-notifier/history.jsonl`（含正文，默认排除）、各插件历史/统计文件（`dsh-get-balance-series-store.json`、`dsh-usage/` 等，默认排除）。

用户规则：`$DSH_HOME/dsh-sync-hub/.dshsyncignore`（每行一个 glob，`#` 注释），示例见仓库根 `.dshsyncignore.example`。用户规则只在上面的硬排除之上追加，**不能取消硬排除**。

### 9.4.1 插件自身的排除

本插件自己的 `$DSH_HOME/dsh-sync-hub/**`（含 settings、secrets、state、backups）永不进入同步集；`plugin-settings` scope 扫描 `cordis.patch.yml` 时也会剥离本插件自身那一行（与参考实现一致）。

### 9.5 完整性

- 每个 blob 用 SHA-256 寻址与校验；下载后校验，不匹配即拒绝写入。
- 清单写入前后版本号单调递增；远端清单带 `updatedAt`，合并其他设备清单时取较新。
- 恢复前备份 + 原子写；失败保留备份路径。

### 9.6 可选加密

- AES-256-GCM + scrypt（16B salt / 12B iv），格式 `dsh-sync/encrypted/v1`，每个对象新 salt/iv。
- 加密只作用于 blob 与 manifest；口令派生密钥只存内存，重启需重新输入（与参考实现一致，但 UI 保留入口，不隐藏）。
- 加密开启时，远端不可读；代价是失去跨工具可读性与服务端去重（同一内容不同 salt 导致重复）。

### 9.7 供应链与自动执行

- **不自动执行**任何 `pnpm install` / `npm install`；只在恢复结果里给出建议命令。
- 远端 `package.json` 的 `onlyBuiltDependencies`/`allowBuilds` 不自动合并；若远端带有本地没有的 build 白名单，列出并要求用户显式确认。
- 不实现「从远端继承插件启用状态」的隐式行为；`cordis.patch.yml` 合并结果先展示 diff，再落盘。

### 9.8 脱敏（可选，默认关）

- 对会话文本类内容可按正则做 `sk-*`、`ghp_*`、`xox?-`、`-----BEGIN ... PRIVATE KEY-----`、`api[_-]?key\s*=` 替换。
- **默认关闭**，因为会改变数据内容（不可逆），只在 UI 明确勾选并二次确认后作用于本次同步；文档写明副作用。

---

## 10. 配置与存储

`settings.json` 结构（示意）：

```json
{
  "schema": "dsh-sync-hub/v1/settings",
  "deviceId": "f3c2...",
  "deviceName": "DESKTOP-01",
  "targets": [
    { "id": "t_nas", "name": "NAS", "kind": "local", "enabled": true,
      "path": "\\\\nas\\share\\dsh-sync" },
    { "id": "t_oss", "name": "阿里云 OSS", "kind": "s3", "enabled": false,
      "endpoint": "https://oss-cn-hangzhou.aliyuncs.com", "region": "cn-hangzhou",
      "bucket": "my-bucket", "prefix": "dsh-sync-v0.4.0", "accessKeyId": "<stored-locally>",
      "forcePathStyle": false, "providerHint": "oss" }
  ],
  "scopes": {
    "plugin-settings": { "enabled": true, "profiles": ["web"] },
    "plugin-files": { "enabled": true },
    "skills": { "enabled": true },
    "sessions": { "enabled": true, "mode": "selected",
                  "selectedSessionIds": ["session-3bf39cd1-..."] },
    "attachments": { "enabled": false },
    "agents-md": { "enabled": true },
    "storages": { "enabled": false }
  },
  "sessionPaths": {
    "DESKTOP-01|alice": { "session-3bf39cd1-...": "C:\\Users\\alice\\Documents\\demo" }
  },
  "autoReplaceUserFolder": false,
  "sessionPathMappings": {},
  "strategy": "smart",
  "direction": "both",
  "autoSync": { "enabled": false, "intervalMinutes": 60, "onStartup": false },
  "exclude": { "extra": [] },
  "encryption": { "enabled": false, "salt": "" },
  "historyLimit": 30,
  "logRetentionDays": 14
}
```

---

## 11. 跨机与路径映射

| 场景 | 处理 |
| --- | --- |
| 同名用户目录（`C:\Users\wangyi` ↔ `C:\Users\other`） | 所有本机路径都相对 `$DSH_HOME`/`$HOME` 表达，不写绝对路径 |
| 会话工作区路径不同 | 优先 `sessionPaths['device\|user'][sessionId]`；回退旧 `sessionPathMappings`；最后按「旧用户目录 → 当前用户目录」换算（§5.7） |
| 同一会话在多台电脑/多个目录出现 | 按 sessionId 归一为一个会话；恢复/迁移前先清理或备份重复副本（§5.7） |
| 换盘符/UNC | `plugin-files` 中的 `file:` 依赖在恢复后提示重装；不自动改写插件源码 |
| 时间不同步 | 以 SHA-256 为最终依据，mtime 只做快速判定，时钟漂移不会导致误判为相同 |
| 不同 DSH 版本 | 清单带 `schema`；不兼容时拒绝写入并提示升级插件 |

---

## 12. 测试策略

| 层级 | 内容 | 工具 |
| --- | --- | --- |
| 单元 | manifest diff、merge3、cordis.patch 按 id 合并、package.json 并集、排除规则、路径校验、SigV4 签名向量、WebDAV 路径编码 | `node:test`，纯函数 |
| 同内容语义 | 同内容不同 mtime → noop 且本地 mtime 不变；同内容跨路径 → 只上传一个 blob；目标已有同内容 → 跳过写入（写前比较）；`--force` 才覆盖；三条冲突策略都不改写相同内容 | `node:test` |
| 集成 | 本地 target 往返（写→读→校验字节）；假 WebDAV 服务器（`node:http`）覆盖 404/405/409/412；假 S3 服务器校验签名与 If-Match；断点与重试 | `node:test` + 内置 `http` |
| 数据完整性 | 会话文件字节级往返（大文件 12 MB、多帧样本）；恢复后 SHA-256 与源一致 | 夹具文件 |
| 端到端 | 同一台机器两个 profile（`web` + 临时 profile）经本地目录 target 互相同步；恢复后配置文件等值；重复同步时第二次结果全部为「相同（跳过）」 | 脚本 `test/e2e-local.mjs` |
| 手工 | 坚果云/Nextcloud WebDAV、阿里云 OSS/MinIO 真实环境；Windows 桌面版与 CLI 版；双设备冲突演练 | 发布前检查表 |

CI（可选）：GitHub Actions，`node --check`、`node --test`、`tsc --checkJs`；不含真实云端凭据。

---

## 13. 实现步骤

详细任务拆分、验收标准与排期见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。总体分为 8 个阶段：

| 阶段 | 内容 | 里程碑 |
| --- | --- | --- |
| P0 | 脚手架 + 空插件可加载（设置页出现空 tab） | — |
| P1 | 扫描 + manifest + 本地目录 target + 预览/同步（配置类 scope） | v0.1.0 可用 |
| P2 | 设置页第一版（目标 CRUD、勾选、预览、同步结果） | v0.1.0 |
| P3 | WebDAV 与 S3 兼容 target + 测试连接 + 并发 | v0.2.0 |
| P4 | 会话 scope（增量、大文件、keep-both、路径映射） | v0.2.0 |
| P5 | skills + plugin-files + plugin-settings 结构化合并 | v0.3.0 |
| P6 | agents-md merge3 + 历史快照/恢复 + 备份 | v0.3.0 |
| P7 | 定时同步 + 加密 + 脱敏 + 国际化 + 文档 + 双设备验收 | v1.0.0 |
| P8 | （可选）rclone target、blob GC、单文件恢复、CLI/Agent 工具 | v1.1+ |

---

## 14. 风险与未决决策

### 14.1 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| DSH 客户端插槽 API 非公开、版本间可能变化 | 设置页可能挂不上 | 运行时探测 `settings.plugins.tab` → `settings.section` 回退；锁定已测 DSH 版本；README 标注兼容范围 |
| `connection.rpc` 宿主侧第三方无先例（仅类型证据） | 首选通道不可用 | v0.1 先实现裸路由兜底并实测 RPC；两者共用路由表，可一键切换 |
| 客户端 bundle 构建约束（单文件、id = 包名、禁止跨插件值导入） | 页面加载失败/白屏 | 手写包装 + `node --check` 断言 `__ModuleLoader__.load` 与 id；不做 `@deepseek-ai/*` 值导入 |
| 会话格式升级（v3/v4/未知） | 恢复后无法读取 | 按不透明字节处理，不解析；恢复提示重启；测试覆盖多版本样本 |
| 首同步 300+ MB 受网络限制 | 体验差 | 分 scope 勾选、本地 target 秒级、上传进度与可取消；默认不同步附件 |
| 用户误操作覆盖配置 | 数据丢失 | 恢复前备份、预览确认、原子写、`cordis.patch.yml` 不整文件覆盖 |
| 冲突策略选错导致覆盖 | 数据丢失 | 默认 `smart` 而非 `local-first`；无法裁决一律 `needs-choice`；keep-both 用于会话 |
| 远端仓库被植入恶意 `cordis.patch.yml`/`package.json` | 供应链风险 | 恢复前 diff 展示；不自动 install；不继承 build 白名单 |
| patch 的 `config` 是整段替换 | 合并写回丢键 | 合并后校验每行键集与远端/本地并集一致；写前备份 |
| 明文密钥（非 Windows） | 泄露 | UI 明示；后续可接系统密钥库 |
| 绝对路径写入 `storages/` 等 | 换机后异常 | 默认关；文档说明；UI 标注 |

### 14.2 待确认决策（需用户拍板）

| 编号 | 问题 | 推荐 |
| --- | --- | --- |
| D1 | 项目/包名？ | `dsh-sync-hub`（如需 npm scope 再加 `@<scope>/`） |
| D2 | v1 目标类型范围 | 本地路径 + WebDAV + S3 兼容三件套；rclone 放 v0.3+；不做网盘原生 OAuth |
| D3 | 会话冲突默认策略 | `keep-both`（不丢任何一侧），可切 `newer` |
| D4 | 附件是否默认同步 | 默认不同步（体积 + 隐私），可一键开启 |
| D5 | 设置页入口 | `settings.plugins.tab`（设置 → 插件 → 数据同步），`settings.section` 作兜底；v0.2 再加 `plugins.item` 状态卡片 |
| D6 | 是否要 AES 加密 | 提供可选开关（默认关、每次启动输入口令） |
| D7 | 是否需要脱敏 | 提供开关（默认关，会改数据，仅建议临时使用） |
| D8 | 定时同步 | 默认关，可配 15–1440 分钟 |
| D9 | 是否要 Agent 工具/命令触发同步 | v1 不做，v1.1 视需要增加（避免给 Agent 开放写同步目标的权限） |
| D10 | 是否提供「强制覆盖」开关 | 提供，但默认关、需二次确认；仅用于修复损坏文件，常规同步走「同内容不覆盖 + 三方合并」 |

---

## 15. 附录

### 15.1 术语

| 术语 | 含义 |
| --- | --- |
| Scope | 一类可同步的数据（skills、sessions 等） |
| Target | 一个远端存储位置（本地目录、WebDAV、S3） |
| Manifest | 文件清单：路径 → size/mtimeMs/sha256/blob |
| Blob | 内容寻址的原始字节对象，同一 SHA-256 全库唯一 |
| Base | 上次成功同步后的合并清单，三方比较的基准 |
| Tombstone | 删除意图记录，用于把删除传播到其他设备 |
| 快进（fast-forward） | 只有一侧有改动时直接采用改动侧，不做合并 |
| 同内容跳过 | 目标已有相同 SHA-256 的内容时不写入、不传输、不改 mtime |
| needs-choice | 同步需要用户裁决的返回状态 |

### 15.2 参考资料

- 本机 DSH CLI：`@deepseek-ai/dsh@0.2.0-rc.2`（`dsh --help`、`dsh plugin --profile <name> add <pkg>`）
- 插件机制样例：`dsh-builtin-toggles@0.3.2`（`settings.plugins.tab`）、`@dickpy/dsh-cloud-sync@0.20.9`（`settings.section` + 22 个路由）
- DSH 插件开发机制：[docs/research/dsh-plugin-architecture.md](research/dsh-plugin-architecture.md)
- 本机数据盘点：[docs/research/data-inventory.md](research/data-inventory.md)
- 同类插件逆向：[docs/research/cloud-sync-analysis.md](research/cloud-sync-analysis.md)
