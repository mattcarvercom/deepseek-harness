# Agent Note：会话正文以满宽开启

Status: implemented

[English](2026-09-06-conversation-full-width-default.md) | 中文

## 问题

会话列的共享宽度轴原本以自适应阅读宽度开启——`clamp(680px, 列宽的 64%, 920px)`，居中于列内（见[正文宽度自适应与拖拽调宽](../../archived/feature/2026-08-18-conversation-adaptive-content-width.md)）。在宽显示器上，正文只是数千像素宽列中间的一条窄带，把窗口填满的唯一办法是每个新会话都拖一次宽度手柄——而且只在拖过并持久化的那台浏览器里有效，因为偏好存在各浏览器自己的 localStorage 中。用户希望每个会话一打开就是满宽，并保留手柄以便偶尔收窄。

## 决策

**宽度轴以满可用宽度开启，拖拽仅作用于当前会话。** `ConversationRoot.module.css` 声明 `--dsh-chat-content-width: var(--dsh-chat-user-width, max(640px, calc(var(--dsh-conversation-column-width, 0px) - 176px)))`。176px 预算（每侧 88px：24px 内偏移 + 40px 手柄条 + 24px 安全区）不变——它保证手柄在任何宽度下都放得下——640px 下限与布局中心列下限一致。组件内的 `resolveContentWidth` 镜像该缺省项：无活动拖拽时返回最大值，拖拽宽度钳制到 `[640px, 列宽 − 176px]`。

**拖拽只收窄（或重钳制）当前会话。** 提交后的宽度保存在组件 ref 中，由同一个 ResizeObserver 发布按列宽重新钳制，并在会话切换时清空——每个会话、每台浏览器都以满列宽开启。`localStorage` 偏好 `dsh.conversation.contentWidth` 退役：组件不再读写它，改动前存储的值就此失效。不需要重置操作——会话切换本身就是重置。

手柄、其 40px 条与光带、指针捕获拖拽模型，以及共享轴关系（输入卡 W + 32px、dock 卡片、用户气泡上限）全部保留；只有轴的缺省项与拖拽的持久性变了。

## 备选方案

**满宽缺省但保留持久化偏好。** 拖过收窄的用户会一直打开窄宽度：本改动消除的"拖宽"烦恼会在第一次收窄后重现。

**保留 920px 阅读上限并加"宽屏模式"开关。** 为手柄已覆盖的能力增加设置面，且会话仍从窄宽度开始。

**按浏览器持久化"满宽开启"标志。** 它持久化的正是用户到处都想要的缺省值；一个永远不会关掉的标志是死状态。

## 影响

- 每个会话——新建或重开、每台浏览器——都以满可用列宽开启正文；无需拖宽。
- 宽显示器上散文行长不再被约 113 字符封顶，代码块与工具卡片获得整列宽度。想要窄阅读宽度的用户为本会话拖一次手柄即可。
- 收窄在会话内随窗口缩放存活（重新钳制，窗口拉宽后恢复），但绝不跨越会话边界或页面加载。
- 既有浏览器中持久化的 `dsh.conversation.contentWidth` 键就此失效；不再写入，无需迁移或换键。
- [正文宽度自适应与拖拽调宽](../../archived/feature/2026-08-18-conversation-adaptive-content-width.md) 中的自适应 clamp、其 680px / 64% / 920px 数值与拖拽持久化段落被本决策取代；该 note 的 ResizeObserver 发布、手柄几何与共享轴关系不变。

## 测试

`ui-conversation` 的 `skeleton.client.spec.tsx` 钉住往返：无拖拽时覆盖项缺省、CSS 缺省项生效；在封顶处向外拖为 no-op 且不写存储；向内拖收窄到确切的提交宽度；窗口收窄重新钳制显示、拉宽后恢复；无位移的按下与双击不动会话宽度；会话切换移除覆盖项。`DSH_SNAPSHOT=replay pnpm run test:web` 复验装配后的浏览器。
