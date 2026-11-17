# dsh-sync-hub（项目代号）

DSH（DeepSeek Harness）插件：把 **skills、插件设置、插件文件、会话数据、全局 AGENTS.md** 同步到用户自己选择的位置 —— 本地路径、WebDAV（坚果云/Nextcloud/群晖）、S3 兼容对象存储（阿里云 OSS/腾讯 COS/MinIO/R2/B2 等）。

> 当前状态：**v0.4 可用**。已实现本地目录与 OSS/S3 兼容对象存储目标、会话/插件同步与跨设备浏览、设置页 UI；WebDAV、文本三方合并与部分历史功能仍在计划中。
> 包名 `dsh-sync-hub` 为项目代号，最终名称待确认。

## 快速验证（无需安装进 DSH）

```powershell
# 1) 单元与集成测试（13 个用例）
npm test

# 2) 在当前目录建测试夹具与备份目录，验证：备份 → 完全相同不覆盖 → 恢复到新目录
node scripts/local-backup-test.mjs

# 3) 备份本机真实 DSH 配置与 skills 到 test-backups（只读真实目录，不写入）
node scripts/real-backup-test.mjs
```

`test-backups/` 已加入 `.gitignore`；真实备份只包含全局 AGENTS.md、profile 配置、本地插件文件与 skills，不包含 `~/.dsh/.credentials.yaml`、`node_modules`、缓存与日志。

### 已实现

