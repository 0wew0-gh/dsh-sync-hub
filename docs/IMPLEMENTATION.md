# 实现步骤（Implementation Plan）

> 配套文档：[设计方案](DESIGN.md)
> 状态：草案，待评审后开工
> 预估总工作量：约 15.5 人日（单人）；可并行部分见各阶段「可并行」标注

---

## 0. 前置约定

1. **工作目录**：`D:\object\agents\sync`（本仓库）。
2. **目标环境**：Windows 11 + DSH Web（`@deepseek-ai/dsh@0.2.0-rc.2`），Node >= 22.19（本机 24.21）；后续再覆盖 desktop 与 macOS/Linux。
3. **开发期安装方式**：`dsh plugin --profile web add link:D:/object/agents/sync`（`link:` 不复制、改代码即生效）。这一步会改用户 profile 的 `package.json` 与 `node_modules`，**执行前必须征得用户同意**，并在完成后告知如何卸载（`dsh plugin --profile web remove dsh-sync-hub`）。
4. **同步语义（全局不变量）**：内容寻址（SHA-256）+ 三方比较（base/本地/远端）+ 「同内容不覆盖」（DESIGN §5.2.1、§5.11）。任何阶段、任何 target、任何策略都不得绕过这条：内容相同 → noop，不写、不传、不改 mtime；只有内容确证不同才进入快进或合并；无法裁决 → `needs-choice`。
5. **验证口径**：每个阶段结束必须满足「`node --check` 全绿 + `node --test` 全绿 + 该阶段验收项逐条通过」；不通过不进入下一阶段。
6. **不做的事**：不引入运行时依赖；不改动 `~/.dsh` 下现有插件的配置；不自动 `git commit`/`git push`（按用户全局规则）；不删除他人文件。

---

## 1. 目录骨架（P0 建立）

```text
D:\object\agents\sync\
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ LICENSE
├─ .gitignore
├─ .markdownlint.json
├─ .dshsyncignore.example
├─ lib/
│  ├─ index.js              # host 入口（cordis 插件）
│  ├─ client.js             # 浏览器单文件 bundle（__ModuleLoader__ 包装）
│  └─ core/
│     ├─ index.js           # 统一导出（测试与 ./core 入口）
│     ├─ scopes.js          # scope 注册表与内置 scope 声明
│     ├─ scan.js            # 扫描、排除规则、写入中检测
│     ├─ manifest.js        # 清单生成/序列化/三方比较
│     ├─ sync.js            # 同步主流程（preview / apply）
│     ├─ merge.js           # 文本 merge3、YAML 按 id、package.json 并集
│     ├─ history.js         # 快照索引、保留、恢复计划
│     ├─ restore.js         # 恢复顺序、备份、原子写
│     ├─ secrets.js         # DPAPI / 0600
│     ├─ state.js           # settings.json / state 目录 / 锁
│     ├─ paths.js           # $DSH_HOME 解析、路径编码/映射、安全校验
│     ├─ util.js            # 原子写、sha256、重试、JSON/YAML 小工具
│     └─ targets/
│        ├─ index.js        # provider 工厂与鸭子接口
│        ├─ local-dir.js
│        ├─ webdav.js
│        └─ s3.js
├─ test/
│  ├─ manifest.test.mjs
│  ├─ merge.test.mjs
│  ├─ targets.test.mjs
│  ├─ sessions.test.mjs
│  ├─ bundle.test.mjs
│  └─ e2e-local.test.mjs
├─ docs/
│  ├─ DESIGN.md
│  ├─ IMPLEMENTATION.md
│  └─ research/            # 本机调研报告（机制/数据/参考实现）
└─ MEMORY.md               # 会话进度与开发上下文（不提交）
```

`package.json` 关键字段：

```json
{
  "name": "dsh-sync-hub",
  "version": "0.1.0-dev.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./core": "./lib/core/index.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": []
    }
  },
  "engines": { "dsh": ">=0.2.0-rc.2 <0.3.0" },
  "scripts": {
    "check": "node --check lib/index.js && node --check lib/client.js",
    "test": "node --test test/*.test.mjs"
  }
}
```

注意：

