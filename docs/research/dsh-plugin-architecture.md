# DSH 第三方插件开发机制调研（@deepseek-ai/dsh 0.2.0-rc.2）

调研时间：2026-11-13　方式：只读静态阅读 + 只读命令

## 0. 阅读约定与证据等级

本文所有结论都尽量给到本机真实文件路径与代码摘录。路径别名：

| 别名 | 实际路径 | 说明 |
| --- | --- | --- |
| `$DIST` | `D:\npm\node_modules\@deepseek-ai\dsh\` | npm 全局 CLI 包（含全部官方运行时包，扁平安装在 `$DIST\node_modules\@deepseek-ai\`） |
| `$CORE` | `$DIST\node_modules\@deepseek-ai\` | 官方包目录，下文 `$CORE\dsh-xxx\lib\...` |
| `$PROFILE` | `C:\Users\wangyi\.dsh\profiles\web\` | 当前 web profile |
| `$NM` | `$PROFILE\node_modules\` | profile 的插件安装目录（pnpm hoisted） |

标记含义：

- **[证据]**：文中引用了实际文件内容或实际命令输出，可复核。
- **[推断]**：由多处证据交叉推出，但未找到单一直接声明。
- **[未证实]**：观察到现象但无法确定语义，不建议依赖。

---

## 1. 结论速览

1. **一个 DSH 插件 = 一个 npm 包 + 一个 `cordis.patch.yml` 补丁层 + （可选）一个浏览器半边**。宿主半边就是普通的 cordis 插件（`export function apply(ctx, config)` + 可选 `inject`/`Config`），纯 ESM JS 即可运行，**不强制编译**。**[证据]**
2. 浏览器半边**必须**是「懒工厂 CJS 包装」：文件里调用 `window.__ModuleLoader__.load({ id: '<包名>', factory(require){...} })`，id 必须等于包名。它不是被浏览器当 ESM `import` 的，而是由宿主扫包 → 拼 `window.__DSH_BOOT__` → 通过 `/plugins/??<id>/client.js&rev=...` 由页面加载。**[证据]**
3. 客户端入口**要么手写这个包装，要么用 bundler（esbuild/tsdown）产出单文件 CJS 再套 banner/footer**。官方那套 `tsdown.client.ts` 构建器**没有随 npm 包发布**，第三方需要自己复刻（本机至少 3 个插件各自复刻过）。**[证据 + 推断]**
4. 设置页/插件页的扩展点全部是**插槽（slot）**，不是"注册设置页函数"：`settings.section`（设置里的一级页）、`settings.general.item`（常规页里的一行）、`settings.plugins.tab`（内置"插件"页里的一个 Tab）、`plugins.item` / `plugins.bundle.config` / `plugins.row.config`（插件管理页里的插件配置）、`settings.action`/`settings.onboarding` 等。注册写法是 `ctx.slots.inject(key, () => ctx.slots.register({name,id,order,label}, Component))`。**[证据]**
5. 服务端向客户端暴露 API 有四条真实通路：`ctx.webServer.register()`（裸 HTTP，第三方最常用）、`ctx.connection.rpc.handle()/fetch.register()`（带内建信任校验的通用 RPC/Fetch）、Typert 生成式类型化 Remote（`ctx.remote.*`，**生成器未发布，第三方难以使用**）、以及把操作挂成对话 command 让前端 `ctx.remote.commands.execute()` 调（兼容退路）。**[证据]**
6. 配置走 schemastery `Config`，最终落在 profile 的 `cordis.patch.yml` 行 `config` 里；**覆盖是整段替换而非深合并**。运行期读写由宿主 `ctx.settings`（`SettingsForms`）负责，客户端由 `ctx.configForms` + `settings/document-updated` 事件同步。**[证据]**
7. 会话存 `$DSH_HOME/sessions/<转义后的项目cwd>/<sessionId>/session.v4.jsonl.zstd`（zstd 帧 JSONL，header 一行 + 事件行）；skills 默认扫 4 个根（项目 `.dsh/skills`、`.agents/skills` + 用户 `~/.dsh/skills`、`~/.agents/skills`，另有 custom/bundled）；`AGENTS.md` 用户级在 `$DSH_HOME/AGENTS.md`，项目级按 `.git` 定根。**[证据]**
8. 本地开发挂载 = 把包放进 profile `node_modules`（`dsh plugin --profile web add file:...` / `link:` / `github:` 都行）+ 把包名加进 `package.json` 的 `dsh.profile.bundles`（或手动 patch insert）+ 重启；宿主 HMR 只覆盖**配置与宿主 JS 模块**，**客户端 bundle 替换需要重启**。**[证据 + 推断]**

---

## 2. 插件包最小结构

### 2.1 官方随包自带的"权威教程"（先读这个）

DSH 在 `dsh-agent-preset` 里内置了两个 skill，是官方对第三方插件开发的正式说明，比 d.ts 更可操作：

- `$CORE\dsh-agent-preset\skills\cordis-plugin-development\SKILL.md`
- `...\references\host-plugin.md`（宿主半边 / bundle / manifest / 安装启用）
- `...\references\ui-plugin.md`（客户端半边 / 模块加载 / 插槽）
- `...\references\practices.md`（扩展点选择、性能、UI 规则）
- `...\references\user-actions.md`、`verification.md`、`mcp-bundle.md`
- `...\templates\decoration\{package.json,cordis.patch.yml,index.js,client.js}`（四文件最小样例）
- `...\templates\mcp\{package.json,cordis.patch.yml}`（纯配置型 bundle）
- `$CORE\dsh-agent-preset\skills\cordis-composition-reference\SKILL.md`（Loader patch 方言 + 包清单）

### 2.2 最小可运行样例（官方模板原文）

`templates\decoration\package.json`：

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

`templates\decoration\cordis.patch.yml`：

```yaml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

`templates\decoration\index.js`（宿主半边，注意它可以是空实现）：

```js
/** Host half of the decoration bundle; the Client module owns the rendering. */
export function apply() {}
```