- 同步项：`agents-md`、`plugin-settings`、`plugin-files`、`plugins`、`skills`、`memes`、`skins`、`pets`、`sessions`（附件/统计默认关闭）。
- 个性化资源：`memes`（`meme-packs` + `dsh-expression.json`）、`skins`（`skins`、`skin-center` + `skin-center-active.json`）、`pets`（`pets` + `pet.json`）默认开启、冲突保留双方；宠物安装残留 `*.install-*` 与 `skin-center` 缓存不参与同步。
- 本地目录目标（普通磁盘、UNC、映射盘、同步盘目录）；目标可为磁盘根目录，仓库始终落在 `<目标>/dsh-sync-v<插件版本>/` 前缀下。设置页「同步」标签首卡内的「备份信息」会显示当前 DSH 版本与备份时记录的 DSH 版本，每次同步时更新；「打开备份目录」按钮会在系统文件管理器中打开当前目标的仓库根目录。
- OSS / S3 兼容目标：填写 Endpoint、Region、Bucket、AccessKey ID/Secret（Secret 只保存在本机 `secrets.json`），支持阿里云 OSS 等 S3 兼容服务；对象布局与本地目录一致（前缀下 `meta.json`、`manifests/`、`blobs/`），请求使用 Signature V4。Bucket 探测、读写、列举与删除均通过 HTTPS 完成。
- 内容寻址 blob + manifest；同内容不覆盖、不改 mtime；单侧变更快进；双侧冲突按 scope 策略（会话/技能保留双方，AGENTS.md 取较新，插件设置类文件冲突时**本机优先**并上传本机版本，避免旧备份把插件开关还原）。
- 设置页：优先注册为设置弹窗**左侧导航的一级「数据同步」页**（`settings.section`）；仅当宿主没有该插槽时回退到「插件 → 内置插件」里的 tab（`settings.plugins.tab`）。页面标签顺序为 **同步、同步项、高级、自定义、会话、插件、目标、历史**；「会话」「插件」标签会随对应同步项开关自动隐藏。「同步」页常驻变更预览并自动加载，策略类配置集中在「高级」。
- 同步速度与进度：同步页显示实时速度、已传/总字节与预计剩余时间；结果摘要显示平均速度与用时。
- 预览常驻：进入「同步」标签页即自动加载当前目标/方向/同步项的变更预览，切换目标、方向或同步项后自动刷新；任务结束后也会刷新。手动按钮为「刷新预览」。预览中「待决定（删除）」分组标题右侧直接提供「确定」（恢复/覆盖缺失文件）与「删除」（镜像删除，需二次点击确认），点击即按该策略启动本次同步。
- 左侧栏底部：左右结构——左侧为信息与进度条（上下排列），右侧为操作按钮。空闲时显示**待上传 / 待下载文件数**，没有变更时显示「已同步」，按钮图标变为**刷新**（点击重新统计待同步数量）；悬停左侧文字会显示变更明细：最多 5 条 `[会话] 名称` / `[插件] 名称` / `[技能] 名称`，末尾一行「待同步：插件 1、会话 1，共 6 个文件」按插件/会话数量与文件总数汇总。存在删除差异时右侧按钮换成醒目的「去确认」，点击后打开数据同步设置页（优先右侧栏的「数据同步」页面，其次设置弹窗）由用户确认。同步中左侧变成 `已完成/总数 文件`，右侧显示百分比。自动统计间隔与显示模式在**「高级」标签页**设置（默认 10 分钟；显示模式：只在同步时显示 / 一直显示 / 隐藏）。有删除决策时整行改为冲突信息与按钮。
- 左侧栏快捷同步：空闲按钮按当前设置（第一个启用目标、当前方向、已启用同步项）直接发起同步；若删除处理为「每次询问」，会先转成待决策卡片，不会盲目覆盖。
- 右侧栏工具：注册 `dsh-sync-hub` 页类型并贡献引导页入口「数据同步」，正文复用同一个设置页；在右侧栏的添加/引导页中打开后即可在侧栏内完成全部同步配置。
- 定时自动同步：**「高级」标签页**里开关 + 间隔（15–1440 分钟），显示上次/下次时间；另有「立即执行一次」按钮便于验证。自动同步会作为 `auto-sync` 运行进入同一套进度（含左侧栏进度卡片）。
- 删除处理：默认「每次询问」——检测到一侧文件被删除时，**设置页与左侧栏都会显示「需要决定」面板**（恢复缺失文件 / 跳过删除 / 取消）；决策期间左侧栏隐藏进度条、显示冲突信息与按钮。也可在高级选项固定为「恢复」「镜像删除」或「忽略删除」；强制覆盖始终按恢复处理。
- 自定义同步项：在「自定义」页添加任意目录或单个文件，**可命名**，启用后自动加入同步；可给每台电脑单独设置该目录/文件的路径（按电脑名映射）。
- 会话同步范围：`scopes.sessions.mode = 'all' | 'selected'` + `selectedSessionIds`。`all` 保持原有全量行为；`selected` 只同步勾选的 session 目录（manifest 仍为 `sessions/<projectDir>/<sessionId>/...`，保留项目目录结构）。「会话」页可逐会话勾选、全选（当前列表）/反选/清空，并对每个项目分组提供「全选本组」；会话列表支持**筛选**（会话名称 / sessionID / 目录路径，以及同步状态：全部 / 已同步 / 未同步）和**目录排序**（最近活动 / 目录名称 / 会话数量 / 同步状态，可切换升序/降序）。同步状态取自当前同步目标最新 manifest：该 sessionId 在目标端存在即视为「已同步」，与是否最新无关。显示已选数量、未勾选数量，并提示「已选但本机不存在」的会话；新会话默认不自动加入。
- 插件同步范围：`scopes.plugins.selectedPlugins` 记录勾选的插件包，`settingsPlugins` 记录其「同步配置」开关；勾选插件会同时勾选该插件的同步配置，另有「同步配置已选」批量勾选按钮，勾选任一配置会确保「插件设置」同步项开启。插件页列出当前 profile 的插件及其启用状态、当前版本、备份版本、占用大小，支持搜索、仅看已选、全选当前与清空选择；存在多个 profile 时可在页头切换并记住选择。页面底部的「自带插件状态」只读展示：4 个内置能力配置（子智能体、网页搜索与获取、Agent 循环、终端）与已启用的实验性插件（来自 profile `dsh.profile.bundles`），不提供单独勾选，其状态随「插件」同步项一起同步。备份内容是所选插件在 `profiles/<profile>/node_modules/<name>/` 下的安装包，manifest 路径为 `plugins/<profile>/packages/<name>/...`；插件配置本身仍由「插件设置」同步项随 profile 配置文件同步。
- 跨设备备份浏览：会话页与插件页底部按设备列出备份内容。「其它电脑」的会话/插件分为「未同步」与「已同步」：未同步条目没有勾选框，只提供「下载」/「安装」按钮；成功后重新读取备份并移动到「已同步」，显示勾选框并隐藏按钮。插件安装会复制包文件到本机 profile 的 node_modules，并补依赖/bundle，运行中的 DSH 需重启后加载。
- 插件启用与配置同步：`plugins` 同步项开启时，备份 `plugin-states/<profile>.json`（`dsh.profile.bundles` 列表 + `cordis.patch.yml` 的**完整顶层配置行**及 `disabled` 覆盖），push 上传、pull 应用、both 按更新时间取较新；覆盖自带的子智能体、网页搜索/获取等能力配置、DSH 自带实验 bundle 与内置插件开关，以及第三方插件的启动状态与配置。恢复 bundle 列表时只保留本机已安装的包，未安装的 bundle 不会被写入；配置行按 id 合并（远端行覆盖同 id 本地行，本地独有行保留）。
- 会话选择行布局：左侧两行（第一行会话名称、第二行 sessionID），右侧两行（第一行占用空间，置顶的会话在空间后显示订书钉图标；第二行最新交互时间）。名称与置顶来自 DSH 客户端 `sessions` / `workspaces` 服务（每 3 秒刷新），大小与时间兜底取会话日志文件信息；服务不可用时降级为「未命名会话 / 未置顶」。同一项目分组内的会话按**置顶优先、再按最新更新时间降序**排列（置顶组内也是最近活动在前；优先客户端 `updatedAt`，缺失时用日志 mtime/createdAt）。
- 按电脑 + 用户保存会话路径：`sessionPaths: { '<deviceName>|<osUserName>': { '<sessionId>': '<绝对路径>' } }`（宿主 `status` 返回 `deviceName` / `osUser` / `sessionPathKey`）。旧版 session-first 结构会在读取时自动转换。该映射不再在「会话」页单独编辑，而是**从备份恢复到本地时弹出目录选择框**：确认目录后执行恢复并写入映射；迁移会话目录成功时也会写入。解析顺序为设备/用户+sessionId → 旧 `sessionPathMappings` → 「旧用户目录 → 当前用户目录」换算。
- 同一 sessionId 视为一个会话：对比与覆盖属于**同步流程**的功能（按 sessionId 合并副本，对比大小、mtime、SHA-256 与是否追加；覆盖需二次点击并先备份被覆盖侧）。这些能力保留在宿主 `sessions.compare` / `sessions.sync` / `sessions.overwrite` 接口中，**不在「会话」页展示**。普通同步计划也会按 sessionId 合并副本：追加日志可快进，分叉保持 keep-both；`.dedupe-backup-*` 隔离目录不参与同步。
- 从备份恢复：同样属于**同步流程**功能（读取目标端最新 manifest、列出备份会话、选择目标路径、`autoReplaceUserFolder` 等），宿主接口 `sessions.backup.list` / `sessions.restore` 保留；**不在「会话」页展示**。恢复前把本机同名会话（含重复副本）移动到本机备份目录，原子写并改写会话头 cwd，完成后提示重启 DSH / 清理投影缓存。
- 会话目录（「会话」标签）：同步会话选择列表按 `$DSH_HOME/sessions` 下的工作区分组，目录不存在时标红点。**目录迁移合并到选择列表**：仅当该会话目录在本机**不存在**时，项目分组右侧才显示「选择目录…」与「迁移到该目录」；目录已存在的分组不显示这两个按钮，也不占额外提示空间。页面保留「清理重复副本」（移到 `sessions/.dedupe-backup-<时间戳>`，不删主副本）。「同一会话对比」和「从备份恢复」属于同步流程，已不在会话页展示。对应宿主接口 `sessions.list` / `sessions.compare` / `sessions.backup.list` / `sessions.sync` / `sessions.restore` / `sessions.overwrite` / `sessions.relocate` / `sessions.relocateUser` / `sessions.dedupe`。
- 按电脑配置目标目录：目标表单里可填「当前电脑目录」，并为其它电脑预设各自的目录映射；同一份配置迁移到不同电脑后各用各的路径。
- 变更预览：动作按类型分组；顶部统计项（待上传/待下载/冲突/待决定/删除/跳过/相同）是筛选按钮，点击后只在下方显示对应类型的条目，再次点击恢复全部；`identical` 只计入顶部汇总、不再作为分组条目，避免大量相同文件把待上传/下载项挤出上限；会话类条目显示为 **`<工作区名称>-<会话名称>`**（工作区取会话 cwd 的最后一段，会话名取 DSH 标题；缺失时回退为工程目录名/sessionID 缩写），下方保留完整相对路径，便于对照会话同步项。
- 目录选择器：目标/自定义项/会话路径旁提供「浏览…」，可直接逐级选择目录（宿主只读列目录接口）。窗口使用不透明深色遮罩与实心面板、更高层级，点击遮罩不会误关闭；支持手动输入路径、上一级/主目录/刷新、单击进入与双击直接选择，Esc 或「取消」关闭。
- 插件展示元数据：`package.json.icon`（`assets/icon.svg`）+ `locale/{en,zh,zh-cn}.json` 的 `meta.title` / `meta.description`，插件页显示为「数据同步 / Data Sync」并带图标。
- 宿主 API：`/dsh-sync/*`（仅 loopback），长任务通过 `runId` 轮询；`status` 附带 `activeRun` 与 `autoSync` 状态。

