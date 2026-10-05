# UPGRADE-BACKLOG — echarts-in-chat

这份文档记录插件的升级路线，让"持续升级"可以一轮一轮接着做。所有关于 Hermes
插件 SDK「能不能」的结论，都是**读官方文档和源码得出的**，不是猜的；每条都附了
依据位置。核实所用的 Hermes 源码版本：本机 `~/.hermes/hermes-agent`，
`Hermes Agent vgit.be5e9f7 (2026.9.24) · upstream be5e9f72`。

- 插件仓库：https://github.com/Tommy00748/hermes-plugin-echarts-in-chat
- 官方目录条目：`NousResearch/hermes-agent` → `plugin-catalog/echarts-in-chat.yaml`

---

## 0. 怎么继续升级（每次改完必做）

```bash
cd hermes-plugin-echarts-in-chat

# 1) 单元测试（零依赖，Node 自带测试器）
node --test tests/

# 2) 官方同款校验（目录 CI 用的就是这条，必须全绿）
hermes plugins validate . --install-deps
```

改版本号 → 推送 → 在目录 fork 上把 `plugin-catalog/echarts-in-chat.yaml` 的
`sha` 与 `version` 一起更新 → 向上游开 SHA 升级 PR。**没有 `validate` 全绿就不要推。**

---

## 1. 已完成

### v1 → v2（2026-10 之前）
- **v1**：用 `document.body` MutationObserver 扫消息流、替换 `<pre>`、从 CDN
  用 `<script>` 加载 ECharts。**违反目录准入门禁规则 8**，且运行时加载器根本不解析
  除 `@hermes/plugin-sdk` / `react*` 以外的模块。
- **v2（重写）**：改为官方 SDK 的 `TRANSCRIPT_DIRECTIVE_AREA`（`::echarts{...}`），
  图表用 React 自绘内联 SVG，不加载任何第三方库、不发请求、不注入脚本。保留了
  dataZoom、图例点击筛选、宽度自适应、高度覆盖。

### 本轮（v2.1.0）
1. **悬停 tooltip 升级**：十字准线 + 当前分类高亮带 + 数据点高亮环 + 数值气泡。
   键盘等价：容器可 Tab 聚焦，`←/→`（或 `↑/↓`）移动、`Home/End` 跳首尾、`Esc` 清除；
   触屏等价：点击数据点/切片即固定气泡；另有 `aria-live` 读屏文本与图表下方可见读数行。
2. **可读错误状态**：labels 与 values（或某条 series）数量不一致、数字解析失败、
   `type` 非法、series 段格式错误、无数据、区间过大等，都会在图表位置渲染中文错误块，
   逐条说明"哪一项对不上"（例如 `labels 有 3 个，values 有 4 个`），并保留可复制/可选中
   的原始指令文本。流式渲染未完成时显示"正在读取图表数据…"而不是红色报错。
3. **紧凑数据语法**：`1..12` 整数区间（升序/降序，含 `a..b` 用于 labels 和 series），
   逗号与空白等价分隔；带逗号时 labels 保留多词标签（`"New York, LA"`）。
   旧的 `labels/values/series` 写法完全兼容。
4. **测试护栏**：解析器与渲染层抽出为纯函数并导出；`node --test tests/` 共 31 条用例
   （解析 + 错误状态 + 几何/读屏文本），零依赖。
   *说明*：Desktop 插件**不能** import 同目录的兄弟文件（相对路径不被加载器允许），
   所以解析器只能留在 `desktop/plugin.js`；测试用"改写三个 import 为桩模块后动态加载
   真实源码"的方式跑，见 `tests/load-plugin.mjs`。
5. 本文件。

---

## 2. SDK 能力边界核实结论（重要）

> 结论先行：这个插件目前**只能**在消息流里用 directive 槽位渲染；读文件、发请求、
> 导出图片都**没有官方 SDK 封装**。任何绕过都等于放弃"规则 8 合规"，会被目录拒。

### ① 插件能不能读工作目录文件？——**不能（直接）；可经 Python 后端间接读**
- SDK 的 OS 门只有四个动作：`ctx.os.notify` / `openExternal` / `revealPath` /
  `writeClipboard`，没有读文件。
  依据：`website/docs/developer-guide/desktop-plugin-sdk.md:942-946`、`:1063-1096`。
- SDK 导出清单里没有任何 `readFile` / `read` 类 API。
  依据：同文件「SDK exports at a glance」（`:1603-1616`）与
  `apps/desktop/src/sdk/index.ts`（`captureGatewayFileDownload` 在 `:1949`，
  纯下载方向）。
- 想 `import 'node:fs'` 会被两层拒绝：加载器 import 白名单
  （`apps/desktop/src/contrib/runtime-loader.ts:339` `unsupportedImports`）和准入
  lint（`hermes_cli/plugin_validate_desktop.py:22-45` 的
  `dynamic import outside the SDK` / `remote import outside the SDK`）。