- `dsh.client.inject` 只放**包名**（本插件自身不依赖其它客户端包，留空即可），不要写服务名。
- `lib/client.js` 单文件、`id` 必须等于包名，可用 `test/bundle.test.mjs` 静态断言。
- 不引入 `dependencies`；`devDependencies` 也尽量为空（若加 `typescript` 仅用于 `--checkJs`，不进 `dependencies`）。

---

## 2. 阶段总览

| 阶段 | 目标 | 主要产出 | 验收方式 | 预估 | 依赖 |
| --- | --- | --- | --- | ---: | --- |
| P0 | 空插件可加载、设置页出现 | 骨架 + 占位 tab + `status` 端点 | 重启 DSH 后能在设置→插件看到 tab；端点返回 `ok` | 0.5 d | — |
| P1 | 本地目录目标 + 扫描/清单/预览/同步 | core 扫描、manifest、local-dir、`preview`/`sync` | `node --test` + e2e 往返哈希一致 | 2 d | P0 |
| P2 | 设置页 v1 | 目标 CRUD、scope 勾选、预览/同步/进度/冲突弹窗 | 手工走通全部交互，无控制台错误 | 2 d | P1 |
| P3 | WebDAV + S3 兼容目标 | 两套 provider、探测、重试、ETag | 假服务器集成测试全绿 | 2 d | P1 |
| P4 | 会话数据同步 | sessions scope、路径映射、keep-both、断点 | 313 MB 真实数据往返字节一致 | 2 d | P1 |
| P5 | skills / 插件文件 / 插件设置 | skills scope、plugin-files、结构化合并 | 双 profile 合并用例全绿 | 2.5 d | P1 |
| P6 | AGENTS.md + 历史与恢复 | merge3、快照、恢复顺序、备份 | 恢复到临时 home 后哈希一致 + 回滚可用 | 2 d | P5 |
| P7 | 定时/加密/脱敏/i18n/文档/真机验收 | 定时器、加密、双语、README、验收清单 | 验收清单逐条勾选 | 2.5 d | P2-P6 |
| P8 | 可选增强 | rclone、blob GC、单文件恢复、Agent 工具 | 视需求决定 | — | P7 |

---

## 3. 阶段详解

### P0 脚手架与可加载验证（0.5 d）

任务：

1. 建目录骨架、`package.json`、`cordis.patch.yml`（内容：`- insert: [{ id: dsh-sync-hub, name: dsh-sync-hub }]`）。
2. `lib/index.js`：`export const inject = ['webServer']`（`connection` 用 `ctx.get('connection')` 软取）；`apply(ctx)` 注册 `/dsh-sync` prefix 路由与 `status` 端点；统一 `sendJson` + loopback 围栏；全部注册包在 `ctx.effect`。
3. `lib/client.js`：标准包装 + `inject: ['slots', 'locale']` + `ctx.slots.inject('settings.plugins.tab', ...)` 注册占位组件「数据同步（开发中）」；`ctx.locale.register` 中英双语。
4. `test/bundle.test.mjs`：断言 `__ModuleLoader__.load` 存在、`id === require('../package.json').name`、`exports['./client']` 存在、`inject` 数组内容。
5. `.gitignore`、`.markdownlint.json`、`README.md` 初版。

验收：

- `npm run check`、`npm test` 绿。
- 用户同意后执行 `dsh plugin --profile web add link:D:/object/agents/sync` → 完全重启 DSH → 设置 → 插件能看到「数据同步」tab。
- `curl http://127.0.0.1:58770/dsh-sync/status`（端口以 DSH 实际端口为准）返回 `{"ok":true,...}`；非 loopback 来源应被拒绝（可用另一台机器或改 Host 头验证）。

风险：`settings.plugins.tab` 不存在时，本阶段即验证 `settings.section` 回退路径。

### P1 核心引擎 + 本地目录目标（2 d，可并行：scan/manifest 与 local-dir 互不依赖）

任务：

