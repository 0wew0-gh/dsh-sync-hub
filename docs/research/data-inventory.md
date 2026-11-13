# DSH 可同步数据盘点（data inventory）

- 调研时间：2026-11-13
- 调研方式：只读扫描（PowerShell `Get-ChildItem` / `Select-String`、Node `zlib.zstdDecompressSync` 解压抽样）；未修改、未移动、未删除任何被调研文件
- 环境：DSH 桌面版 `0.2.1-rc.5`（runtime node 24.21.0 / pnpm 11.28.5）；内核包版本 `@deepseek-ai/dsh@0.2.0-rc.2`
- 范围：`C:\Users\wangyi\.dsh\`（`$DSH_HOME`）与 `C:\Users\wangyi\.agents\`（`$DSH_AGENTS_HOME`）

## 0. 结论速览

| 结论 | 内容 |
| --- | --- |
| 总量 | `~/.dsh` = 68,099 文件 / **2.86 GB**；`~/.agents` = 614 文件 / **25.1 MB** |
| 真正需要同步的「配置」极小 | 根目录散落配置 0.15 MB + 四个 profile 的配置（不含 `node_modules`）约 0.07 MB，合计 **< 0.25 MB** |
| 体积主体是会话 | `sessions/` 312.91 MB（270 个 zstd 文件），解压后 **1,033.73 MB**；附件 `attachments/` 100.64 MB |
| 最大噪声 | `node_modules` 1,704 MB、`.pnpm-store` 451 MB、`dsh-runtimes` 257 MB、`temp` 56 MB —— 必须排除 |
| 会话格式 | 追加式 **zstd 帧序列**（每帧内是一段 JSONL），不是单个 zstd 流；解密需逐帧解压（共 429,869 帧） |
| 插件设置真实位置 | ① `profiles/<name>/package.json`（依赖 + `dsh.profile.bundles`）② `profiles/<name>/cordis.patch.yml`（按 entry id 的 config 覆盖，Settings UI 也写这里）③ 插件自有文件（`$DSH_HOME` 根 json、`storages/`、`@scope/pkg/`、插件同名目录） |
| 必须排除 | `.credentials.yaml`、`dsh-cloud-sync/credentials.json`、所有 `node_modules`、`.pnpm-store`、`dsh-runtimes`、`temp/`、`cache/`、`skin-center/**/.cache`、`.plugin-manager/logs`、`*.log`、`*.bak/.tmp` |

## 1. `$DSH_HOME` 根目录（散落配置文件）

路径前缀 `C:\Users\wangyi\.dsh\`。共 21 个文件，合计 161,379 B（0.15 MB）。

| 文件 | 大小 (B) | 用途 | 变更频率 | 同步判定 |
| --- | ---: | --- | --- | --- |
| `settings.yaml.imported` | 5,674 | 旧版「全局设置」快照。0.2.x 起设置持久化到各 profile 的 `cordis.patch.yml`，本文件是启动时一次性导入后的改名存档；内含 `agent-default-model`、`ui-theme`、`llm-pi-ai`（各家 `apiKeyEnv` 变量名，无密钥值）、`dsh-notifier`、`dsh-startup-command` 等命名空间 | 常量（不再写） | 参考价值，可选同步 |
| `AGENTS.md` | 11,966 | **用户全局指令文件**（`$DSH_HOME/AGENTS.md`），每次首请求注入 | 手动编辑 | 必须同步 |
| `AGENTS.md.bak` | 11,635 | 上一版备份 | 常量 | 建议排除 |
| `pet.json` | 538 | 宠物插件状态：`petId`、好感度 `affinity`（points/lastPetAt/turns…）、`treats`、`display` 尺寸位置 | **每回合更新**（turns 计数） | 适合同步（高频小文件，需写合并策略） |
| `dsh-ssh.json` | 2,189 | dsh-ssh 插件主机清单：alias/host/port/user、`auth.kind=key` + `keyPath`、`proxyJump`、tags、描述 | 手动 | 适合同步，**含内网 IP/用户名/私钥路径 → 敏感** |
| `skin-center-active.json` | 249 | 皮肤中心激活状态与背景视觉参数（opacity/blur） | 手动 | 适合同步 |
| `dsh-web-settings-legacy-import.json` | 568 | legacy 设置迁移台账：记录 `task-board`、`remote-web-ui` 两段旧设置迁到了哪个 `entryId` 的哪些字段、`importedAt` | 常量 | 适合同步（幂等标记，避免重复迁移） |
| `dsh-get-balance-series-store.json` | 1,078 | dsh-get-balance 的按日用量序列（provider/model/workspace/token 计数） | 每次模型请求后 | 建议排除（可由会话重建，且含工作区绝对路径） |
| `dsh-notifier-history.jsonl.migrated.bak` | 52,739 | notifier 历史迁移前备份 | 常量 | 排除 |
| `dsh-notifier-history.jsonl.16192.mthzr5rs.tmp` | 70,976 | 写入中断残留的临时文件 | 常量 | 排除 |
| `dsh-notifier-history.jsonl.20036.mt2q1g1r.tmp` | 326 | 同上 | 常量 | 排除 |
| `dsh-notifier.json.migrated.bak` | 477 | notifier 配置迁移备份 | 常量 | 排除 |
| `dsh-notifier-status.json.migrated.bak` | 95 | notifier 状态迁移备份 | 常量 | 排除 |
| `.credentials.yaml` | 273（11 行） | **凭据存储**（dsh-credentials-local 后端的加密/明文凭据文件）。本次调研**未读取内容**，仅记录存在、大小、mtime（2026-10-12） | 登录/更新 key 时 | **必须排除** |
| `.anonymous-user-id` | 37 | 匿名统计用 UUID | 常量 | 可选（跨机应换新） |
| `.probe-enable-gb.yml` | 66 | 临时 loader patch 探针（启用 dsh-get-balance） | 一次性 | 排除 |
| `dsh-probe-3113.log` | 762 | 端口探针日志 | 一次性 | 排除 |
| `diag-ui-snapshot.txt` | 1,731 | UI 诊断快照 | 一次性 | 排除 |

> 关键点：**`$DSH_HOME/settings.yaml` 已不存在**（只剩 `.imported`）。任何「只同步 settings.yaml」的方案都会漏掉全部真实设置。

## 2. `profiles/` 结构与插件设置的真实存储位置

### 2.1 四个 profile 的体积

路径前缀 `C:\Users\wangyi\.dsh\profiles\`。

| Profile | 总文件 | 总体积 | `node_modules` 文件 | `node_modules` 体积 | 非 node_modules 文件 | 非 node_modules 体积 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `web` | 15,287 | 797.79 MB | 15,266 | 797.69 MB | 21（9 配置 + 12 日志） | 0.10 MB |
| `desktop` | 16,096 | 830.64 MB | 16,088 | 830.53 MB | 8（全为配置/备份） | 0.11 MB |
| `cc-tui` | 5,206 | 22.67 MB | 5,198 | 22.62 MB | 8（7 配置 + 1 日志） | 0.05 MB |
| `dsh-tui` | 7,194 | 53.30 MB | 7,186 | 53.26 MB | 8（7 配置 + 1 日志） | 0.04 MB |
| 合计 | 43,783 | 1,704.40 MB | 43,738 | 1,704.10 MB | 45 | ~0.30 MB |

- `profiles/node_modules`（profiles 根下）里只有指向 pnpm 内容寻址存储的**符号链接**（`la---`），本身不占体积。
- 各 profile 内的 `node_modules` 是 `nodeLinker: hoisted` 的真实文件，`web` 里除 `@deepseek-ai/*` 核心外还有 11 个第三方插件包（`dsh-ops`、`dsh-pilot`、`dsh-cost-meter`、`dsh-skill-fuzzy`、`dsh-blender`、`dsh-logicprobe`、`dsh-housekeeper`、`dsh-get-balance`、`dsh-open-in-vscode`、`dsh-session-delete`、`dsh-builtin-toggles`）+ `@linxin666/dsh-web-all` 等。

### 2.2 每个 profile 的文件清单

| 文件 | web | desktop | cc-tui | dsh-tui | 说明 |
| --- | ---: | ---: | ---: | ---: | --- |
| `package.json` | 2,066 | 2,070 | 226 | 265 | **依赖清单 + `dsh.profile.bundles`（bundle 注册顺序决定插件启用）** |
| `cordis.patch.yml` | 4,046 | 4,049 | 217 | 217 | **本 profile 的 patch 层：按 entry id 覆盖 config / disabled** |
| `cordis.yml` | 223 | 48,109 | 223 | 223 | loader 根，正常是空数组 `[]`（注释说明「编辑 cordis.patch.yml，不要改这里」）；desktop 那份是 **230 个 entry 的生成快照**（有一次 dump 落了盘），可重建 |
| `pnpm-workspace.yaml` | 226 | 226 | 61 | 61 | `packages: [.]`、`nodeLinker: hoisted`、`allowBuilds`（cloudflared / cpu-features / node-pty / ssh2） |
| `.npmrc` | 59 | 无 | 55 | 63 | 仅 `store-dir=…pnpm\store\v10`，**无 registry token** |
| `pnpm-lock.yaml` | 34,590 | 47,583 | 44,622 | 37,647 | 锁文件，随插件增删变 |
| `pnpm.cmd` | 38 | 无 | 38 | 38 | `call "D:\npm\pnpm.cmd" %*`（本机 pnpm 路径） |
| `compatibility.json` | 112 | 无 | 无 | 无 | peer 豁免表（`@wingsky-1/dsh-notifier@0.2.7`、`dsh-logicprobe@0.7.0` → `0.2.0-rc.1`） |
| 备份文件 | `cordis.patch.yml.bak-plugin-manager` | `cordis.patch.yml.bak-1793240075174`、`.bak-restore-20261029_102720`、`package.json.bak-restore-…` | — | — | 排除 |

`web` 另有空目录 `plugins/`（本地源码型插件的历史挂载点，现为空）；`web`/`cc-tui`/`dsh-tui` 有 `.plugin-manager/logs/operation-*/pnpm.log`（共 14 个，约 70 KB，**日志，排除**）。

### 2.3 「插件设置」到底存在哪里（结论）

DSH 0.2.x 里插件设置分散在三个层次，同步插件必须三层都覆盖：

| 层次 | 位置 | 内容 | 例 |
| --- | --- | --- | --- |
| ① 装了什么、按什么顺序挂载 | `profiles/<p>/package.json` → `dependencies` + `dsh.profile.bundles` | 包版本（含 github commit pin）、bundle 数组顺序 | `"@linxin666/dsh-web-all": "0.4.4"`；bundles 里 `@deepseek-ai/dsh-base` 打头、`dsh-ops` 收尾（20 项） |
| ② 每个插件的 config / 禁用状态 | `profiles/<p>/cordis.patch.yml` | 顶层 YAML 数组，每项 `{id, name, config?, disabled?}`；`!!js` 表达式允许 | 见下方脱敏例 |
| ③ 插件自有运行态数据 | 见 2.4 | JSON / JSONL / 目录 | `pet.json`、`storages/cost-meter/ledger.json` |

> 依据：`dsh-settings` 与 `dsh-plugin-manager` 的实现中，设置写入目标就是 profile 目录下的 `cordis.patch.yml`；`settings.yaml` 只作为一次性导入源（导入后改名 `settings.yaml.imported`）。`cordis.yml` 是 loader 合成结果，不应手动编辑。

#### 真实例子（脱敏，值均为可公开的 UI 偏好）

`profiles/web/cordis.patch.yml`（节选）：

```yaml
- id: web-runtime
  config:
    openBrowser: true
    printUrl: true
    surfaceContext: true
    trustedHosts: !!js ctx.webStartup.trustedHosts