### 尚未实现

- WebDAV / S3 兼容目标、rclone。
- 按 sessionId 的追加判断会读取备份日志内容（本地目录目标无网络开销；WebDAV/S3 目标落地后再改为流式/范围读取）。
- `cordis.patch.yml` / `package.json` 的结构化合并（按 id / 并集，当前冲突时本机优先，结构化合并仍在计划中）。
- AGENTS.md 三方合并（merge3）、历史快照恢复、加密。

## 解决什么问题

DSH 的用户资产分散在多处，换机、重装、多台设备之间没有统一的迁移手段：

- 全局 skills 在 `~/.agents/skills/`；
- 插件设置在 profile 的 `cordis.patch.yml` 与插件自有 json 里；
- 插件文件在 `$DSH_HOME/plugins/`、`.agent-presets/`；
- 会话数据在 `$DSH_HOME/sessions/`（本机约 313 MB）；
- 全局 AGENTS.md 在 `$DSH_HOME/AGENTS.md`。

已有同类插件（`@dickpy/dsh-cloud-sync`）只同步每个 profile 的 6 个配置文件与本地插件源码，不覆盖 skills、插件自有配置、会话数据与全局 AGENTS.md。

## 能力与路线

- 在 **设置 → 数据同步**（左侧导航一级页；旧宿主回退为 设置 → 插件 的 tab）里按项勾选同步范围，管理多个同步目标（v0.1 已实现）。
- 目标类型：本地目录/UNC/映射网盘/同步盘目录、OSS/S3 兼容对象存储（已实现）；WebDAV、rclone（后续）。
- 增量同步：内容寻址 blob + manifest，只传变化的文件（已实现）。
- **git 式同步语义**：内容相同即同一个对象——不覆盖、不重传、不改 mtime；只有一侧变化时快进；两侧都变才合并/裁决（已实现二进制与按文件策略；文本 merge3 与配置结构化合并待实现）。
- 冲突处理：会话/插件文件默认保留双方（`.conflict-<设备>-<时间>`），AGENTS.md 取较新，插件设置类文件（package.json / cordis.patch.yml）冲突时本机优先；不会用旧备份静默覆盖本机插件开关。
- 历史快照：每次有实际变更时写入（列表已实现，回滚待实现）。
- 安全默认值：不传凭据、不传 `node_modules`/缓存/日志；宿主 API 仅本机可访问。