- **间接路径**：插件可以带一个 Python 后端 `dashboard/plugin_api.py`，它跑在网关进程里
  能读网关主机的文件，再通过 `ctx.rest` 把数据交给桌面端。
  依据：`website/docs/developer-guide/desktop-plugin-sdk.md:1344-1455`（尤其 `:1450`
  "Backend code runs inside the gateway process, so it can import from the
  hermes-agent codebase directly"）。代价：需要 Python 后端、要被加进
  `plugins.enabled`，本插件目前是 `capabilities: []` 的纯前端包。
- 核心自带的 `::preview{file="…"}` 能读工作区 HTML 文件，但那是**核心**能力，
  不是给插件用的钩子。

### ② 能不能发网络请求？——**技术能（渲染进程全局 `fetch`），但没有 SDK 封装**
- SDK 里 `host.request` 只走网关 JSON-RPC，`ctx.rest` 只能打自己的命名空间
  `/api/plugins/<id>`，都不是任意 URL。
  依据：`website/docs/developer-guide/desktop-plugin-sdk.md:954-960`、
  `:1374-1395`。
- 准入 lint 的禁止清单里**没有** `fetch`（只有原型补丁 / eval / 非 SDK import /
  脚本注入 / `document.body` 观察 / `data-*` 查询）。
  依据：`hermes_cli/plugin_validate_desktop.py:22-45`。
- 展示外部内容有官方件 `SandboxedFrame`（沙箱 iframe，不透明源）。
  依据：`website/docs/developer-guide/desktop-plugin-sdk.md:695-737`。
- **判断**：真要用 fetch/外部源，必须改 disclosure（声明网络行为）并接受人工审核。
  本轮**没有**引入任何网络行为，disclosure 保持"无网络"。

### ③ 能不能导出/下载图片？——**不能直接"生成并下载 PNG"**
- 唯一的下载向 API 是 `captureGatewayFileDownload()`：它捕获的是"网关文件另存动作"，
  只能配一个后端已落盘的文件路径、且必须由用户显式点击触发。
  依据：`website/docs/developer-guide/desktop-plugin-sdk.md:48-56`。
- `ctx.os` 没有 `saveFile` / `writeFile`；只有 `writeClipboard`（可把 SVG 源码或
  data URL 当**文本**复制到剪贴板）。
  依据：同文件 `:942-946`。
- **可行路径**（工作量见下）：A. 走 Python 后端生成 PNG 落盘 + `captureGatewayFileDownload`；
  B. 只提供"复制 SVG 源码"到剪贴板（客户端即可，零风险）。

### ④ 有没有「代码块渲染器」钩子？——**没有**
- 消息流里唯一的官方插件槽位是 `TRANSCRIPT_DIRECTIVE_AREA`
  (`'transcript.directives'`)。它由 `::name{...}` 指令寻址，**不是**围栏代码块
  ```` ```echarts ````。
  依据：`apps/desktop/src/lib/transcript-directives.ts:29`、
  `website/docs/developer-guide/desktop-plugin-sdk.md:747-800`。
- 围栏代码块会被核心的 artifact 启发式"提升"（core 行为，不可插件化替换）。
- **可以拿去开 issue 的诉求**：希望 SDK 暴露一个"围栏语言 → 渲染器"的注册钩子
  （例如 `ctx.register({ area: TRANSCRIPT_CODE_BLOCK_AREA, data: { language: 'echarts', render } })`），
  让插件能接住 ```` ```echarts ```` 并内联渲染，而不必让模型改写 `::echarts{...}`。
  这属于**上游新能力**，不是本仓库能自己解决的。

### ⑤ 有没有其它能在消息流里渲染内容的槽位？——**没有，只有 directive**
- 全量 slot 常量（源码实证）：
  `ROUTES_AREA`、`SIDEBAR_NAV_AREA`、`SIDEBAR_PROFILE_GROUP_HEADER_AREA`、
  `WORKSPACE_PAGE_HEADER_AREA`（`apps/desktop/src/app/routes.ts:88,128,148,271`）；
  `PANES_AREA`、`STATUSBAR_AREAS`、`TITLEBAR_AREAS`（`apps/desktop/src/sdk/index.ts:1968-1974`）；
  `PALETTE_AREA`（`apps/desktop/src/app/command-palette/contrib.ts:10`）；
  `COMPOSER_AREAS`（`apps/desktop/src/app/chat/composer/contrib.ts:31`）；
  `APPEARANCE_AREAS`（`apps/desktop/src/app/settings/appearance-contrib.tsx:14`）；
  `KEYBINDS_AREA`（`apps/desktop/src/lib/keybinds/actions.ts:238`）；
  `SESSION_ROW_AREAS`（`apps/desktop/src/lib/session-row-slots.ts:19`）；
  `CHAT_EMPTY_AREA`（`apps/desktop/src/lib/chat-empty.ts:22`）；
  `THEMES_AREA`（`apps/desktop/src/themes/user-themes.ts:132`）；
  `SIDEBAR_NAV_PREFS_AREA`（`apps/desktop/src/store/sidebar-nav.ts:18`）。