1. `paths.js`：解析 `$DSH_HOME`（优先环境变量，退回 `~/.dsh`）、`$AGENTS_HOME`（默认 `~/.agents`）、profile 目录；会话目录名编码/解码（`:`→`-`、空格→`~0020`）；`assertInside()`。
2. `util.js`：`sha256File`（流式）、`atomicWrite`（tmp + rename）、`retry`、`readJson/writeJson`（0600）、最小 YAML 解析/序列化（v1 只支持本插件需要的子集，或引入零依赖手写实现）。
3. `scopes.js`：内置 scope 声明表（§DESIGN 4.1），支持 `extraInclude/extraExclude`。
4. `scan.js`：枚举 + 默认排除正则 + 单文件上限 + 符号链接策略 + `mtime/size` 采集。
5. `manifest.js`：构建清单、`diffManifests(base, local, remote)` 产出动作列表（upload/download/delete/conflict/noop），并实现 §DESIGN 5.2.1 的同内容判定：`sha256` 相同即 `noop`，且区分 `identical`（相同跳过）与 `fast-forward`（单侧变化）。
6. `targets/local-dir.js`：`probe/getWithMeta/put/head/remove`；原子写；锁文件。
7. `state.js` + `settings.json` 读写（密钥字段打码）。
8. `sync.js`：`preview()` 只读；`apply()` 上传/下载/删除 + 写清单 + 本地 base 清单更新；**写目标文件前先算目标 SHA-256，相同则跳过写入**（不改 mtime）；运行状态机（`idle/running/succeeded/failed/cancelled`）。
9. host 端点：`settings.get/save`、`targets.list/upsert/remove/test`、`scopes.estimate`、`preview`、`sync`、`runs.get/cancel`。
10. 测试：manifest 差异用例（新增/修改/删除/双改/双删/删除对修改/内容相同 mtime 不同/跨路径同内容/目标同内容跳过/`--force` 覆盖）；排除规则；本地 target 往返。

验收：

- `node --test` 全绿。
- `test/e2e-local.test.mjs`：构造临时 home（含 3 个 scope 样例文件）→ 同步到临时目标目录 → 清空本地 → 从目标恢复 → 断言文件哈希一致、排除项未被同步。
- **重复同步断言**：对同一份数据连续同步两次，第二次 `preview`/`sync` 结果中所有条目均为「相同（跳过）」，且本地文件 mtime 不变、目标端无新增 blob。
- 单 scope（agents-md）在真实 `$DSH_HOME` 上预览正确、同步后远端出现 blob 与 manifest。

### P2 设置页 v1（2 d，依赖 P1 端点）

任务：

1. UI 框架：tab 内三段式布局、主题 token 样式、加载/错误/空态；`call(endpoint, payload)` 封装（优先 `ctx.connection.rpc.call`，失败回落 `fetch`）。
2. 「同步」页：scope 勾选卡片（含预估体积/文件数）、目标多选、方向与策略、预览结果按动作分组（**相同跳过 / 快进上传 / 快进下载 / 合并 / 删除 / 冲突**）、开始同步、轮询进度、结果摘要（含「相同跳过 n」）。
3. 「同步目标」页：列表 + 新增/编辑抽屉（类型联动字段）+ 测试连接 + 删除确认；密钥输入占位符逻辑。
4. 「历史与恢复」页：占位 + 快照列表（P6 前显示「暂无快照」）。
5. 冲突弹窗 `DiffDialog`：分组列表 + 逐项选择 + 二次提交（P1 的 `needs-choice` 数据结构）。
6. i18n：中文/英文文案全量，`t()` 插值。
7. 手工验收：全部按钮可达、错误提示可读、刷新后状态正确、明暗主题正常。

验收：手工清单逐条通过；页面无 `console.error`；所有端点均被至少调用一次（可用 devtools network 核对）。

### P3 WebDAV 与 S3 兼容目标（2 d，可与 P2 并行）

任务：

1. `targets/webdav.js`：Basic 认证、HTTPS 校验（局域网 http 开关）、逐级 MKCOL（405/301/302 兼容，409 先 probe）、`PUT` + `MOVE`（不支持时直 PUT）、ETag `If-Match`/`If-None-Match`、30s 超时 + 2 次重试。
2. `targets/s3.js`：手写 SigV4（`x-amz-content-sha256`、canonical request）、path/virtual-host 寻址、OSS/COS/MinIO/R2/B2 默认 region 与寻址差异、`HEAD`/`PUT`/`GET`、412/409 处理。
3. `targets/index.js`：工厂、`probe()`（写探针 + 读回 + 删除）、错误分类（认证/权限/网络/冲突）。
4. 测试：`node:http` 假 WebDAV（覆盖 401/404/405/409/412/MOVE 不支持）；假 S3（校验 Authorization 头与 payload hash、覆盖 412）；重试与超时。
5. UI：目标表单补全两种类型的字段与「测试连接」结果。