`templates\decoration\client.js`（浏览器半边，手写的工厂包装）：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() {
      return h('svg', {
        viewBox: '0 0 64 64', width: 48, height: 48,
        'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' },
      }, h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' }));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

要点：**宿主半边与客户端半边是两个独立模块**。`apply()` 为空说明插件可以"只活在浏览器里"——但宿主仍必须挂一行（见 2.4），浏览器半边才会被加载。

### 2.3 `package.json` 的 `dsh` 字段完整语义

类型定义（唯一权威）在 `$CORE\dsh-package-manifest\lib\types\types.d.ts`：

```ts
export interface DshManifest {
    /** Manifest format version, independent of the npm package and Session format versions. */
    manifestVersion?: 1;
    bundle?: DshBundleManifest;
    profile?: DshProfileManifest;
    client?: DshClientManifest;
}
export interface DshBundleManifest {
    /** One patch file path, or an ordered list applied in sequence, each relative to the declaring package root. */
    patch: string | string[];
}
export interface DshProfileManifest {
    /** Ordered bundle layer list, using installed package names. */
    bundles?: string[];
}
export interface DshClientManifest {
    /** Client platform identifier; the Web consumer selects `web`. */
    platform: string;
    /** Informational package-name dependencies, not Cordis service injection. */
    inject?: string[];
    /** Boot phase-one registration barrier; absent means the shared application batch. */
    immediately?: boolean;
    /**
     * Exact module-table requests beyond the implicit client baseline, including
     * subpaths such as `<pkg>/client`; absent means baseline externals only.
     * Type-only imports are erased and create no module request.
     */
    external?: string[];
}
```

同文件还有：`icon`（相对路径，SVG/PNG/JPEG/WebP，≤256 KiB，realpath 后必须仍在包目录内）、`engines.dsh`（SemVer 范围，安装与启动都会校验）、`description`、`private`。

运行时校验代码（`$CORE\dsh-client-modules\lib\index.js`）证实了每个字段的实际用途：

```js
// 摘自 $CORE\dsh-client-modules\lib\index.js（省略了中间的错误分支）
function parseDshClient(pkgName, value) {
    if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
    if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
    const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
    const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
    if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
    ...
}
// ...
const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(sourceKey, null); return null; }
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```

由此得到几条硬约束：**[证据]**

- `dsh.client.platform` **必填**，且只有 `"web"` 会被 Web 前端收下；其它值等于"没有客户端半边"。
- `dsh.client` 存在时 `exports["./client"]` **必须存在**（可以是字符串，也可以是 `{ default: "..." }`），否则启动期直接抛错。
- `dsh.client.inject` 是**包名列表**，只用于模块图排程（保证依赖包的工厂先注册/先物化）+ Cordis 条目组合，**不是** Cordis 服务注入。服务注入是客户端模块自己 `export const inject = ['slots']`。
- `dsh.client.immediately: true` 表示"阶段一预取"（boot 时先加载脚本注册工厂，不物化）；缺省走应用批次。
- `dsh.client.external` 是"超出基线模块表"的精确请求（例如 `<pkg>/client`、动态 chunk），会参与模块图排序；行不能请求自己（会抛 `a row must not declare its own package in dsh.client.external`）。

**两个易被误用的字段**：`@wingsky-1/dsh-notifier` 的 `package.json` 里写了 `dsh.bundle.bannerJs` 和 `dsh.catalog`，但：

- `DshBundleManifest` 里没有 `bannerJs`，`$DIST\lib` 与 `$CORE` 全部 `.js` 里也搜不到 `bannerJs`；
- `dsh.catalog` 同样不在 `DshManifest` 类型里，也没有任何官方读者读取它。

结论：这两个字段在 0.2.0-rc.2 **未被官方实现消费**（可能来自更新/更旧的私有构建链），不要照抄。**[证据 + 未证实其用途]**

### 2.4 客户端入口如何被前端加载（完整链路）

`$CORE\dsh-client-modules\lib\types\index.d.ts` 模块文档把链路说清楚了：

> Node half of the client module system (`dsh.client` dual-face package): scans the host Loader's entries for packages declaring `dsh.client`, composes the `window.__DSH_BOOT__` entry graph ... in module-graph order, serves one-or-more-plugin combo scripts plus their source maps...

分步（每步都有代码证据）：

1. **宿主 Loader 必须先挂一行**。`dsh-client-modules` 只扫描 Loader entries —— 没有 patch 行就没有客户端 bundle。`$CORE\dsh-web-app\cordis.patch.yml` 里那句注释就是写照：

   ```yaml
   # ── browser plugin roster (dsh.client rows; node halves are layer-2 hosts) ──
   ```

2. **扫包 → 定位 bundle**：`resolveMeta()` 读该行包目录的 `package.json`，取 `exports["./client"]` 的绝对路径（`clientPath`）。
3. **拼图**：`orderByModuleGraph()` 按 `external` 依赖拓扑排序；`graphRow()` 生成 `{id, url, rev, inject?, immediately?, external?}`；`bootInjections()` 产出 `<head>` 注入行：先一段内联 `window.__ModuleLoader__ = {mode:"queue", pendingQueue, load(r){...}, create(options){...}}`，再 `<script-preload>` 应用批次、`<script-src>` 阻塞式 bootstrap 批次，最后把图塞进 `window.__DSH_BOOT__`。
4. **URL 形态**：`const PLUGIN_ROUTE = "/plugins"`，`comboSearch()` 拼成
   `??<id>/client.js&rev=<rev>` → `comboReference()` 去掉前导 `/`，所以页面里是**文档相对**的 `plugins/??<pkg>/client.js&rev=...`。多个插件可合并成一个 combo 脚本（受 URL 字节上限分片）。
5. **页面加载**：默认用同源 classic `<script src>`（`ClientModuleCreateOptions.loadBundle` 默认实现），脚本执行时只做**注册**（`window.__ModuleLoader__.load({id, factory})`），不执行任何模块体。
6. **物化**：首次 `import`/`require` 时才 `factory(require) → exports`，并 memoize。工厂内 `require('react')` 走模块表。
7. **失败模式**（loud）：`bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`（id 与包名不一致时会命中）。

**模块表（static seed）基线**：Web 前端的静态表在 `$CORE\dsh-web-frontend\dist\assets\index-5SrrfWpU.js` 里可见（压缩代码，摘其要）：

```js
return{react:Ef,"react/jsx-runtime":If,"react-dom":Rf,"react-dom/client":Df,
"@deepseek-ai/cordis":sf,"@deepseek-ai/dsh-client-store":lh,
"@deepseek-ai/dsh-client-ui-slots":hh,"@deepseek-ai/dsh-client-ui-primitives":sE,
"@deepseek-ai/dsh-client-ui-dockkit":XS}
```

即：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit` 由**外壳单例**提供，`require` 它们不会真的去读 node_modules。

> 注意：`dsh-client-ui-dockkit` 在本机安装里**没有对应包目录**（只在 `dsh-web-frontend/package.json` 的 devDependencies 和外壳 bundle 里出现），说明这批模块是外壳构建期打进去的，插件不应把它们当 npm 依赖解析。

### 2.5 是否需要编译打包？

- **宿主半边：不需要**。官方模板的 `index.js` 就是 3 行 ESM；`$PROFILE\node_modules\dsh-pilot\lib\index.js`、`@linxin666\dsh-web-all\lib\shells\shell.js` 也都是已构建或手写的普通 ESM。
- **客户端半边：必须产出单文件 CJS 工厂包装**。三条真实路线：
  1. 手写（模板做法，几十行组件够用）。
  2. **esbuild + 手写 wrapper**：`dsh-pilot` 的 `scripts.build = "node build.mjs"`，产物就是 `lib/client.js` 里 `window.__ModuleLoader__.load({ id: 'dsh-pilot', factory: (require) => { ... } })`，`react` 走 `require("react")`。
  3. **tsdown + banner/footer**：`dsh-get-balance` 的 `src/client/index.ts` 注释写明：
     > 本文件为纯 ESM 模块，直接导出插件形状 { name, inject, apply }；`window.__ModuleLoader__.load` 工厂包装由 tsdown 的 banner/intro/footer 在构建时生成（见 tsdown.config.ts）。外部依赖（react / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives）构建时保持 external。

- 官方规范对"构建产物纯度"有一条硬约束（`$CORE\dsh-client-ui-settings\lib\types\client\config-form.d.ts` 注释）：
  > the client bundle purity gate forbids cross-plugin value imports and directs cross-plugin collaboration through cordis services (`packages/client/tsdown.client.ts`)

  也就是说：**插件之间只能通过 cordis 服务协作，不能在浏览器包里互相 import 值**；跨包只能用 `import type`（类型合并）。`ui-plugin.md` 也强调"registrant 只 merge 类型契约，运行时从不 import 那个包"。**[证据]**

  该构建器（`packages/client/tsdown.client.ts`）**不在 npm 发布物里**，第三方必须自己实现等价约束。**[证据：`$DIST` 与 `$CORE` 中无此文件/包]**

---

## 3. 服务端（host）插件如何暴露 API 给客户端

### 3.1 四条通路对照

| 通路 | 宿主注册 | 客户端调用 | 信任/鉴权 | 本机真实样例 |
| --- | --- | --- | --- | --- |
| 裸 HTTP 路由 | `ctx.webServer.register({kind,path,handler})` | `fetch('/your/path')` | 无，需自己判 `req.socket.remoteAddress` / Host 头 | `dsh-pilot`、`dsh-get-balance`、`@linxin666/dsh-web-all` |
| 通用 RPC 通道 | `ctx.connection.rpc.handle('/chan', handler)`（或 `intercept('/api', matches, handler)`） | `ctx.connection.rpc.call('/chan', 'endpoint', payload)` | 内建：Host/Origin fence + 浏览器令牌，`peer` 由服务给出 | 宿主侧无第三方样例；**客户端 `rpc.call` 有真实样例**（`@linxin666/dsh-web-all`） |
| 精确 Fetch 路由 | `ctx.connection.fetch.register({path,methods,requestBody,fetch})` | `fetch('/api/<path>')` | 同上（走 `/api` 通道） | 无第三方样例（仅类型契约） |
| 类型化 Remote | 生成 `typert.host.js` + loader 注册 | `ctx.remote.<ns>.<method>()` | Gateway 内建 | 官方 API 包（`dsh-permission-presets` 等） |
| 对话 command（退路） | `ctx.commands.register({name,handler})` | `ctx.remote.commands.execute(sessionId, '/cmd ...')` | 走会话，**会在会话里留 command 节点** | `dsh-get-balance` 的兼容分支 |

### 3.2 裸 HTTP 路由：最小可抄示例

`ctx.webServer` 的契约在 `$CORE\dsh-host-webserver\lib\types\index.d.ts`：

```ts
export interface WebRoute {
    kind: WebRouteKind;                 // 'exact' | 'prefix'
    path: string;                       // 绝对路径，无尾斜杠
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
// register(route): () => void   重复 (kind,path) 会抛；升级路由用 registerUpgrade；兜底用 registerFallback
```

`dsh-pilot` 的宿主半边（`$NM\dsh-pilot\lib\index.js`）是一个自洽的最小范本，含 loopback 校验与 JSON 信封：

```js
var inject = ["webServer", "tools"];
var LOOPBACKS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function apply(ctx) {
  const webServer = ctx.webServer;
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: "prefix",
      path: "/dsh-pilot",
      handler: async (req, res) => {
        const remote = req.socket.remoteAddress ?? "";
        if (!LOOPBACKS.has(remote)) { sendJson(res, 403, { error: "loopback only" }); return; }
        const pathname = new URL(req.url ?? "/", "http://x").pathname;
        const suffix = pathname.slice("/dsh-pilot".length) || "/";
        if (req.method === "GET" && suffix === "/state") sendJson(res, 200, { ...pilot.state() });
        else if (req.method === "POST" && suffix === "/start") { await pilot.withOp(() => pilot.ensure()); sendJson(res, 200, pilot.state()); }
        else sendJson(res, 404, { error: "no such endpoint" });
      }
    }), "dsh-pilot: web routes");
  }
}
```

客户端半边直接 `fetch`（`$NM\dsh-pilot\lib\client.js`）：

```js
async function post(path, body) {
  const res = await fetch(`/dsh-pilot/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {})
  });
  if (!res.ok) throw new Error(`pilot: http ${res.status}`);
  return res.json();
}
```

更完整的工程化写法见 `dsh-get-balance`（TypeScript 源码，`$NM\dsh-get-balance\src\`）：

- `src/host/index.ts`：`webServer.register({kind:'exact', path:'/dsh-balance/api'})`，先跑 `isTrustedApiRequest(headers, webRuntime?.trustedHosts ?? [])` 围栏，再限长读体（1 MiB）、`{ok, value|error}` 信封；注册包在 `try/catch` 里以容忍 HMR 重复注册。
- `src/client/rpc.ts`：优先 `fetch('/dsh-balance/api')`，失败回落 `ctx.remote.commands.execute(sessionId, '/dsh-balance {...}')`。
- 注释里点明选择理由：**走 HTTP 路由不会在会话里产生 command 节点**（页面不会出现调试卡片）。

同一份 `src/host/index.ts` 还示范了"包内静态资源"：宿主只通过 `/plugins/<id>/client.js` 发布插件 bundle，**不会暴露包内其它文件**，所以图标必须自己开路由：

```js
const iconRoute = '/plugins/dsh-get-balance/assets/wallet-money-duotone-128x128.png'
const iconPath = fileURLToPath(new URL('../assets/...png', import.meta.url))
webServer.register({ kind: 'exact', path: iconRoute, handler: async (req, res) => { ... } })
```

> 这句注释是重要事实：**插件包内的 `assets/`、`skins/`、`locale/*.json` 等默认浏览器不可达**，需要自建路由（或内联进 bundle）。**[证据]**

### 3.3 带内建信任的通用 RPC / Fetch（推荐给需要鉴权的写操作）

类型契约在 `$CORE\dsh-client-connection\lib\types\rpc.d.ts`：

```ts
export interface HostConnectionRpc {
    /** Register one authenticated absolute channel prefix. */
    handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>;
    /** Intercept owned endpoints on the shared `/api` channel before its fallback. */
    intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler): () => Promise<void>;
}
export interface HostConnectionFetch {
    register(route: ConnectionFetchRoute): () => Promise<void>;   // path 位于 /api 之下
}
export interface ClientConnectionRpc {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>;
}
```

宿主 `apply` 文档（`$CORE\dsh-client-connection\lib\types\index.d.ts`）明确它负责 `/api` 桥与浏览器鉴权：

> Provides carrier-neutral RPC and Fetch registries. When `webServer` is present, the plugin also mounts the `/api` browser transport with Host/Origin checks and persistent browser authentication.

客户端的真实调用样例（`$NM\@linxin666\dsh-web-all\lib\client.js`）：

```js
const call = async (endpoint, payload) => {
  const result = await connection.rpc.call(CHANNEL, endpoint, payload);
  if (!result.ok) throw new Error(`plugin-installer ${endpoint} failed: ${result.error.code}: ${result.error.message}`);
  return result.value;
};
```

按类型契约构造的最小宿主侧写法（**本机没有第三方先例，标为示例代码**）：

```js
export const inject = ['connection']
export function apply(ctx) {
  ctx.effect(() => ctx.connection.rpc.handle('/my-plugin', async (endpoint, payload, signal, peer) => {
    if (endpoint === 'save') return { ok: true, value: await save(payload) }
    return { ok: false, error: { code: 'not-found', message: endpoint, details: {} } }
  }))
}
```

客户端：

```js
export const inject = ['connection']
export function apply(ctx) {
  const res = await ctx.connection.rpc.call('/my-plugin', 'save', { foo: 1 })
  if (!res.ok) console.error(res.error.code, res.error.message)
}
```

> 注意 `handle()` 的 channel 必须是**绝对通道**（`/xxx`），`intercept` 只能用于 `/api`。这是两条不同的挂载方式：前者由 Connection 生成物理路由，后者在共享 `/api` 通道上抢端点。**[证据：类型注释]**

### 3.4 类型化 Remote（`ctx.remote`）——官方主用，但第三方几乎不可用

链路：

1. 宿主插件里给服务方法打 `@typert` 标记，**构建期**由 `@deepseek-ai/dsh-typert-generator` 生成两个产物：
   - `lib/typert.host.js`（宿主反射 + 调用描述符，`TYPERT` 导出）
   - `lib/typert.remote-client.js`（客户端描述符 + zod 结果 schema）
   样例（`$CORE\dsh-permission-presets\lib\typert.remote-client.js`）：

   ```js
   /* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */
   export const TYPERT_REMOTE = {
     package: '@deepseek-ai/dsh-permission-presets',
     descriptors: [{
       id: '@deepseek-ai/dsh-permission-presets#permissionPresets/catalog',
       service: 'permissionPresets', namespace: 'permissionPresets', method: 'catalog',
       invocation: { kind: 'direct' }, parameters: [],
       result: { mode: 'strict', typeSymbol: '.../client#PermissionCatalog', create: ... },
     }],
   }
   ```

2. 宿主侧由 `dsh-typert-loader` 自动加载：包若 `exports["./typert"]`，entry 挂载时 import 其 `TYPERT` 并 `ctx.typert.register()`，卸载时撤回。文档同时给出人工入口：
   > Manual `ctx.typert.register()` remains available for contributions that do not use a `./typert` artifact (hand-written wire schemas, tests, non-loader compositions).
3. 分发：`TypertGatewayService`（`$CORE\dsh-api-gateway`）把 `typert` 注册表映射成可调用端点，一元调用走 Connection，流走 Gateway 自有 WebSocket mux。
4. 客户端：`dsh-api-remotes` 的 client 半边**静态 import 一长串 `@deepseek-ai/dsh-xxx/remote`**（见 `$CORE\dsh-api-remotes\lib\types\client\index.d.ts` 第 3–63 行），再挂到 `ctx.remote.<namespace>.<method>()`。

结论与限制：**[证据 + 推断]**

- `@deepseek-ai/dsh-typert-generator` **不在本机安装里**（`$CORE` 只有 `dsh-typert-loader` / `-protocol` / `-registry`），是仓库内构建期工具。
- 客户端命名空间是**应用级静态装配**（`dsh-api-remotes` 的 import 列表），第三方无法在不改官方包的前提下把自己的 namespace 加进 `ctx.remote`。
- 因此第三方要"类型化 RPC"只能：手写 `TYPERT`/`TYPERT_REMOTE` 描述符 + `ctx.typert.register()`（宿主侧可行），但客户端侧仍需自己 `connection.rpc.call` 或自建 fetch。**推荐直接用 3.2 / 3.3。**

### 3.5 事件：服务端 → 客户端推送

- 官方做法：在 `$CORE\dsh-api-remotes\lib\types\remote-events.d.ts` 的 `API_REMOTE_FORWARDED_EVENTS` 白名单里登记宿主事件，客户端用 `ctx.remote.$on('<event>')` 订阅。白名单是**静态常量**，第三方加不进去。
- 第三方可行做法（真实样例）：客户端 `ctx.on('connection/reset', ...)`（`@linxin666/dsh-web-all`）重建缓存 + 主动 `fetch` 轮询；`dsh-pilot` 面板就是 2 s 轮询 `/dsh-pilot/state`。
- 若要真推送：`webServer.registerUpgrade({path, handler})` 自己谈 WebSocket/SSE，或 `connection.fetch.register` 一个 streaming 路由（`requestBody: 'streaming'` 也能做响应流）。

---

## 4. 设置页 / 插件页 UI 的接入方式

### 4.1 扩展点总表（全部是 slot）

设置与插件管理相关的插槽契约分散在三个包里，但都在 `SlotMap` 上做声明合并：

| 插槽 key | kind / scope | owner props | 语义 | 声明位置 |
| --- | --- | --- | --- | --- |
| `settings.section` | list / root | `{ close() }` | 设置里一个一级页面；`id` 是导航键，`order` 排位，`label` 是文案（可传函数） | `$CORE\dsh-client-ui-settings\lib\types\client\contract\slots.d.ts` |
| `settings.general.item` | list / root | 空 | 常规设置页里的**一行**偏好（不为一行单开页面时用） | 同上 |
| `settings.plugins.tab` | list / root | 空 | 内置"插件"设置页里的一个 Tab | 同上 |
| `settings.action` | list / root | 空 | 设置面板标题栏动作 | 同上 |
| `settings.onboarding` | list / root | `{stepId, complete, openSection}` | 首次引导步骤 | 同上 |
| `settings.launcher` / `settings.trigger` / `settings.header` / `settings.close` | single / root | 见类型 | 设置入口/标题/关闭等外壳文案位，一般不要碰 | 同上 |
| `plugins.item` | list / root | `{ view: 'summary' \| 'page', form? }` | 插件管理页"官方插件"卡片 + 展开后的配置页 | `$CORE\dsh-client-ui-plugin-manager\lib\types\client\slot-contract.d.ts` |
| `plugins.bundle.config` | keyed / root（key=包名） | `{ view, form? }` | 某个 bundle 自己页上的配置区 | 同上 |
| `plugins.row.config` | keyed / root（key=`<包名>#<行id>`） | `{ view, form? }` | 某一行（插件）的配置页 | 同上 |
| `plugins.detail.actions` / `.badge` / `.section` | list / root | `{ subject }` | 插件详情页的按钮/徽标/小节 | 同上 |
| `plugins.bundle.activation` | keyed / root | `{ packageName, onDismiss, onOpenDetails }` | 启用 bundle 后的引导 | 同上 |