- 其中与"消息流"相关的：**只有 `TRANSCRIPT_DIRECTIVE_AREA`**。
  `CHAT_EMPTY_AREA` 是空会话占位，不是逐条消息；`COMPOSER_AREAS` 在输入框周围，
  不在消息流里。核心的 `::preview` 也是 directive 的一种消费方。

---

## 3. 待做项（按价值排序）

| # | 待做项 | 可行性 | 依据 | 粗估工作量 |
|---|--------|--------|------|-----------|
| 1 | **更多图表类型**：area（面积）、stacked bar（堆叠柱）、scatter（散点）、显式 donut | 能（纯客户端） | 绝不引入外部库；donut 其实已实现（饼图内径 `radius*0.55`） | area 0.5d；stacked 1d；scatter 1.5d（需要新的点对/双数值语法） |
| 2 | **大数据降采样**：分类 > 500 时按桶聚合或抽稀，避免 SVG 节点爆炸 | 能（纯客户端） | 本插件自绘，节点数完全可控；已有 `MAX_CATEGORIES=2000` 硬上限 | 0.5d |
| 3 | **懒渲染**：图表不在视口内时不画（`IntersectionObserver`），长消息里多张图更省 | 能（纯客户端） | 只观察自己的元素，不碰核心 UI，合规 | 0.5d |
| 4 | **色盲友好调色**：加 `palette="cb"`（Okabe–Ito 8 色）开关；明暗主题现已自动跟随 `--ui-*` | 能（纯客户端） | 现在颜色全部来自主题变量，符合"禁止硬编码颜色" | 0.5-1d |
| 5 | **复制 SVG（轻量导出）**：把当前图复制成 SVG 源码/文本到剪贴板 | 能（纯客户端） | SDK 只有 `writeClipboard`，且 directive 组件拿不到 `ctx`；需用 `navigator.clipboard` | 0.5d |
| 6 | **导出 PNG** | **待定/不能直接** | 无客户端"另存"API；`captureGatewayFileDownload()` 只认后端已落盘文件（doc `:48-56`） | 走 Python 后端：2-3d（含后端、依赖、权限测试） |
| 7 | **数据文件引用**（`::echarts{file="data.csv"}`） | **不能直接；间接可行** | 桌面端读不了工作区文件；需 Python 后端读盘再 `ctx.rest`（doc `:1344-1455`） | 2-3d |
| 8 | **代码块 ```` ```echarts ```` 触发** | **不能（需上游）** | 唯一消息流槽位是指令；无围栏渲染器钩子（见 ④） | 上游特性；本仓库只能开 issue + 写清诉求 |
| 9 | **Web dashboard 版本** | 能，但是另一套 SDK | dashboard 用 `window.__HERMES_PLUGIN_SDK__` + `manifest.json`，与桌面 SDK 不共享（doc `:24-33`） | 3-5d（等价重写） |
| 10 | **改名**（例如去掉 "ECharts" 以免误导） | 能，但要按"新增 + 移除"两步走 | 目录按 `name` 索引；改名=新条目 + 老条目进 `removed.yaml`，用户需重装，老 PR/链接失效 | 1d + 用户侧迁移 |

### 建议的下一轮（价值最高、风险最低）
先做 **#1 area + #2 降采样 + #4 色盲调色**：都是纯客户端、零依赖、不动 disclosure，
一轮就能交付并对读者可见。**#6/#7 只有在确实需要读盘/落盘时才上 Python 后端**，
那会显著扩大插件的披露面（引入后端进程与依赖），要单独评估、单独征求用户同意。

---

## 4. 明确的红线（每轮都别碰）

- 只允许 import `@hermes/plugin-sdk` / `react*`；不碰 `data-slot` / `data-sidebar` /
  `data-tour` / `data-testid`；不注入 `<script>`；不用 `eval` / `new Function`；
  不打原型补丁；不做 `document.body` 级观察。（准入规则 8）
- directive 属性里**不能**出现 `{` `}`，所以不能传任意 JSON，只能走属性列表。
- 不允许自更新代码（准入要求 5）。
- 不改 Hermes 本体；只 fork + PR，不 force push，不动其它仓库。
- 不改插件名（本轮范围外）。

---

_本文件由 v2.1.0 升级轮次生成；能力边界结论对应 Hermes `be5e9f72`。_
