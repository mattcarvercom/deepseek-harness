# Agent Note: Web markdown 渲染 mermaid 图

Status: implemented

[English](2026-09-04-web-mermaid-diagrams.md) | 中文

## Problem

`MarkdownText` 渲染不可信的 GFM 与 TeX 公式，但 ` ```mermaid ` fence 落入 `CodeBlock` 的纯文本臂：shiki 没有 mermaid 语法，所以画出图示的回复只会显示其字面源码。渲染器必须把 fence 源码当作不可信的模型输出、跟随当前配色、不给流式路径增加成本，并且在从不画图的会话中不进入 shell bundle。

## Decision

定稿的 mermaid fence 绘制为内联 SVG；流式 fence 保留普通代码块，与[流式 fence 高亮笔记](2026-08-20-web-streaming-fence-highlight.zh.md)中 TeX 仅定稿渲染的先例一致。

- **`MermaidDiagram`**（`packages/client/ui-primitives/src/markdown/MermaidDiagram.tsx`）在定稿后渲染 fence 源码。它通过 **`loadMermaid()`**（`src/markdown/mermaid.ts`）加载引擎：一个从 shell bundle 切出的动态 import，解析为 mermaid handle。经由本地模块（而不是调用点处的裸说明符）加载，为单元测试提供确定性的桩点——并发 import 的外部化裸说明符在那里不可拦截。
- 每次渲染调用 `initialize({ startOnLoad: false, securityLevel: 'strict', theme })`，再以唯一的 `dsh-mermaid-N` id 调用 `render(id, code)`。`securityLevel: 'strict'` 通过 mermaid 内置的 DOMPurify 通道净化产出的 SVG 并禁用 click 绑定——图源码是不可信的模型输出，否则可能把导航或脚本编码进节点事件中，因此这是必需的。净化后的 SVG 注入由 `--dsw-alias-markdown-code-block` token 着色的卡片；其 `svg` 按列宽缩放（`max-width: 100%; height: auto`）。
- 组件通过 `useSyncExternalStore` 内的 MutationObserver 跟随 `body[data-ds-dark-theme]`，配色翻转时用 mermaid 的 `dark` 或 `default` 主题重渲染，重渲染进行中保留上一张 SVG 而不是回退到源码。
- 解析错误、非 Error 拒绝或惰性分片加载失败时，渲染 locale 拥有的失败说明行（新增 `markdown.mermaid.renderError` label，经由 `MarkdownLabels.mermaid` 字段与全部五个 label 构造器传入）加上代码块中的 fence 源码，并在说明行后原样显示 mermaid 自己的错误信息。
- 定稿卡片右上角有两个操作（locale 拥有的 `markdown.mermaid.copyImage`/`copiedImage` label）。**复制源码**复用代码块的 `writeClipboard` 路径，带同样的 1 秒确认反馈。**复制图片**经由 `src/markdown/mermaid-image.ts` 栅格化已渲染的 `svg`——克隆节点、按其 `viewBox` 定尺寸、作为 `image/svg+xml` object URL 载入 `Image`、绘制到 canvas，再由 `toBlob` 产出 PNG——然后以 `navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])` 写入剪贴板。回退路径降级为下载而非报错：剪贴板写入被拒绝时下载 PNG（`mermaid-diagram.png`），栅格化失败（SVG 无法解码、无 2d 上下文、canvas 无 PNG）时下载独立的 SVG 源码（`mermaid-diagram.svg`）。

## Testing

包测试以桩掉的 loader 界定状态机——jsdom 缺少 mermaid 布局所需的 CSSStyleSheet 构造器与 SVG 几何（`getBBox`），真实引擎无法在那里渲染：成功、加载中、解析错误、字符串拒绝、加载拒绝、挂载即暗色、配色翻转、结果到达前卸载、StrictMode 双重 effect，以及 `renderCode` 的 fence 各臂。另一个 spec 经由接缝加载真实模块以钉住解析。无 key 的 Web 回放 lane 种入一条含一个有效 flowchart 与一个不可解析 fence 的定稿回复，golden（`apps/web/tests/expected/markdown-mermaid/ui.expected.md`）钉住 SVG 的 ARIA 树——即节点标签——失败说明行与回退源码。

## Alternatives considered

**静态 import mermaid。** 把约 1 MB 的引擎放进每个会话都加载的 shell bundle，而大多数回复用不到这个功能。

**流式期间也渲染。** mermaid 的渲染是异步的，且流式中途源码不完整，图示会随每个分片重渲染；TeX 先例是仅定稿渲染。

**带 click 绑定渲染（`securityLevel: 'loose'`）。** 图源码不可信；节点 click 事件可能导航用户的浏览器。strict 禁止交互，图示也不需要交互。

**对 loose 的 SVG 用自写净化通道。** 以同样的保证重新推导 mermaid strict 级别已经应用的 DOMPurify 覆盖面。

**在 worker 中渲染。** mermaid 的渲染会改动一个临时 DOM 节点做布局，不是 worker 安全的。

## Consequences

页面中第一个定稿 fence 支付分片抓取与首次渲染的代价；之后的图示复用已加载的模块。图示不可交互，并在配色翻转时重渲染。图示的节点标签会出现在稳定的 ARIA 快照中，因此新的图示 fixture 只需记录一次 golden。`dsh-client-ui-primitives` 直接声明 mermaid（`^11.16.0`），与根 workspace 为文档站点解析的版本相同。