- id: web-ui-remote-web-ui
  name: "@linxin666/dsh-web-all/remote-web-ui"
  config:
    plugin: "@linxin666/dsh-remote-web-ui"
    tokenTtlMs: 600000
    offlineAfterMs: 25000
    maxDevices: 4
    cookieName: dsh_pair
    requirePairingForLan: true
    autoTunnel: false
    enabled: true

- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light

- id: dsh-logicprobe
  name: dsh-logicprobe
  disabled: true      # peer 只声明支持 0.1.x，0.2.x 下被禁用
```

### 2.4 各插件自己的数据文件 / 目录（`$DSH_HOME` 下）

| 路径 | 大小 | 所属插件 | 内容与格式 | 同步判定 |
| --- | ---: | --- | --- | --- |
| `@wingsky-1/dsh-notifier/config.json` | 673 | dsh-notifier | 通知类型开关 + `channels[]`（browser/system）+ 静默时段 | 适合同步 |
| `@wingsky-1/dsh-notifier/history.jsonl` | 52,739（268 行） | dsh-notifier | 每行 `{ts,kind,title,message}`，**message 含会话标题/问题正文 → 会泄露对话内容** | 建议排除 |
| `@wingsky-1/dsh-notifier/status.json` | 95 | 同上 | 各通道最后投递状态 | 排除 |
| `@wingsky-1/dsh-notifier/seq.json` / `version` | 2 / 6 | 同上 | 序号与数据结构版本 | 可选 |
| `storages/workspace.json` | 14,712 | 核心（workspace） | workspace 注册表：`workspaceIds[]` + 每个工作区路径/元数据，version 2 | **必须同步**（否则会话列表/工作区分组错乱） |
| `storages/session_projcache.json` + `storages/session_projcache/sessions/*.json` | 157,141 + ~240 文件 | 核心 session 投影缓存 | 每会话投影快照（标题、outline、用量） | 排除（可重建缓存） |
| `storages/cost-meter/ledger.json` | 396,163 | dsh-cost-meter | 成本/用量台账（按 provider/model/workspace 累计） | 可选同步（否则统计历史断档） |
| `storages/cost-meter/ledger.json.native-search/` | 22 个 jsonl | 同上 | 检索计费明细，文件名是 sha256 | 排除 |
| `storages/whale.json` | 2,185,763 | `@linxin666/dsh-web-all`（用量报表） | `unit: whale` + `tables.reports`（weekly/daily 报表对象） | 可选同步（2 MB，可重建） |
| `storages/.ae7c92e0-*.tmp` / `.eac22f8f-*.tmp` | 530,581 / 0 | 存储层 | 原子写残留 | 排除 |
| `task-board/ledger-v2.json` / `.lock` / `scheduler-v2.json` | 223 / 102 / 28 | dsh-web-all task-board | schema v4 任务台账 + 定时调度信息 | 适合同步（当前为空表） |
| `worktime-board/data.json` | 283,388 | dsh-worktime-board | 工时统计 | 可选 |
| `usage-meter/ledger.json` | 872 | usage-meter（已停用） | 旧用量台账 | 排除 |
| `dsh-usage/usage-ledger.json` + `provider-snapshots.json` | 7,094 + 2,019 | dsh-usage | 余额/用量 | 可选 |
| `dsh-session-archive/state.json` | 48 | dsh-session-archive | 仅 `{version,nextCheckAt}` 调度游标 | 排除（随会话重建） |
| `dsh-cloud-sync/settings.json` | 1,021 | dsh-cloud-sync | provider/同步策略/deviceId/encryption | 可选，**含 `encryption` 段** |
| `dsh-cloud-sync/credentials.json` | 430 | 同上 | `{version,secrets}` —— **云端同步的令牌/密钥** | **必须排除** |
| `dsh-cloud-sync/archives/*.json.gz` | 22,264 | 同上 | 已上传产物的压缩归档 | 排除 |
| `llm-deepseek/files-v3.json` | 9,751 | dsh-llm-deepseek | 文件缓存索引 | 排除 |
| `.dsh-cad/scenes/` | 2 文件 | dsh-blender / CAD | 场景数据 | 可选 |
| `usage-meter`、`dsh-usage`、`super-injector/*.log` | — | — | 日志类 | 排除 |

## 3. `sessions/`：格式、体积、敏感度

### 3.1 目录结构

```text
sessions/
  --D-object-agents-sync--/                 # 工作区编码目录（24 个）
    session-bff99d3b-...-46d0e7b99661/      # 根会话：session-<uuid>
      session.v4.jsonl.zstd
    2ebe7391-ae42-4d99-9503-a4e54073a0ce/   # 子 Agent 会话：裸 <uuid>
      session.v4.jsonl.zstd
```

- 24 个工作区目录、236 个会话目录、**270 个 `.zstd` 文件**（同一会话目录可能同时存在 v3/v4/无版本三份，是格式升级的遗留）。
- 命名编码规则：绝对路径 → 去掉盘符冒号、`\`→`-`，两端加 `--`；非安全字符转 `~XXXX` 十六进制（空格 `~0020`、`#` 为 `~0023`）。例：`D:\object\agents\sync` → `--D-object-agents-sync--`，`D:\object\esp32\ESPhome test` → `--D-object-esp32-ESPhome~0020test--`。
- **磁盘上没有会话索引文件**；会话清单靠 `storages/workspace.json` + `storages/session_projcache/` 投影缓存组合。
- 目录里**没有附件副本**，附件在 `attachments/v1/`（内容寻址）。

版本分布：`session.v3` 121 个 / 60.88 MB，`session.v4` 78 个 / 101.67 MB，无版本 `session.jsonl` 71 个 / 150.08 MB；其中 29 个目录存在多版本共存。

### 3.2 体积

| 指标 | 数值 |
| --- | --- |
| 文件数 | 270 |
| 压缩体积 | **312.91 MB** |
| 解压后体积 | **1,033.73 MB**（约 1.01 GB，压缩比 3.3:1） |
| zstd 帧数 | **429,869**（平均每文件 ~1,592 帧） |
| 记录数（JSONL 行） | **684,640** |
| 单文件最大 | `--D-object-esp32-ESPhome~0020test--/session-a064c874…/session.v4.jsonl.zstd` 12.58 MB（解压 48.82 MB / 12,840 条） |
| 单文件解压最大 | `--D-object-go-src-blemesh-go--/session-34513317…/session.v4…` 49.23 MB（压缩 10.35 MB） |
| 平均 | 1.16 MB/文件，解压 3.83 MB/文件 |

按工作区（前 8）：

| 工作区目录 | 文件 | 体积 |
| --- | ---: | ---: |
| `--D-object-go-src-gateway-tongdy_backend_single--` | 51 | 134.26 MB |
| `--D-object-Laboratory-cc--` | 125 | 59.45 MB |
| `--D-object-esp32-ESPhome~0020test--` | 6 | 21.22 MB |
| `--D-object-go-src-blemesh-go--` | 8 | 20.59 MB |
| `--D-object-go-src-gateway--` | 8 | 20.49 MB |
| `--C-Users-wangyi-.dsh--` | 33 | 13.80 MB |
| `--D-object-Laboratory-cc-alert_advanced--` | 2 | 13.25 MB |
| `--D-object-go-src-gateway-we_user--` | 4 | 6.94 MB |

### 3.3 文件格式（重要）

**不是**单个 zstd 流：文件是**一串首尾相接的独立 zstd 帧**（每帧 magic `28 b5 2f fd`），每帧内是一段 UTF-8 JSONL（1 到若干条记录）。追加写入即以「追加新帧」实现，所以：

- 同步必须**整文件或按帧边界**传输；直接 `zstdDecompressSync(整个文件)` 只会解出第一帧内容（实测第一帧仅 206 B = 一行）。
- Node 侧可逐帧循环：定位所有 magic → 按 offset 切片 → 逐帧 `zstdDecompressSync` → 拼接。实测 198 帧的文件解出 1,711,423 B / 379 条。

前 2 行（真实文件，字段结构）：

```json
{"type":"session","version":4,"id":"session-56fdeab5-ee53-4da2-87a1-1560955188ed","createdAt":1793080548669,"cwd":"D:\\object\\Laboratory\\cc","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
{"type":"permission/preset","seq":0,"time":1793080548708,"data":{"preset":"workspace-write"}}
```

即：事件溯源式记录 `{type, seq, time, data}`（首行 `type:"session"` 是头部，带 `version/cwd/agentPreset/delegationDepth`）。

记录类型分布（全量 684,640 条，节选）：

| type | 条数 | 说明 |
| --- | ---: | --- |
| `reasoning-chunks` | 210,920 | 思考流分片（最大噪音源） |
| `assistant/chunk` | 116,860 | 回复流分片 |
| `tool-call-chunks` | 80,766 | 工具调用参数流分片 |
| `tool/result` | 48,553 | **工具输出全文（含文件内容/命令输出）** |
| `tool/call` | 48,168 | 工具调用 |
| `step/start` / `step/end` | 41,853 / 41,846 | 步边界 |
| `assistant/message` | 41,793 | 完整助手消息 |
| `text-chunks` | 17,101 | 文本分片 |
| `agent/inbox/spliced` | 7,068 | 子 Agent 消息拼接 |
| `user/message` | 5,034 | **用户消息全文** |
| `job/registered` / `job/settled` | 4,419 / 4,409 | 后台任务 |
| `turn/start` / `turn/end` | 2,407 / 2,385 | 回合边界 |
| `approval/asked` / `approval/decided` | 1,006 / 1,002 | 审批 |
| `session/title` | 385 | 标题 |
| `session` | 270 | 会话头 |
| `compaction/summary` | 44 | 压缩摘要 |
| 其余 ~35 种 | < 700 | schedule/goal/team/workflow 等 |

### 3.4 敏感度

- 含**用户消息原文**（5,034 条）与**工具输出原文**（48,553 条）——工具输出里可能有 `.env`、配置文件、数据库连接串、公司源码、内网 IP。
- 全量扫描 `sk-[A-Za-z0-9_-]{12,}` 模式：**0 命中**（未在会话里发现 DeepSeek 风格明文 API key）。
- 但仍建议同步侧默认开启「密钥模式脱敏」（`sk-*`、`ghp_*`、`xox?-`、`-----BEGIN … PRIVATE KEY`、`api[_-]?key\s*=`）+ 用户可选「只传元数据不传内容」。
- 单会话上限 12.58 MB、总 313 MB：同步插件必须支持分块、断点续传、按活跃时间增量（活跃会话秒级追加，历史会话不再变化）。

## 4. skills 与 AGENTS.md

### 4.1 skills 现状

| 位置 | 形态 | 规模 | 判定 |
| --- | --- | --- | --- |
| `C:\Users\wangyi\.agents\skills\` | 95 个目录，每目录一个 `SKILL.md`（+ `references/`、`scripts/`、`assets/`、`evals/`） | **612 文件 / 25.10 MB** | 必须同步 |
| `C:\Users\wangyi\.agents\.skill-lock.json` | skill 安装锁（v3）：source repo / skillPath / folderHash / installedAt | 7,639 B | 适合同步（增量判断依据） |
| `C:\Users\wangyi\.agents\.markdownlint.json` | 98 B | 文档规范 | 可选 |
| `C:\Users\wangyi\.dsh\skills\` | **不存在**（`user-dsh` 根为空） | — | — |
| `<workspace>/.dsh/skills`、`<workspace>/.agents/skills` | 当前工作区 `D:\object\agents\sync` 下均**不存在** | — | 同步插件可自动创建 |
| 插件自带 skills | `profiles/web/node_modules/dsh-blender/skills`、`profiles/web/node_modules/dsh-logicprobe/skills` | 随包 | 由 pnpm 安装恢复，**不需要同步** |

`~/.agents/skills` 体积 Top：`yashi-evernight-capture` 17.8 MB（70 文件）、`ui-ux-pro-max` 3.6 MB（72 文件）；其余多为 10–250 KB。

### 4.2 skills 加载优先级（来自 `@deepseek-ai/dsh-skill-filesystem` README「Roots and priority」）

| Rank | source | 路径 |
| ---: | --- | --- |
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` ← 本机实际使用的 95 个 |
| 600 | `bundled` | `$DSH_BUNDLED_SKILL_DIR`（可选） |

- project root = 最近的含 `.git` 的祖先目录，否则用 cwd。
- 只发现「一层」：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`，**嵌套 `**/SKILL.md` 不被发现**。
- `$DSH_HOME/skills` 会跳过 `.system` 子目录；目录被 chokidar 监视（depth 1），改动即时生效无需重启。
- 因此同步插件写 skills 时，目标目录选 `~/.agents/skills/`（跨机通用、rank 500）即可；如需「仅本项目」用 `<workspace>/.dsh/skills`。

### 4.3 AGENTS.md 的层级与优先级（来自 `@deepseek-ai/dsh-agent-instructions` README）

| 层级 | 路径 | 本机是否存在 | 说明 |
| --- | --- | --- | --- |
| 用户全局（最宽） | `$DSH_HOME/AGENTS.md` = `C:\Users\wangyi\.dsh\AGENTS.md` | ✅ 11,966 B | 每次首请求注入；无 `.local` 覆盖层 |
| 项目链 | `<projectRoot>/AGENTS.md` → … → `<cwd>/AGENTS.md`（逐层向具体） | 当前工作区无 | `CLAUDE.md` 同权候选；`AGENTS.local.md` / `CLAUDE.local.md` 为附加覆盖层 |
| 用户级 `~/.agents/AGENTS.md` | `C:\Users\wangyi\.agents\AGENTS.md` | ❌ 不存在 | DSH **不读**这个位置（`~/.agents` 只贡献 `skills/`） |
| 插件内置/其它 | — | — | 无 |

- 渲染顺序：user-global 在前，project 链由宽到具体；「更具体的指令优先」，但都不覆盖 system/developer/user 直接指令。
- 注入预算 `maxBytes = 65,536`；超限时**先丢整份更宽的文件**，再截断最具体的文件。
- 由 `read`/`write`/`edit` 触达更深目录后，下一请求补发新增范围（`Additional instructions from: …`）；内容相同则去重。
- 结论：同步插件只需同步 `~/.dsh/AGENTS.md` + 各仓库工作区自己的 `AGENTS.md`（后者属于项目仓库，不在本盘点范围）。

## 5. 其它「插件文件」目录

| 路径 | 文件数 | 体积 | 用途 | 判定 |
| --- | ---: | ---: | --- | --- |
| `plugins/` | 23 | 1.24 MB | 3 个本地源码插件：`dsh-archive-manager`、`dsh-delete-session`、`dsh-super-injector`（含 `lib/index.js` 382 KB + sourcemap） | 适合同步（体积小，属用户资产） |
| `.agent-presets/` | 14 | 0.16 MB | 自定义 agent 预设：`liangshen/`、`router-standard/`（`preset.yml` + `agent.cordis.yml` + 若干 `*.mjs` bootstrap 脚本） | 适合同步 |
| `attachments/` | 1,154 | 100.64 MB | 会话附件（内容寻址，**不可变**）：`objects/` 837 文件 85.52 MB、`request-images/` 315 文件 14.76 MB、`file-objects/` 1、`files/` 1 | 可选同步（按需/懒同步） |
| `skin-center/` | 8 | 33.14 MB | 皮肤中心壁纸**帧缓存**（`.cache/frames/*`，文件名是 base64 的 Steam 场景路径） | **排除**（纯缓存） |
| `cache/` | 46 | 4.73 MB | `cache/attachments` 等运行缓存 | 排除 |
| `temp/` | 951 | 55.84 MB | 历史调试/导出残留（`dumpconfig*.txt`、`export-preview*.txt`、`*-bak.yml`、`session.jsonl` 1.3 MB、各类 `*.mjs` 临时脚本） | 排除 |
| `dsh-runtimes/` | 6,136 | 257.24 MB | 隔离运行时：`dependencies/{node,pnpm,python}` + `runtime.json`（desktop 0.2.1-rc.5 / node 24.21.0 / python 3.12.14 / numpy、pandas、python-docx…） | 排除（可重装） |
| `.pnpm-store/` | 15,401 | 451.26 MB | pnpm 内容寻址存储（v10），另有一份在 `AppData\Local\pnpm\store` | 排除 |
| `.bak-web-update-20260920/` | 3 | 0.08 MB | 升级前备份（package.json / patch / lock） | 排除 |
| `profiles/*/.plugin-manager/logs/` | 14 | ~0.07 MB | 插件安装 pnpm 日志 | 排除 |
| `super-injector/*.log`、`*.log`、`*.tmp` | — | — | 日志/临时文件 | 排除 |

## 6. 体积总表（含同步建议）

| 类别 | 路径 | 文件数 | 体积 (MB) | 变更频率 | 标注 |
| --- | --- | ---: | ---: | --- | --- |
| 全局配置（散落） | `~/.dsh/*.json`、`*.yaml.imported`、`AGENTS.md` | 21 | 0.15 | 手动/含高频项 | **适合同步**（`.credentials.yaml` 除外） |
| Profile 配置 | `~/.dsh/profiles/<p>/`（package.json / cordis.patch.yml / cordis.yml / pnpm-* / .npmrc / compatibility.json） | 31 | ~0.07 | 装/改插件时 | **适合同步**（`.bak` 除外） |
| Profile 依赖 | `~/.dsh/profiles/<p>/node_modules/` | 43,738 | 1,704.10 | 装机时 | **排除** |
| 插件安装日志 | `~/.dsh/profiles/<p>/.plugin-manager/logs/` | 14 | 0.07 | 装插件时 | 排除 |
| 会话 | `~/.dsh/sessions/` | 270 | **312.91**（解压 1,033.73） | 活跃会话秒级追加 | **适合同步**（体积主体，需增量+分块） |
| 核心存储 | `~/.dsh/storages/workspace.json` | 1 | 0.01 | 新建/切换工作区 | **必须同步** |
| 插件存储 | `~/.dsh/storages/{cost-meter,whale.json,session_projcache*}`、`task-board/`、`worktime-board/`、`dsh-usage/`、`usage-meter/`、`dsh-session-archive/`、`llm-deepseek/`、`.dsh-cad/` | ~285 | 7.4 | 随会话/每轮 | 部分同步（见 §2.4） |
| 云同步插件 | `~/.dsh/dsh-cloud-sync/` | 4 | 0.03 | 连接时 | 排除（含 `credentials.json`） |
| 附件 | `~/.dsh/attachments/` | 1,154 | 100.64 | 上传时（不可变） | 可选/懒同步 |
| 本地插件源码 | `~/.dsh/plugins/` | 23 | 1.24 | 手动 | 适合同步 |
| Agent 预设 | `~/.dsh/.agent-presets/` | 14 | 0.16 | 手动 | 适合同步 |
| 全局 skills | `~/.agents/skills/` + `.skill-lock.json` | 613 | 25.11 | 手动/同步脚本 | **适合同步** |
| 皮肤缓存 | `~/.dsh/skin-center/` | 8 | 33.14 | 换壁纸时 | **排除**（缓存） |
| 运行缓存 | `~/.dsh/cache/` | 46 | 4.73 | 持续 | 排除 |
| 临时/调试 | `~/.dsh/temp/` | 951 | 55.84 | 持续 | 排除 |
| 隔离运行时 | `~/.dsh/dsh-runtimes/` | 6,136 | 257.24 | 升级时 | 排除 |
| pnpm 存储 | `~/.dsh/.pnpm-store/` | 15,401 | 451.26 | 装插件时 | 排除 |
| 升级备份 | `~/.dsh/.bak-web-update-20260920/` | 3 | 0.08 | 常量 | 排除 |
| 凭据 | `~/.dsh/.credentials.yaml` | 1 | 0.0003 | 登录时 | **必须排除** |
| 合计 | `~/.dsh` + `~/.agents` | 68,713 | 2.86 GB | — | 推荐同步集 ≈ **440 MB**（含会话 313 MB + 附件 101 MB + skills 25 MB + 配置 1.5 MB） |

## 7. 敏感信息风险清单

| 风险项 | 位置 | 处理建议 |
| --- | --- | --- |
| 凭据文件 | `~/.dsh/.credentials.yaml`（273 B，11 行） | **硬排除**；同步前按文件名 + 后缀（`.credentials*`、`credentials.json`）双重黑名单 |
| 云同步密钥 | `~/.dsh/dsh-cloud-sync/credentials.json`（`{version,secrets}`） | **硬排除**（文件名含 `credentials`，但位于插件子目录，需按路径规则匹配） |
| SSH 主机清单 | `~/.dsh/dsh-ssh.json`（内网 IP、用户名、私钥路径；无密码本体） | 同步可选，默认打码 IP/用户名后再传 |
| 会话内容 | `~/.dsh/sessions/**`（用户消息 5,034 条 + 工具输出 48,553 条） | 同步时启用密钥模式脱敏；提供「仅同步元数据」档 |
| 通知历史 | `~/.dsh/@wingsky-1/dsh-notifier/history.jsonl`（含问题/标题正文） | 排除，或仅同步 `config.json` |
| 统计中的绝对路径 | `dsh-get-balance-series-store.json`、`storages/whale.json`、`session_projcache/` | 排除（含 `C:\Users\wangyi\...` 等工作区路径） |
| 令牌/环境变量名 | `settings.yaml.imported`、`profiles/desktop/cordis.yml` 只有 `apiKeyEnv: DEEPSEEK_API_KEY` 之类的**变量名** | 可同步，无需脱敏 |

扫描结论：对根配置、四个 profile 的 `package.json`/`cordis.patch.yml`/`pnpm-lock.yaml`、`storages/workspace.json` 等 17 个候选文件做正则扫描（`sk-…`、`ghp_…`、`xox?-`、`-----BEGIN`、`apiKey="…"`、`"password"`、`"token":`、`secret`），仅 `dsh-cloud-sync/{settings,credentials}.json` 命中 `secret`（即上面列出的排除项）；其余均为 `clean`。`dsh-ssh.json` 因 `auth.kind=key` 被记入敏感项，但未含私钥内容。

## 8. 对同步插件的设计要求（由盘点直接推导）

1. **配置同步集（必做，< 1 MB）**：根目录白名单（`AGENTS.md`、`pet.json`、`dsh-ssh.json`、`skin-center-active.json`、`dsh-web-settings-legacy-import.json`、`settings.yaml.imported`）+ 各 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`.npmrc`、`pnpm-lock.yaml`、`compatibility.json` + `storages/workspace.json` + `plugins/` + `.agent-presets/` + `~/.agents/skills/`。
2. **`cordis.patch.yml` 合并策略**：按 entry `id` 求差集合并，保留本机独有条目；冲突时以「修改时间较新 + 用户确认」为准。**不要整文件覆盖**（会丢本机 plugin 启用状态）。
3. **`package.json` 同步必须是「依赖并集 + bundles 保序合并」**，同步完成后提示用户执行 `pnpm install`（`node_modules` 绝不传输）。
4. **会话同步**：按文件 mtime/大小做增量；上传前整文件压缩（zstd 帧序列可直接 `tar/zstd` 二次封装，勿假设单帧）；对活跃会话加「写入中」锁或用 `.part` 重命名；单文件 12 MB 上限需分块。
5. **附件按需**：`attachments/v1/**` 是内容寻址且不可变，可用对象清单（sha 命名）做懒同步 / 断点续传。
6. **黑名单（正则）**：`.credentials*`、`credentials.json`、`node_modules/`、`.pnpm-store/`、`dsh-runtimes/`、`temp/`、`cache/`、`**/.cache/**`、`.plugin-manager/logs/`、`*.log`、`*.tmp`、`*.bak*`、`*.migrated.bak`、`session_projcache*`、`*.lock`。
7. **跨平台路径**：会话目录名是工作区**绝对路径**的编码，跨机恢复会产生「另一台机器的工作区」目录；同步插件需提供「工作区路径重映射」选项，否则会话会挂到不存在的路径下。
8. **恢复顺序**：`package.json` → `pnpm install` → `cordis.patch.yml` → 插件自有配置文件 → `storages/` → `sessions/`（最后，避免投影缓存指向缺失文件）。

## 9. 调研方法与限制

- 体积统计用 `Get-ChildItem -Recurse | Measure-Object -Sum`；会话解压用 Node `zlib.zstdDecompressSync` **逐帧**解码（脚本在临时目录运行，仅打印统计与前 3 行）。
- 会话解压统计覆盖全部 270 个文件（429,869 帧、684,640 条），非抽样。
- 明文密钥扫描为模式匹配，**不能证明**不存在自定义格式的密钥；`dsh-ssh.json` 中引用的私钥文件（`C:/Users/yashi/.ssh/id_rsa_termux`）不在本次范围。
- `~/.dsh/.credentials.yaml` 与 `~/.dsh/dsh-cloud-sync/credentials.json` 只做了存在性/大小/键名统计，**未读取内容**。
- 桌面版内核（0.2.1-rc.5）以 `app.asar` 分发，技能/指令的优先级说明取自全局 npm 包 `@deepseek-ai/dsh@0.2.0-rc.2` 的同名包 README（版本相邻，行为一致）。
