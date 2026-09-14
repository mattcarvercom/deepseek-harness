# Agent Note: 深度求索胶囊下的压缩进度副标题

Status: implemented

[English](2026-09-14-compaction-progress-subline.md) | 中文

## 问题

回合运行期间，Web 聊天只有一个指示：`Deep diving...` 胶囊，带一个延迟 15 秒才出现的耗时计时。当自动压缩在回合中途启动——可能持续数分钟的高成本 LLM 摘要——没有任何东西把这一状态与普通的模型工作区分开：模型在跑工具时和生成数千 token 摘要时，胶囊的读数一模一样。这个开放状态完全可以由已记录的 `compaction/start` 与 `compaction/end` 会话事件重建出来；只是之前没有投影到 UI。改动之前，用户只能事后从 `compaction/summary` 之后出现的压缩摘要节点得知压缩发生过。

## 决定

压缩的 Conversation 节点定义现在通过既有的 Location 数据通道，把开放中自动压缩的 `compaction/start` 信封时间发布到所属回合：[compaction.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/compaction.ts) 的 `buildLocationData` 返回一个回合范围的 `compaction` 值——`ConversationTurnDataMap` 上扩展合并的键，值为 epoch 毫秒的 `number`——在 `compaction/start` 时设置、跨 `compaction/summary` 保留、在 `compaction/end`（无论是否带错误）时清除。手动压缩（携带 `sourceCommandId`）与无回合压缩（`turn: null`）不发布任何值：定义的 `match` 拒绝它们，因此它们不拥有 Context，手动路径保留其命令行呈现。

[ChatView.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) 的 `TurnStatus` 通过 `useTurnDataValue` 读取运行中回合数据 store 里的该值，把它渲染为胶囊下方的一行灰色副标题：`chat.compacting` 文案（`Compacting conversation...` / `正在压缩对话...`）加一个锚定压缩开始时间的独立计时。副标题计时不带 15 秒门槛——压缩才是有意义的状态，那个延迟是为了让普通胶囊在短回合上保持安静——主胶囊计时则保留该门槛。`role="status"` 实时区域从胶囊移到两行分组上，副标题出现时会被播报；两个计时都保持 `aria-hidden`。文案位于聊天 locale 字典中。

## 考虑过的替代方案

**专用的压缩节点或徽章。** 为一个回合级状态新增节点类型和转写席位，而回合状态分组本来就是回合级进度所在之处。Location 数据通道正是为这类回合范围事实设计的（先例：turn-process 与 turn-tail 数据键）。

**在 ChatView 里直接读压缩事件。** 违反 Conversation 节点纪律：组件消费最终节点数据或受限的 Location 钩子，而不是原始事件窗口；定义拥有的折叠是规范路径，且可重放。

**用同样的 15 秒延迟门槛限制副标题计时。** 用户在压缩期间会注意到回合变安静；给副标题计时加延迟会掩盖最需要它的时刻。延迟保留在主胶囊上，由它来保护短回合。

**在 Session 快照中跟踪开放压缩。** 为一个可由窗口内两个事件派生的事实增加持久客户端状态；引擎的 Location 数据本来就是对这两个事件的可重放投影。

## 后果

没有新增会话事件，没有协议变更；model-visible-iff-logged 不受影响，录制的会话快照无需重录。副标题只在运行中回合存在开放自动压缩时出现，并在 `compaction/end` 时消失，无论压缩成功还是失败。回合中途重新加载不会丢失信息：该值派生自窗口事件，从日志重组的客户端会对仍在进行中的压缩重新显示副标题。

## 测试

`conversation-node-definitions` 的 spec 覆盖：启动时发布、跨摘要保留、结束时清除（带错与不带错）、手动与无回合压缩不发布；`chat-view` 的 spec 覆盖副标题的出现、其独立计时、消失、与带门槛的主计时的并存。`verify-client-ui-i18n` 通过新增文案，`verify-agent-note-format` 与 `verify-translation-pairing` 门禁通过本笔记。

## 相关

- [回合耗时标签增加小时单位](2026-09-09-turn-duration-hour-unit.zh.md)——本副标题所在其下的主计时。
- [排队手动压缩](2026-07-30-queued-manual-compaction.zh.md)——有意留在范围之外的手动路径。