验收：假服务器测试全绿；用真实账号做一次只读探测（凭据由用户在本机 UI 输入，不写入仓库）——若无法提供，则列为 P7 真机验收项。

### P4 会话数据（2 d，可与 P5 并行）

任务：

1. `scopes.js` 增加 `sessions`：`$DSH_HOME/sessions/**`，按目录树映射，`maxFileBytes` 64 MB。
2. 增量：`size + mtimeMs` 判定；哈希前检查 `size` 是否变化（写入中跳过本轮）。
3. 冲突：`keep-both` —— 本地保留原名，远端版本写入 `<原名>.conflict-<device>-<ts>`（本地与远端各一份），结果中列出。
4. 路径映射：`as-is|map|skip` + `map` 规则表；恢复时重写目录名。
5. 恢复：原子写、逐文件哈希校验；提供「清理投影缓存」端点（只删 `storages/session_projcache`）。
6. 测试：用 `zlib.zstdCompressSync` 生成多帧样本；12 MB 合成文件；并发修改模拟；字节级往返断言；**同内容不重写断言（目标文件 SHA-256 相同则写入次数为 0、mtime 不变）**；真实数据（用户同意后）只读扫描计数，不复制内容进仓库。

验收：

- 样本往返 SHA-256 一致；冲突产生两份且均可在 UI 看到；路径映射用例正确。
- **重复同步**：对同一份会话数据二次同步，结果全部为「相同跳过」，文件 mtime 不变。
- 真实 313 MB 数据首同步到本地目录 target，耗时记录在案（预期 < 60 s）；恢复后随机抽样 5 个会话哈希一致。

### P5 skills / 插件文件 / 插件设置（2.5 d）

任务：

1. `plugin-files`：`$DSH_HOME/plugins/**`、`.agent-presets/**`；文件 newer 策略；删除 tombstone；同内容（SHA-256 相同）不重写、不改 mtime。
2. `skills`：`~/.agents/skills/**` + `.skill-lock.json`；一层目录结构；可执行位（`mode`）随清单保存；删除 tombstone；同内容跳过写入。
3. `plugin-settings`：
   - `cordis.patch.yml`：解析 → 按 id 索引 → **语义等价判定（相同则整文件 noop）** → 三方合并（只一侧变取变化侧；双变冲突）→ 可移植化清洗 → 序列化；写前备份；合并后校验键集。
   - `package.json`：dependencies 并集、bundles 保序并集、孤儿过滤、`allowBuilds` 不继承；内容语义等价时 noop。
   - `pnpm-lock.yaml`：冲突取远端；`pnpm-workspace.yaml`、`.npmrc`、`compatibility.json` 按 newer。
   - profile 选择（默认 web）。
4. 测试：合并矩阵用例、语义等价 noop（注释不同但配置相同）、tombstone 传播、孤儿过滤、`allowBuilds` 不继承断言、patch 注释丢失的已知行为记录。

验收：两个临时 profile 互相同步后，`cordis.patch.yml` 含双方条目、本机独有条目未丢；`package.json` bundles 顺序稳定；skills 目录文件数/权限一致；**双方数据本就一致时不产生任何写入**。

### P6 AGENTS.md 与历史/恢复（2 d）

任务：

1. `merge.js` 的 merge3（行级 LCS diff3）+ 冲突位置返回；`agents-md` scope 接入。
2. `history.js`：快照写入（有变更才写）、`index.json`（`if-match`）、保留上限清理、列表/预览。
3. `restore.js`：恢复计划（顺序见 DESIGN §5.10）、恢复前备份、`restartRequired`/`installDeferred` 标记、逐步结果。
4. UI：历史列表、预览、恢复确认、结果提示（含 `pnpm install` 命令与备份路径）。
5. 测试：merge3 经典用例（双方不同行/相邻行/删除/插入）；快照保留；恢复幂等（连续两次恢复结果一致）。