## 文档

- [设计方案](docs/DESIGN.md)：架构、数据模型、同步引擎、冲突策略、设置页 UI、API、安全、风险与待定决策。
- [实现步骤](docs/IMPLEMENTATION.md)：阶段拆分、任务清单、验收标准、里程碑与发布清单。
- 调研报告：
  - [DSH 插件开发机制](docs/research/dsh-plugin-architecture.md)
  - [本机可同步数据盘点](docs/research/data-inventory.md)
  - [同类插件逆向分析](docs/research/cloud-sync-analysis.md)

## 安装到 DSH（web / 桌面版）

插件对 profile 无硬编码，web 版（`dsh web`）与桌面版（Electron，`desktop` profile）共用同一份实现。
因 `dsh plugin add` 会走 pnpm 重新解析依赖（需要网络/git），推荐用仓库自带的无网络安装脚本：

```powershell
# 安装到 web profile（dsh web）
node scripts/install-plugin.mjs --profile web

# 安装到桌面版 profile（Electron 使用 desktop）
node scripts/install-plugin.mjs --profile desktop

# 卸载任一 profile
node scripts/install-plugin.mjs --profile web --uninstall
```

脚本会备份 `package.json`/`cordis.patch.yml`，然后建立 `node_modules/dsh-sync-hub` 链接并登记依赖与 `dsh.profile.bundles`；不会联网、不会改动 `pnpm-lock.yaml`。**安装/卸载后都要完全退出并重启对应的 DSH**（桌面版从托盘退出；web 版重启 `dsh web` 进程），然后在 **设置 → 插件 → 数据同步** 中配置。

