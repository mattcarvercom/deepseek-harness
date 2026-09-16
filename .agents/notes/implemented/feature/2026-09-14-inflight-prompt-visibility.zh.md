# Agent Note: 对话流中在途提示词的可见性

Status: implemented

[English](2026-09-14-inflight-prompt-visibility.md) | 中文

## 问题

当用户从 Web 输入框发送提示词时,对话中会显示一个临时回显,投递落定后该回显即被移除。此后,直到智能体在回合或步骤边界认领该提示词并将其作为规范的 `user/message` 节点提交之前,这条提示词在对话的任何位置都不可见。而这正是用户需要一条"消息已到达框架、排队等待进入模型"信号的时间窗口:它可以跨越整个正在运行的回合,并且在智能体繁忙期间(包括压缩)还会进一步延长,直到提示词到达下一个边界。该状态完全可以由已记录的事件重建:每一次入队、认领和丢弃都是 `agent/inbox/spliced` 事件,规范提交则是 `user/message` 节点——只是此前没有任何东西把这个状态投影到对话流中。

## 决定

Session 客户端在它所持有的窗口上维护一个纯内存的收件箱折叠:`PendingInboxPrompts`([pending-inbox-prompts.ts](../../../../packages/api/session-controller/src/client/sessions/pending-inbox-prompts.ts))通过以与规范收件箱投影相同的算法(基于 `toSpliced`,拒绝重复 id)重放 `agent/inbox/spliced` 来镜像两个待处理列表(`next-turn`、`next-step`),并跟踪已被认领的提示词——认领是回合或步骤边界发出的、不带 outcome 的删除型 splice——直到该提示词的 `user/message` 提交或其所属回合的 `turn/end` 将其移除。提交移除先按 id 匹配,compact 记录丢失 id 时按 rpcId 兜底;两条路径都从已认领表和两个投影列表中移除该条目,因此即便某个窗口的认领 splice 因分歧被跳过,已提交的提示词也不会滞留在待处理状态。历史页只应用插入型 splice 并按 id 去重;其中的删除和回合事件描述的是过去的状态,不改动当前折叠。Session 快照新增 `pendingInboxPrompts` 字段(契约见 [snapshot.ts](../../../../packages/api/session-controller/src/client/contract/snapshot.ts)):用户来源的条目按 next-turn(`queued`)、next-step(`steering`)、已认领(按认领顺序)排列,每条携带 `id`、`placement`、可选的 `rpcId`、`content`,以及共享的预览/正文派生([message-preview.ts](../../../../packages/api/session-controller/src/client/sessions/message-preview.ts),从队列镜像中抽出以复用)。

[ChatView.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) 将每条条目渲染为对话流尾部组中的 `PendingInboxPromptBubble`——一个降低不透明度的用户样式气泡,带一条由 locale 拥有的状态页脚(`chat.pendingQueued` "Queued"/排队中,`chat.pendingSteering` "Steering"/引导中)——但仅当条目处于认领→提交窗口内时:已入队未认领,或已认领未提交。仍出现在队列投影中的条目(无论哪种 placement)都不渲染:composer 上方的队列坞呈现排队中的提示词,既有的 steering 气泡呈现引导中的提示词,因此同一条提示词不会在同一帧中被呈现两次。已提交的提示词隐藏在其持久化节点之后,匹配依据是 rpcId 或节点 key——view 节点的 key 由消息 id 派生;key 匹配同时能隐藏由仅插入的历史页头重放的陈旧折叠条目,因为持久化节点仍是唯一的表示。临时回显在折叠确认收件箱受理的那一刻即被移除(复用该提交项的观察移除闩),因此至多存在一帧重叠,而渲染期的 rpcId 去重会将其隐藏。

## 考虑过的替代方案