非设置类的常见 UI 面（同样真实存在）：

| key | 用途 | 声明位置 |
| --- | --- | --- |
| `shell.overlay` | 全屏浮层（弹窗/驾驶舱），点击穿透直到自设 pointer-events | `$CORE\dsh-client-ui-layout\lib\types\client\index.d.ts` |
| `sidebar` / `shell.leading` / `main` | 大结构面（慎用，single 是"占位替换"） | 同上 |
| `sidebar.footer.action` | 侧栏底部按钮（常驻入口） | `$CORE\dsh-client-ui-sidebar\lib\types\client\contract\slots.d.ts` |
| `sidebar.panellist` / `sidebar.settings` / `sidebar.toggle.badge` | 侧栏面板列表/设置项/角标 | 同上 |
| `sidebar.right.pane.tab` / `.title` / `sidebar.right.tab.guide(.entry)` / `.menu.item` | 右侧停靠区的页签（GUI 里最接近"dock/taskbar"的面） | `$CORE\dsh-client-ui-sidebar-right\lib\types\client\contract\slots.d.ts` |
| `conversation.composer.dock` / `.bar` / `conversation.input.*` | 输入框周边 | `$CORE\dsh-client-ui-conversation\lib\types\client\contract\slots.d.ts` |
| `conversation.session.header.utilities` | 会话标题栏工具区 | 同上 |
| `conversation.chat.node` | 聊天流里自定义节点（配合 `ctx.uiConversation.events.register()`） | 同上 |