- 桌面版：已在此机器安装并验证设置页、同步、侧栏进度与定时同步。
- web 版：已安装到 `web` profile，并通过 `dsh --profile web --dump-config`（组合出插件行）与模块导入（导出 `apply`、注册 `/dsh-sync` 路由）验证；浏览器端使用与桌面版相同的前端插槽，首次在浏览器中打开时建议确认「数据同步」tab 与侧栏进度。

## 智能体接口（Agent tools）

让智能体自己管理「自定义同步项」（任意目录或单个文件），不需要手工改 `settings.json`，也不用打开设置页逐项填表。工具随宿主插件注册：只要当前 DSH（web 或桌面版）会给智能体会话暴露 `tools` 服务，智能体就能看到并调用这四个工具；注册失败时不影响插件其它功能。

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `dsh_sync_custom_item_list` | 列出自定义同步项 | — |
| `dsh_sync_custom_item_add` | 新增目录/文件同步项 | `name`、`type`: `dir`/`file`、`path`（当前电脑绝对路径，必须存在）、`enabled?`、`devicePaths?` |
| `dsh_sync_custom_item_update` | 改名/改类型/改路径/启停 | `idOrName`，其余字段可选 |
| `dsh_sync_custom_item_remove` | 删除自定义项（只删配置） | `idOrName` |

### 一次完整的使用流程

1. 在会话里直接对智能体说需求，例如：「把 `D:\projects\demo` 加入同步，名字叫项目源码」。
2. 智能体调用 `dsh_sync_custom_item_add`，工具校验路径后写入 `settings.customItems`，并返回新的自定义项列表。
3. 打开 **设置 → 插件 → 数据同步 → 自定义**（或右栏「数据同步」页）即可看到这一项，可继续在 UI 里调整路径、启停或删除。
4. 到「同步」页点「刷新预览 → 开始同步」才会真正传输；工具只改同步配置，**不会自动启动同步**。

### 参数与校验规则