验收：`AGENTS.md` 三方合并用例全绿；恢复到临时 home 后与源 home 的选定文件哈希一致；回滚到上一快照可用；失败时停在中途并报告。

### P7 收尾与真机验收（2.5 d）

任务：

1. 定时同步：`ctx.effect` 定时器 + 重入保护 + `runAutomaticSync` 返回 `{attempted, reason}`。
2. 加密（可选）：AES-256-GCM + scrypt 装饰器；解锁端点与 UI。
3. 脱敏（可选）：正则替换，仅作用于本次同步，默认关。
4. 诊断导出（脱敏）、日志保留。
5. README（中英）、CHANGELOG、LICENSE、`.dshsyncignore.example`、`docs/` 校对。
6. 真机验收清单：单机双 profile 往返、双设备（或两个 home）经 WebDAV 同步、坚果云/OSS 实测、Windows 桌面版加载、恢复后重启 DSH 可用。
7. 版本定格：`0.1.0`（若 P3-P6 全部完成）→ 打 tag（按用户规则，需明确要求才打）。

验收：验收清单逐条勾选；无 P0/P1 级缺陷；README 按步骤可从零安装成功。

### P8 可选增强

- `rclone` target（本机已装 rclone 时）。
- blob GC（按清单引用计数清理远端孤儿对象）。
- 单文件恢复、按时间范围同步会话。
- Agent 工具/命令触发同步（需评估权限风险）。

---

## 4. 测试与验证矩阵

| 维度 | P1 | P3 | P4 | P5 | P6 | P7 |
| --- | --- | --- | --- | --- | --- | --- |
| `node --test` 单元/集成 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| e2e 本地目录往返 | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| 假 WebDAV/S3 | — | ✓ | — | — | — | ✓ |
| 真实云端（用户凭据） | — | 探测 | — | — | — | ✓ |
| 真实 DSH 数据（只读） | 预览 | — | 扫描+同步 | 同步 | 恢复 | ✓ |
| UI 手工 | — | — | ✓ | ✓ | ✓ | ✓ |
| 双设备/双 home | — | — | — | — | — | ✓ |

---

## 5. 里程碑

| 版本 | 包含阶段 | 判定标准 |
| --- | --- | --- |
| v0.0.1（内部） | P0 | 设置页出现空 tab，插件可加载 |
| v0.1.0 | P1-P2 | 本地目录目标下的配置类同步可用 |
| v0.2.0 | P3-P4 | 三种目标 + 会话同步可用 |
| v0.3.0 | P5-P6 | 全量 scope + 历史恢复可用 |
| v1.0.0 | P7 | 真机验收通过、文档齐全、可发布 |

---

## 6. 发布清单

- [ ] `npm run check` / `npm test` 全绿
- [ ] `package.json` 版本、`engines.dsh` 范围、`dsh` 字段正确
- [ ] `lib/client.js` 单文件、`id` = 包名、无跨插件值导入
- [ ] 默认排除规则覆盖 `.credentials*`、`node_modules`、`.pnpm-store`、`temp`、`cache`、日志
- [ ] 「同内容不覆盖」专项验收：二次同步全为相同跳过、目标同内容不写、mtime 不变、跨路径 blob 去重
- [ ] 恢复路径全部走备份 + 原子写 + 写前 SHA-256 比较
- [ ] README 含安装/卸载/首次配置/回滚步骤
- [ ] CHANGELOG 与 tag（按用户要求执行）
- [ ] 不提交 `AGENTS.md`、`MEMORY.md`（`.gitignore` 已包含）

---

## 7. 待用户确认（开工前）

1. 是否同意把本插件 `link:` 安装到 `web` profile 用于开发调试（会修改该 profile 的依赖与 `node_modules`）。
2. 确认 [DESIGN.md §14.2](DESIGN.md) 的 D1–D10 决策；其中 D1（包名）、D2（v1 目标范围）、D3（会话冲突默认策略）、D4（附件默认不同步）、D10（强制覆盖开关）影响 P1-P4 的接口形状，建议先定。
3. 是否需要在 P3 阶段提供真实云端账号做联调（可延后到 P7，不阻塞开发）。