> 关于"taskbar/dock"：**没有名为 taskbar 的插槽**。GUI 的停靠类面是 `sidebar.right.pane.tab`（右侧面板页签）与 `shell.overlay`（自由浮层）；`@deepseek-ai/dsh-client-ui-dockkit` 只是外壳内置的停靠布局库（见 2.4），不是插件扩展点。**[证据 + 推断]**

### 4.2 注册 API 的真实形状

客户端 `ctx.slots` 是 `SlotRegistry`（`$CORE\dsh-client-ui-renderer\lib\types\client\registry.d.ts`）：

```ts
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void;
readonly register: SlotCore['register'];   // (options, component) => disposer
```

- `inject(key, cb)`：**等该插槽被声明后才注册**；声明消失时自动卸载（回调返回的 disposer 被调用），重新声明时再注册。这是官方推荐的唯一写法。
- `register(options, Component)` 的 options 形状取决于 kind：
  - list：`{ name, id, order?, label?, locale?, inject? }`（缺 `id` 抛错）
  - keyed：`{ name, key, ... }`（缺 `key` 抛错）
  - single：`{ name, ... }`（同优先级第二个人注册会抛错，除非给不同 `priority`）
- `register` 返回 disposer，且**自动绑定调用方 fiber**（`ctx.slots` 的 `this.ctx` 在调用点绑定到调用者 context），插件卸载即回收。
- `inject` 是"业务面注入"：`{ name, id, order, label, locale, inject: () => businessFace }`，组件通过 props 拿到这个 face。
- 组件崩溃不会白屏整页，只会让该插槽条目退出（控制台 `slot entry crashed in '<slot>'`）。