- `path` 必须是当前电脑上的绝对路径（支持 UNC，如 `\\nas\share\x`），且必须已存在；目录/文件类型要与 `type` 一致。不存在或类型不符会被拒绝，避免写入无效配置。
- 其它电脑的路径用 `devicePaths: [{ device: "PC-B", path: "E:\\backup" }]` 传入，按「设备名 → 目录」映射；当前电脑仍使用主 `path`。设备名就是设置页里显示的电脑名。
- `name` 不区分大小写且在同一插件内唯一；新增重名会报错（改名字用 update）。
- `enabled: false` 可先建但停用；后续可在 UI 或 update 里启用。
- 删除只移除同步配置，**不会删除本地文件或已经备份的数据**；建议在调用前向用户确认。

### 工具会做的事 / 不会做的事

- 会：新增、列出、修改、删除自定义目录/文件同步项；变更立即写入设置，UI 同步可见。
- 不会：不会触发一次同步、不会修改内置同步项（skills/会话等）、不会删除本地或备份文件、不会修改其它电脑上的实际路径（只记录映射）。

### 常见报错

| 报错 | 含义 | 处理 |
| --- | --- | --- |
| `路径不存在: …` | `path` 在本机不存在 | 确认路径拼写，或先用 `fs.statPath` 类工具/资源管理器确认 |
| `不是目录/不是文件` | `type` 与实际类型不符 | `dir` 用于文件夹，`file` 用于单个文件 |
| `已存在同名自定义同步项` | 新增时名称重复 | 换名字，或用 update 修改已有项 |
| `找不到自定义同步项` | update/remove 的 `idOrName` 不匹配 | 先用 list 查看准确的 id 与名字 |

### 自然语言示例

- 「把 `D:\projects\demo` 加入同步，名字叫项目源码」→ `dsh_sync_custom_item_add`
- 「列出当前自定义同步项」→ `dsh_sync_custom_item_list`
- 「把项目源码改名为 demo，并停用」→ `dsh_sync_custom_item_update`
- 「为项目源码在 PC-B 上使用 `E:\backup\demo`」→ `dsh_sync_custom_item_update`（`devicePaths`）
- 「移除备注文件这个同步项」→ `dsh_sync_custom_item_remove`

> 提示：如果智能体表示找不到这些工具，确认插件已安装、DSH 已完全重启，且当前版本 ≥ 0.2.1；也可以用「自定义」页手工完成同样操作。

## 技术要点

- 宿主注入：`webServer` 必须写在 `cordis.patch.yml` 的行选项 `inject: [webServer]` 上；dsh 0.2.2+ 的 loader 不再读取插件模块里的 `export const inject`（模块级导出只对直接 `ctx.plugin()` 生效）。
- 零运行时依赖，纯 ESM，无构建步骤（与同类插件一致的取舍）。
- 宿主半边：cordis 插件，注册 `connection.rpc`（优先）/ `webServer` 路由（兜底）。
- 浏览器半边：手写 `window.__ModuleLoader__.load` 单文件 bundle，React 组件，设置页优先通过 `settings.section` 插槽注册为左侧导航一级页（缺失时回退 `settings.plugins.tab`）。
- 跨运行形态：所有路径都相对 `$DSH_HOME` / `$AGENTS_HOME` 或用户配置的绝对路径；不依赖运行中的 profile 名称、窗口尺寸或 Electron API，因此 web 与桌面版共用同一份代码。
- Node >= 22.19（使用内置 `zlib` 的 zstd 能力仅用于测试样本，不解析会话内容）。

## 目录

```text
lib/            插件实现（host / client / core）
test/           node:test 单元与集成测试
scripts/        本地备份/真实数据备份测试脚本
docs/           设计与实现文档、调研报告
test-backups/   测试产生的备份仓库（gitignored）
```

## 许可

待定（建议 MIT）。第三方依赖审查、发布与 tag 流程见 [实现步骤 §6](docs/IMPLEMENTATION.md)。
