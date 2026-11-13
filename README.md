# dsh-sync-hub（项目代号）

DSH（DeepSeek Harness）插件：把 **skills、插件设置、插件文件、会话数据、全局 AGENTS.md** 同步到用户自己选择的位置 —— 本地路径、WebDAV（坚果云/Nextcloud/群晖）、S3 兼容对象存储（阿里云 OSS/腾讯 COS/MinIO/R2/B2 等）。

> 当前状态：**v0.1 可用（仅本地目录目标）**。已完成扫描/清单/同内容判定/本地备份/恢复/冲突保留双方/设置页 UI 骨架；WebDAV、S3、文本三方合并与历史恢复尚未实现。
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

- 同步项：`agents-md`、`plugin-settings`、`plugin-files`、`skills`、`sessions`（附件/统计默认关闭）。
- 本地目录目标（普通磁盘、UNC、映射盘、同步盘目录）。
- 内容寻址 blob + manifest；同内容不覆盖、不改 mtime；单侧变更快进；双侧冲突按 scope 策略（会话/技能保留双方，AGENTS.md/配置取较新）。
- 设置页：`settings.plugins.tab`（不可用时回退 `settings.section`），含同步项勾选、目标管理、预览、同步进度、快照列表。
- 同步速度与进度：同步页显示实时速度、已传/总字节与预计剩余时间；结果摘要显示平均速度与用时。
- 左侧栏底部进度：`sidebar.footer.action` 注册紧凑进度卡片（百分比、阶段、速度、流量），**非同步时完全不渲染**。
- 定时自动同步：高级选项里开关 + 间隔（15–1440 分钟），显示上次/下次时间；另有「立即执行一次」按钮便于验证。自动同步会作为 `auto-sync` 运行进入同一套进度（含左侧栏进度卡片）。
- 删除处理：默认「每次询问」——开始同步前检测到一侧文件被删除时弹确认，**确定=恢复/覆盖缺失文件，取消=跳过删除**；也可在高级选项固定为「恢复」「镜像删除」或「忽略删除」。强制覆盖始终按恢复处理。
- 自定义同步项：在「自定义」页添加任意目录或单个文件，**可命名**，启用后自动加入同步；可给每台电脑单独设置该目录/文件的路径（按电脑名映射）。
- 按电脑配置目标目录：目标表单里可填「当前电脑目录」，并为其它电脑预设各自的目录映射；同一份配置迁移到不同电脑后各用各的路径。
- 目录选择器：目标/自定义项路径旁提供「浏览…」，可直接逐级选择目录（宿主只读列目录接口）。
- 插件展示元数据：`package.json.icon`（`assets/icon.svg`）+ `locale/{en,zh,zh-cn}.json` 的 `meta.title` / `meta.description`，插件页显示为「数据同步 / Data Sync」并带图标。
- 宿主 API：`/dsh-sync/*`（仅 loopback），长任务通过 `runId` 轮询；`status` 附带 `activeRun` 与 `autoSync` 状态。

### 尚未实现

- WebDAV / S3 兼容目标、rclone。
- `cordis.patch.yml` 按 id 结构化合并、`package.json` 并集合并（当前按文件取较新）。
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

- 在 **设置 → 插件** 里新增「数据同步」设置页：按项勾选同步范围，管理多个同步目标（v0.1 已实现）。
- 目标类型：本地目录/UNC/映射网盘/同步盘目录（已实现）；WebDAV、S3 兼容对象存储、rclone（后续）。
- 增量同步：内容寻址 blob + manifest，只传变化的文件（已实现）。
- **git 式同步语义**：内容相同即同一个对象——不覆盖、不重传、不改 mtime；只有一侧变化时快进；两侧都变才合并/裁决（已实现二进制与按文件策略；文本 merge3 与配置结构化合并待实现）。
- 冲突处理：会话/插件文件默认保留双方（`.conflict-<设备>-<时间>`），AGENTS.md/配置取较新；不会静默覆盖。
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

## 技术要点

- 零运行时依赖，纯 ESM，无构建步骤（与同类插件一致的取舍）。
- 宿主半边：cordis 插件，注册 `connection.rpc`（优先）/ `webServer` 路由（兜底）。
- 浏览器半边：手写 `window.__ModuleLoader__.load` 单文件 bundle，React 组件，设置页通过 `settings.plugins.tab` 插槽注册。
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