### 4.3 `settings.section`：可直接照抄的最小设置页

第三方真实样例（`dsh-get-balance`，`$NM\dsh-get-balance\src\client\plugin.tsx`）：

```tsx
const SECTION_ID = 'dsh-get-balance'

slots.inject('settings.section', () => slots.register(
  {
    name: 'settings.section',
    id: SECTION_ID,
    order: 42,
    label: () => t('balanceBtn'),      // label 可传 thunk，随语言变化重注册
  },
  (props: Record<string, unknown>) => (
    <PluginSettingsPage
      onOpen={() => modalStore.open(true)}
      close={typeof props.close === 'function' ? (props.close as () => void) : () => {}}
    />
  ),
))
```

页面本体（`src/client/components/PluginSettingsPage.tsx`）只做两件事：承载开关 + 打开主弹框；`close()` 由宿主通过 owner props 传入。

另一条真实路径：把配置页挂到**内置"插件"设置页的某个 Tab**（官方 `dsh-client-ui-settings-web-search`，`$CORE\...\lib\client.js`）：

```js
ctx.effect(() => ctx.configForms.whileServed([WEB_SEARCH_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
  name: "plugins.item",
  id: "web-search",
  order: 40,
  label: () => t("title"),
  locale: NS,
  inject: () => card.inject(),
}, WebSearchCard))));
```

`whileServed(namespaces, register)` 的语义很适合第三方：**只有当宿主真的提供了这些 settings namespace 时才注册 UI**，部署里没这个插件就完全不留痕迹。

### 4.4 配置页的数据来源（`ConfigPageForm`）

插件管理页会把 `{ view, form }` 传给 `plugins.*.config` 的贡献者：

```ts
export interface ConfigPageForm {
    readonly state: ConfigFormSnapshot<Record<string, unknown>>;   // 宿主已接受的值
    readonly mutate: ConfigForm<Record<string, unknown>>['mutate']; // 带 revision 的整段写
}
```

`view: 'summary'` 只渲染一行摘要；`view: 'page'` 渲染带保存按钮的表单。这是"插件自带配置页"的最省事做法（不用自己开 HTTP）。

### 4.5 UI 硬性规范（违反会看起来"不像宿主"或直接崩）

摘自 `...\references\practices.md` 与 `ui-plugin.md`：**[证据]**

- **不要** `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 Harness Client 包作为模块；`dsh.client.inject` 只用于激活排序，仍允许。理由：包随时变、纯 JS 插件没有类型检查、组件抛错会让插槽条目消失。
- 样式只用主题 token（`--dsw-alias-*`），字面色只用于插画。
- **不要**用 Host 提供 HTML + iframe 的方式做页面（拿不到主题/locale/明暗切换）。
- 不要写 `document.body`、不要替换 `#root`、不要读别的插件的 DOM/样式。
- 资源（样式、定时器、监听器）在 `apply` 里用 `ctx.effect` / `ctx.on` 注册并返回清理函数。
- 文案走客户端 locale 服务（`ctx.locale.register(ns, {zh,en})` + `ctx.locale.bind(ns)`）。

---

## 5. 配置持久化

### 5.1 三层：schema 声明 → patch 覆盖 → 运行期表单

**(a) 插件声明 `Config`（schemastery）**，`$CORE\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md`：

> `index.js` exports one of these forms; do not mix them:
>
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - A service class as the default export.
> ... A plugin that declares `Config` validates the row's `config` at activation.

最小写法（`dsh-get-balance\src\host\index.ts`）：

```ts
import Schema from '@deepseek-ai/schemastery'
export const Config = Schema.object({})
export function apply(ctx: Context, _config: Record<string, never>) { ... }
```

带字段 + 热更新字段（官方 `dsh-client-ui-settings` 的 `Config`，`$CORE\...\lib\types\index.d.ts`）：

```ts
import z from '@deepseek-ai/schemastery';
export interface Config {
    /** Whether developer tools are enabled. */
    enabled: Volatile<boolean>;
}
export declare const Config: z<...>;
```

`volatile` 来自 schemastery（`$CORE\schemastery\lib\types\index.d.ts`）：

```ts
volatile(): Schema<..., 'volatile-defined'>;
type SchemaOutput<T, M> = M extends 'volatile' ? Volatile<T | undefined> : M extends 'volatile-defined' ? Volatile<T> : T;
```

`Volatile<T>` 是 `{ get(): T }`（cosmokit）。宿主侧 `dsh-settings\lib\types\schema.d.ts` 的 `volatileForm()` / `isVolatilePath()` 决定了"哪些字段可以不重挂插件就地改"：

> Select fields whose nearest volatile ancestor makes them editable without remounting.

**(b) `cordis.patch.yml` 覆盖语义** —— 官方的 Loader 方言（`cordis-composition-reference\SKILL.md`）：

> - `insert: [rows]` appends rows; with an `id` naming an existing `group: true` row, the rows are appended inside that group's `config` list.
> - A patch with an `id` and no `insert` targets the existing row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale, never deep-merged, so restate every field the row needs. A truthy `name` asserts the existing plugin name rather than renaming it.
> - Non-insert patches without a nonempty `id`, and targets that match no row, are warned about and skipped.
>
> A row has `id`, `name` (the plugin package specifier...), optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`.
>
> - `!!js` scalars are Loader expressions... evaluated after the row's declared injections activate, against that plugin's context (`ctx.<service>`).

真实用户层样例（`$PROFILE\cordis.patch.yml`），两种用法都在：

```yaml
# 1) 覆盖已有行的 config（注意：必须重述所有键，不是深合并）
- id: web-runtime
  config:
    openBrowser: true
    printUrl: true
    surfaceContext: true
    trustedHosts: !!js ctx.webStartup.trustedHosts

# 2) 关掉某行（bundle 自带的行）
- id: ui-theme
  config:
    preference: light
- id: session-log-deepseek
  config:
    enabled: false

# 3) 覆盖某个聚合 bundle 声明的行：把真正的插件包名注入 config.plugin
- id: web-ui-task-board
  name: "@linxin666/dsh-web-all/task-board"
  config:
    plugin: "@linxin666/dsh-client-ui-task-board"
    announceToAgent: true
    enabled: false