**对折叠中的每条条目(包括仍在队列投影中的提示词)都渲染流内气泡。** 队列坞已经把每条排队中的提示词连同预览和操作按钮一起钉在 composer 上方渲染,steering 气泡则覆盖引导条目:常开的气泡会让每条待处理提示词同时出现在两个表面上,破坏严格单匹配查询与可访问性 golden,并迫使重新录制 golden,却没有任何用户可见的增益。认领→提交窗口是唯一没有其他表面呈现的状态;气泡恰好填补这个缺口。

**纯由队列帧渲染。** 该帧源自同一份收件箱投影,但它会在认领时变空:回合或步骤边界一旦消费提示词,投影随即将其丢弃,因此队列根本无法表示认领→提交窗口——而这正是本特性要覆盖的窗口。

**新增会话事件或专用投影键。** 日志中已有的 splice 已能确定该状态;再记录或投影一遍会重复"模型可见⟺已记录"的数据,并增加一个回放客户端本就能重建的协议面。

**保留临时回显作为指示。** 回显只存在于客户端内存:窗口中途重新加载会丢失它,它无法区分排队与引导,而且它随受理即被移除,无法跨越认领→提交窗口。

**通过实时通道广播收件箱变化。** 为一个可由既有事件推导出的事实新增 `session/follow` 帧类型会改动协议,并且重新加载时仍然需要基于日志的折叠。

## 后果

没有新增会话事件,没有协议变化;规范 `user/message` 仍是唯一的提交表示,也没有任何已录制的会话快照需要重新录制——回放通道保持字节级一致(包括 web golden),因为仍在队列投影中的提示词经队列坞呈现,而不是经对话流呈现。由于折叠从日志重建,气泡能在窗口中途重新加载后幸存,并且覆盖了队列帧无法表示的认领→提交窗口。有界窗口与全量日志的核心折叠存在一处已记录的分歧:若某条 splice 被删除的片段早于折叠窗口,则无法校验,于是不抛出异常而是跳过,它所描述的认领也永远不会被跟踪——该提示词会通过其持久化提交呈现出来。尚有一处残留状态既不被折叠也不被视图覆盖:若某条提示词从入队到提交的整个过程都落在窗口之外,当用户加载携带其入队 splice 的历史页时(仅插入的页头重放不会折叠该页的认领与提交事件),该提示词会重新折叠为待处理,且没有任何实时事件将其移除;这条陈旧条目会持续到下一次窗口重置(重置从空折叠重建)为止。气泡以降低的不透明度渲染,使其呈现为待处理状态;其文案由 locale 词典拥有。

## 测试

`pending-inbox-prompts` 规格固定折叠算法:入队呈现、提交移除(按 id、按 rpcId——含丢失 id 的 compact 记录——以及因窗口分歧仍留在投影列表中的条目)、被认领后保持至窗口并以 `turn/end` 移除、canceled splice 不被视为认领、原位替换、非用户来源跳过、有界窗口跳过容错、仅插入的页头去重,以及快照排序。`session` 规格固定接线:窗口安装时重置折叠、实时 splice 追加、快照携带该列表。`chat-view` 规格固定气泡:带状态页脚的呈现、在持久化节点处按 rpcId 与节点 key 移除、排队或 steering 提示词仍在队列投影中时不重复渲染、已认领 steering 的显示,以及回显抑制。无 key 的 web 回放通道保持原样通过:其 golden 中的提示词当时仍在队列投影中、经队列坞呈现,收窄后的渲染窗口使其保持字节级一致。`verify-client-ui-i18n` 对新文案通过;`verify-agent-note-format` 与 `verify-translation-pairing` 对本笔记通过。

## 相关

- [深度求索胶囊上的压缩进度副标题](2026-09-14-compaction-progress-subline.zh.md) — 同一分支上的姊妹级用户可见指示。
- [本地提交回显](../../archived/architecture/2026-08-26-local-submission-echoes.md) — 本气泡复用的回显机制及其移除闩(已归档)。
- [可续跑子代理的人工收件箱控制](2026-08-27-continuable-subagent-human-inbox-control.zh.md) — 与本气泡去重对象相同的队列控制所依据的同一份收件箱投影。