```

**"整段替换"这一点在真实 profile 里被反复踩坑并加注释警告**（同上文件第 5–7 行）：

```yaml
# 1) 关闭内建「打开系统默认浏览器」：patch 会整行替换 web-runtime 的 config，
#    故必须重述原本由 bundle 提供的所有键（printUrl / surfaceContext / trustedHosts）。
```

**(c) 运行期读写：`ctx.settings`（`SettingsForms`）**，`$CORE\dsh-settings\lib\types\index.d.ts`：

```ts
describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[];   // 读所有行的 schema + 当前值 + revision
update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
replace(ns: string, section: object, expectedRevision?: number): Promise<void>;
mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
configure(presentation: { auto?: boolean }, owner?: Fiber): () => void;   // 本实例的自动页策略
get writable(): boolean;
```

- `ns` 是 **profile entry id**（行 id），不是包名。
- 写入用 `expectedRevision` 做乐观锁，冲突抛 `SettingsConflictError`（`code = 'SETTINGS_CONFLICT'`）。
- 秘钥字段用 `role('secret')` 声明，`describe` 默认脱敏，`mutate` 才是"只改一个路径、不重述整段"的正确姿势（避免把脱敏后缺失的 secret 写回去清空）。
- `autoGenerate` 会随 descriptor 下发（"Generate a page if no custom page is registered for this instance"）。

**(d) 变更通知**：

```ts
'settings/document-updated'(ns: SettingsNamespace, revision: number): void;   // @mode emit
```

该事件在 `API_REMOTE_FORWARDED_EVENTS` 白名单里，所以客户端可以 `ctx.remote.$on('settings/document-updated', ...)`（`@linxin666/dsh-web-all` 就是这么做的）。客户端不自己 fold，走镜像：`SettingsDescribeMirror`（`$CORE\dsh-client-ui-settings\lib\types\client\settings-mirror.d.ts`）—— 唯一的 `settings.describe` 读者，写回后用 `acceptView()` 就地折叠，避免二次拉取。

**(e) 客户端读写的门面：`ctx.configForms`**（`config-form.d.ts`）：

```ts
class ConfigForms extends Service {
  get<T>(entryId: string): ConfigForm<T>;                 // 某行的值与写队列（set/unset/mutate）
  describe(): SettingsDescribeFace;                        // 跨命名空间只读面
  whileServed(namespaces, register): () => void;           // 仅有该 ns 时才注册 UI
}
```

`ConfigFormController` 的注释解释了 persist 策略：`'host' | 'memory'`，非 loopback 页面可能只留进程内。

**关于"自动生成设置页"**：`autoGenerate` 只出现在宿主 `dsh-settings`、`dsh-api-settings-controller` 与线格式类型里，**本机所有客户端包都没有消费它的代码**（`grep autoGenerate` 无客户端命中）。所以「声明 Config 就白送一个可视化设置页」在 0.2.0-rc.2 的 Web 端**没有实现证据**；要么用 `plugins.row.config` 的 `form`（插件管理页现成表单），要么自己写 `settings.section` 页面。**[证据 + 未证实]**

### 5.2 插件私有数据（不放进 Config 的部分）

两种真实做法：

1. **`$DSH_HOME/<plugin>.json` 自管文件**：`dsh-get-balance` 用 `$DSH_HOME/dsh-get-balance.json`（`src/host/config-file.ts`），并做一次性迁移（旧 `settings.yaml` 段 → 新文件）；本机可见 `C:\Users\wangyi\.dsh\dsh-get-balance-series-store.json`、`dsh-ssh.json`、`pet.json`、`skin-center-active.json` 等同族产物。
2. **`ctx.storage` / `dsh-storage-json`**：base patch 里 `storage-json` 的 `root: !!js dshHomePath('storages')`，即 `$DSH_HOME/storages`（本机存在该目录）。

---

## 6. 会话数据、skills、AGENTS.md

### 6.1 会话存储

根目录来自 base bundle（`$CORE\dsh-base\cordis.patch.yml`）：

```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
```

即 `$DSH_HOME/sessions`（本机 `C:\Users\wangyi\.dsh\sessions`）。布局（`$CORE\dsh-session-persistence-jsonl\README.zh.md`）：

```text
<root>/
  <可读的项目目录>            # 规范化后的 cwd，例如 --D-object-agents-sync--
    <sessionId>/
      session.v4.jsonl.zstd   # 当前代际；历史代际 session.jsonl.zstd / session.v1..v3.jsonl.zstd
      session.vN.jsonl        # compression: 'none' 时的原始文本
```

本机实测（会话 id 打码）：

```text
C:\Users\wangyi\.dsh\sessions\--D-object-agents-sync--\session-<uuid>\session.v4.jsonl.zstd   202089 字节
```

要点：**[证据]**

- README 表格写到 v3，实际磁盘是 **v4**，且 `$CORE` 里存在 `dsh-session-format-v3-to-v4` 包 —— 说明 v4 是 0.2.0-rc.2 的当前代际，README 该处略滞后。
- 项目目录名由**规范化 cwd 单射转义**得到（`:`/`\`/空格 等替换为 `-` 和 `~00XX`），保证可读且无遍历/冲突。
- 物理编码默认 **zstd 帧**：header 一行一帧 + 每个 append 批次一帧（带校验和）；`compression: 'none'` 则退化为逐行 JSONL 纯文本。
- 语义：header（SessionHeader，含 id/cwd/createdAt/isSeeded）+ 连续 `SessionEvent` 行；撕裂尾部会被截断修复（`truncateTornTail`）；同 session 目录有内核级写锁（`SessionWriteLease`），进程死亡自动释放。
- 只在首次 append/flush 才落盘（lazy materialize）。

**对插件作者的含义**：想读会话历史不要自己解析 zstd 文件，走 `ctx.sessionPersistence` / `ctx.sessions` / `ctx.sessionQuery`；项目里的第三方插件普遍读 `ctx.sessions.binding(id).eventSource` 或 `ctx.remote.session.*`。**[推断，基于接口存在]**

### 6.2 skills 加载路径

`$CORE\dsh-skill-filesystem\lib\index.js` 的 `roots(cwd)`（顺序即优先级，rank 常量决定覆盖关系）：

| 顺序 | 路径 | source | 备注 |
| --- | --- | --- | --- |
| 1 | `<projectRoot>/.dsh/skills` | `project-dsh` | 项目根由 `.git` 等 marker 上溯确定 |
| 2 | `<projectRoot>/.agents/skills` | `project-agents` | |
| 3 | `config.customSkillDirs[]` | `custom` | 按配置顺序 |
| 4 | `$DSH_HOME/skills`（`~/.dsh/skills`） | `user-dsh` | `skipSystem: true` |
| 5 | `<agentsHome>/skills`，默认 `~/.agents/skills` 或 `$DSH_AGENTS_HOME/skills` | `user-agents` | |
| 6 | `bundledSkillDir`（`$DSH_BUNDLED_SKILL_DIR`） | `bundled` | `trustedHost: true` |

每个 skill = 一个目录（含 `SKILL.md`，YAML frontmatter + 正文）或扁平 `.md`；`watch: true` 时 chokidar 监听变更（有 `watchUsePolling`、稳定性阈值等开关）。

**注意**：Web profile 在 bundle 层把宿主级 `skill-filesystem` 与 `tool-skill` 行 `disabled: true` 了（`$CORE\dsh-web-app\cordis.patch.yml` 第 475–489 行，注释说明"presets own local discovery"），实际由 **agent preset** 层挂载。所以"改 profile patch 加 skill 根"在 Web 上未必生效，要看 preset。**[证据]**

### 6.3 AGENTS.md 加载路径

`$CORE\dsh-agent-instructions\lib\index.js`：

```js
const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.local.md", "CLAUDE.local.md"];
const USER_GLOBAL_FILE = "AGENTS.md";
// ...
const userGlobal = join(config.dshHome, USER_GLOBAL_FILE);
```

- 用户级：`$DSH_HOME/AGENTS.md`（本机 `C:\Users\wangyi\.dsh\AGENTS.md`，展示名 `~/.dsh/AGENTS.md`）。
- 项目级：从 cwd 上溯到 `.git` 定项目根，然后按目录层级找 `AGENTS.md` / `CLAUDE.md`，外加 `.local.md` 覆盖层（`AGENTS.local.md` / `CLAUDE.local.md`）。
- 加载时机：baseline 在第一次请求前进入持久上下文；之后**由 fs 工具的读写触碰**驱动嵌套/新增/删除指令的增量同步（`probeScopeInstruction` / `candidateScopeKey`）。
- 单文件上限 `DEFAULT_MAX_SOURCE_BYTES = 1048576`（1 MiB）。

---

## 7. 本地开发与调试

### 7.1 profile 的结构

`$PROFILE` 实测内容：

```text
package.json          # dependencies + dsh.profile.bundles（顺序即层序）
cordis.patch.yml      # 用户 patch 层（最后叠加，除 --patch）
cordis.yml            # 空 entry 列表，仅占位（注释明说"编辑 cordis.patch.yml"）
pnpm-workspace.yaml   # packages: ['.'], nodeLinker: hoisted, allowBuilds
pnpm.cmd / .npmrc     # store-dir 指向 pnpm v10 store
compatibility.json    # 版本豁免记录（{ "<pkg>@<ver>": ["<dsh ver>", ...] }）
.plugin-manager/logs/operation-*/pnpm.log   # 每次插件操作的 pnpm 日志
node_modules/         # hoisted 安装
plugins/              # 本机为空目录
```

`package.json` 的两段关键内容：

```json
"dependencies": { "dsh-pilot": "github:guo6x/dsh-pilot#9103a2d..." },
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@linxin666/dsh-web-all",
  "dsh-builtin-toggles",
  "dsh-session-delete",
  "dsh-skill-fuzzy",
  "dsh-pilot"
] } }
```

`bundles` **顺序即 patch 层顺序**，`dsh-base` 与 `dsh-web-app` 必须在前。

### 7.2 把本地插件挂进 profile

三条路，由粗到细：

1. **直接改依赖 + 装**（不走 dsh 也行）：

   ```powershell
   cd C:\Users\wangyi\.dsh\profiles\web
   pnpm add file:D:\work\my-plugin        # 或 link:../my-plugin（不复制、符号链接，改代码即生效）
   ```

   然后把包名加进 `package.json` 的 `dsh.profile.bundles`（或用下面第 3 条的 patch insert）。

2. **`dsh plugin` 转发 pnpm**（会拿 profile 写锁、做兼容性校验、写日志）：

   ```powershell
   dsh plugin --profile web add file:D:/work/my-plugin
   dsh plugin --profile web update my-plugin
   dsh plugin --profile web remove my-plugin
   ```

   证据（`$DIST\lib\plugin-BGnVfe_D.js` + `dsh --help`）：

   ```text
   dsh plugin --profile <name> <pnpm-args...>
   dsh plugin --profile tui add <package>    install a plugin into the tui profile
   ```

   DSH 自己只截获 3 个子命令，其余原样交给 pnpm：
   `allow-version <pkg@ver> --dsh-version <exact> --accept-risk`、`revoke-version`、`version-exemptions`。
   注意：`dsh plugin --profile web --help` **不会**给你 pnpm 的帮助（本次实测直接在取 profile 锁时失败：`EPERM ... package.json.lock`，即 `withFileLock(join(dir,"package.json"), ..., {waitMs:120e3})` 在读档前先建锁文件）。

3. **纯 patch insert（不动 bundles 列表）**：在 `$PROFILE\cordis.patch.yml` 里

   ```yaml
   - insert:
       - id: my-local-plugin
         name: '@local/my-decoration'
         config: {}
   ```

   适合"包里已有依赖、只想挂一行"的场景；`id` 冲突或目标不存在会被 warn 后跳过。

**git 依赖的坑**（CLI 里写死了提示）：

> `dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in <profile>/pnpm-workspace.yaml, then re-run`

本机 `pnpm-workspace.yaml` 里已有 `allowBuilds: { cloudflared, cpu-features, node-pty, ssh2 }`，`package.json` 里还有 `pnpm.onlyBuiltDependencies` 同名单。**新插件若带 postinstall/prepare 构建，必须加进这里**，否则装完是坏包。**[证据]**

### 7.3 一个 profile 里塞多个插件：聚合 bundle 模式

`@linxin666/dsh-web-all` 是很好的工程样板（也可直接用作"一次发布多个客户端插件"的模板）：

- 一个包，`cordis.patch.yml` 里为每个家族插一行；
- 每个子路径导出都指向同一个 shell：`"./task-board": "./lib/shells/shell.js"`；
- 行的 config 只写 `plugin: '@linxin666/dsh-client-ui-task-board'`；
- shell 的 `apply(ctx, config)` 用 `await import(spec)` 动态挂载真正的包，失败时 `recordDegraded(spec, "import"|"shape", err)` 记录而不拖垮整棵树；
- 用 loopback 围栏的 `/api/dsh-web-all/degraded` 路由把降级状态给前端读；
- 用 `disabled: true` 让部分行默认关闭（用户在插件管理页点开才启用，用户层写 `disabled: false` 覆盖）。

其 `Config` 是 `Schema.any().volatile()` —— 因为每行的 config 形状不同（`spec` + 真插件自己的字段）。

### 7.4 HMR：哪些改动不用重启

- **宿主配置 / 宿主 JS**：`dsh-hmr` 监听 profile manifest 与 patch 文件，"通过统一串行重载重新组合所有层"（`$DIST\README.zh.md` 第 37 行）。`Hmr` 的 `watchConfig(filename, refresh)` 会把配置刷新排进与模块替换同一条队列。
- **客户端 bundle**：`dsh-client-hmr` 是"Web SSE transport for page-owned client entry reconciliation and rebuilt code replacement"。宿主 `ClientModuleRegistry.rebuilt(id)` 是"the only entry point through which build changes reach the graph"，之后页面侧 `invalidate(id, rev)` + `prefetch/import` 拉新脚本。前提：`$CORE\dsh-web-app\cordis.patch.yml` 里挂着 `client-hmr` 行，且**有东西真的在重写 bundle**（注释点名 `pnpm run dev:web`）。
- 官方明确写了**替换已装包需要重启**（`host-plugin.md`）：
  > Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation. Do not infer updated browser code from an unchanged slot id.

实践建议：本地开发用 `link:` + 自己的 `tsdown --watch` / `esbuild --watch` 重写 `lib/client.js`；改宿主 `lib/index.js` 靠 dsh-hmr 重载；改依赖版本必须重启。**[证据 + 推断]**

### 7.5 自检与排障（只读命令）

```powershell
dsh --version
dsh --help
dsh --profile web --dump-config           # 打印组合后的条目树（含每行 id/name/config/disabled）
dsh --profile web --dump-default-config   # 不含用户层与 --patch
dsh --profile web --dump-config-schema    # 打印 entry/patch 的 JSON Schema（检查不可信插件前先读安全说明）
dsh plugin --profile web version-exemptions
```

`--dump-config` 是排查"我插的行到底有没有进去、被谁覆盖"的首选；`--dump-config-schema` 可以在**不挂载**插件的前提下看它的 Config schema。**[证据]**

运行时排障要点：

- 客户端插槽条目崩了 → 控制台 `slot entry crashed in '<slot>'`，只有该条目消失，不是白屏。
- bundle 注册 id 不匹配 → `bundle <url> loaded without registering "<id>" via __ModuleLoader__.load`。
- `dsh.client` 写了但没 `exports["./client"]` → 启动期抛 `declares dsh.client but exports no "./client" bundle`。
- 版本不兼容 → 启动/安装时按 `dsh.engines.dsh` 校验，输出 `dsh: to accept the risk, run: dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk`；豁免落在 `compatibility.json`。
- 插件操作失败 → `dsh: plugin command failed; diagnostics: <logPath>`，实际是 `$PROFILE\.plugin-manager\logs\operation-*\pnpm.log`。

---

## 8. 附录

### 8.1 客户端可注入的 cordis 服务（从各包 Context 声明合并提取）

| 服务 | 类型 | 提供方 |
| --- | --- | --- |
| `slots` | `SlotRegistry` | `dsh-client-ui-renderer` |
| `locale` | `LocaleRuntime` | `dsh-client-locale` |
| `remote` | `ClientRemote` | `dsh-api-remotes` / `dsh-api-gateway` |
| `configForms` | `ConfigForms` | `dsh-client-ui-settings` |
| `settingsSchema` | `SettingsSchemaService` | `dsh-client-ui-settings` |
| `connection` | `ConnectionHandle`（`rpc` / `generation` / `isLoopback`） | `dsh-client-connection` |
| `modules` | `ClientModuleLoader` | `dsh-client-modules` |
| `theme` | `ThemeRuntime` | `dsh-client-ui-theme` |
| `layout` | `ILayout` | `dsh-client-ui-layout` |
| `conversation` / `uiConversation` | `IConversation` / `UiConversation` | `dsh-client-ui-conversation` |
| `uiRenderer` | `UiRendererService` | `dsh-client-ui-renderer` |
| `uiSession` / `uiWorkspace` | `UiSession` / `UiWorkspace` | `dsh-client-ui-session` / `-workspace` |
| `sessions` / `workspaces` / `jobs` / `webTerminals` | 各 API controller 面 | `dsh-api-*-controller` |
| `shortcuts` | `Shortcuts` | `dsh-client-shortcuts` |
| `sidebarRight` / `sidebarRightTabs` | 控制器 / 注册表 | `dsh-client-ui-sidebar-right` |
| `inputTriggers` / `commandUi` / `feedbackUi` / `userQuestionPanels` | 各 UI 服务 | 对应 `dsh-client-ui-*` |
| `pluginNavigation` | `{ openBundle(pkg) }` | `dsh-client-ui-plugin-manager` |
| `resources` / `fileUpload` / `documentPreviews` / `modelDirectories` / `chatFileMentions` / `sessionLogDownload` / `productAnalytics` | 各域服务 | 对应 `dsh-client-*` |
| `cordisInspect` / `dynamicCordisRunner` | 自省 / 动态插件 | `dsh-cordis-client-runner` |

### 8.2 宿主侧常用服务（第三方插件最常注入）

`webServer`（HTTP/升级/兜底/索引注入）、`connection`（rpc/fetch）、`commands`、`tools`、`settings`、`skills`、`sessionPersistence`、`sessions`、`storage`、`credentials`、`shell`、`typert`、`loader`、`hmr`、`webRuntime`（`trustedHosts` 等部署事实）。

获取方式两种：模块级 `export const inject = ['webServer']`（硬依赖，缺失则插件不激活），或 `ctx.get('webServer')`（软依赖，缺失时降级）。`dsh-get-balance` 的注释解释了为什么后者更安全：

> credentials 不在 apply 时抓取，改为每次 op 请求时懒取：宿主的 credentials 服务可能晚于本插件启动，捕获一次会永久拿不到。

### 8.3 关键文件索引

| 主题 | 路径 |
| --- | --- |
| CLI 帮助/语义 | `$DIST\README.zh.md`、`$DIST\lib\bin.js`、`$DIST\lib\plugin-BGnVfe_D.js` |
| `dsh` 字段类型 | `$CORE\dsh-package-manifest\lib\types\types.d.ts` |
| 客户端模块系统 | `$CORE\dsh-client-modules\lib\types\index.d.ts`、`...\lib\types\client\manifest.d.ts`、`...\lib\index.js` |
| 模块表基线 | `$CORE\dsh-web-frontend\dist\assets\index-5SrrwWpU.js` |
| 插槽核心 | `$CORE\dsh-client-ui-slots\lib\types\index.d.ts`、`$CORE\dsh-client-ui-renderer\lib\types\client\registry.d.ts` |
| 设置插槽契约 | `$CORE\dsh-client-ui-settings\lib\types\client\contract\slots.d.ts` |
| 插件页插槽契约 | `$CORE\dsh-client-ui-plugin-manager\lib\types\client\slot-contract.d.ts` |
| settings 宿主服务 | `$CORE\dsh-settings\lib\types\index.d.ts`、`...\types.d.ts`、`...\redact.d.ts` |
| settings 客户端面 | `$CORE\dsh-client-ui-settings\lib\types\client\{config-form,schema,settings-mirror}.d.ts` |
| HTTP 服务 | `$CORE\dsh-host-webserver\lib\types\index.d.ts` |
| 连接/RPC | `$CORE\dsh-client-connection\lib\types\rpc.d.ts`、`rpc-host.d.ts`、`api-path.d.ts` |
| Gateway/Remote | `$CORE\dsh-api-gateway\lib\types\index.d.ts`、`$CORE\dsh-api-remotes\lib\types\remote-events.d.ts` |
| Typert | `$CORE\dsh-typert-loader\lib\types\index.d.ts`、`$CORE\dsh-typert-registry\lib\types\service.d.ts` |
| 会话存储 | `$CORE\dsh-session-persistence-jsonl\README.zh.md`、`...\lib\types\index.d.ts` |
| 路径助手 | `$CORE\dsh-home-paths\lib\types\index.d.ts` |
| skills | `$CORE\dsh-skill-filesystem\lib\types\index.d.ts`、`...\lib\index.js`（`roots()`） |
| 指令文件 | `$CORE\dsh-agent-instructions\lib\index.js` |
| HMR | `$CORE\dsh-hmr\lib\types\index.d.ts`、`$CORE\dsh-client-hmr\lib\types\client\index.d.ts` |
| 插件编写教程 | `$CORE\dsh-agent-preset\skills\cordis-plugin-development\**` |
| 补丁方言 | `$CORE\dsh-agent-preset\skills\cordis-composition-reference\SKILL.md` |
| 真实插件样例 | `$NM\dsh-pilot`、`$NM\dsh-get-balance`、`$NM\@linxin666\dsh-web-all`、`$NM\@linxin666\dsh-client-ui-skin-center` |

---

## 9. 待确认 / 风险清单

1. **`dsh.bundle.bannerJs`、`dsh.catalog`**：第三方包在用，0.2.0-rc.2 无读者。若将来版本启用，语义未知。**不要依赖**。**[未证实]**
2. **`autoGenerate` 的客户端渲染**：线格式与宿主策略存在，但无客户端消费者。第三方需自备设置页。**[未证实]**
3. **`connection.rpc.handle` 的宿主侧第三方先例**：本机没有。类型契约完整（含 `intercept`/`fetch.register`），但真实可用性未实测。**建议先用 `webServer.register` + 自建围栏，或 `connection.fetch.register` 复用内建鉴权，再逐步迁移。** **[推断]**
4. **`/api` 命名空间冲突**：`@linxin666/dsh-web-all` 把自定义路由注册在 `/api/dsh-web-all/degraded`，与 Connection 的 `/api` 前缀并存（webserver 先查 exact 再按最长 prefix）。这是**观察到的做法**，不是官方推荐路径；新插件建议用自己的前缀（如 `/my-plugin/...`）。**[证据 + 推断]**
5. **会话格式版本**：README 说 v3，磁盘是 v4。以磁盘和 `dsh-session-format-v3-to-v4` 包为准。**[证据]**
6. **Web 上 skill 根**：宿主 `skill-filesystem` 行被 web-app 层禁用，实际根由 agent preset 决定；改 profile patch 可能无效。**[证据]**
7. **`dsh.client.inject` vs 模块 `inject`**：前者是包名（排程），后者是服务名（激活）。混淆会导致"插件永远不激活"或"图排序报环"。**[证据]**
