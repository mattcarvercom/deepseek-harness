# Agent Note: Subagent kill 控制

Status: implemented

[English](2026-09-15-subagent-kill-control.md) | 中文

## 问题

subagent 控制家族有停止，却没有硬停止。`interrupt` 只是取消：子级的轮次被取消，尚未领取的待处理 inbox 工作被保留，驻留可继续子级依旧可以恢复。两个作用域 drain（`drainContinuableDescendants`、`drainContinuableChildren`）是父进程在自己清理时对自身 Agent 发出的进程内拆卸动词，而不是针对某一个具名子级、可由人类寻址的控制。一个不再想要某个子级工作的父级会话——运行卡在不正确的路径上，或子级已经失去存在的意义——没有任何办法结束它：子级停放的 inbox 消息会继续被领取进后续轮次，驻留子级可以无限期恢复，一次性子级只能被弃置。结束一个子级所需的原语其实早已存在——携带 inbox 丢弃的 user 原因 `Agent.cancel`、按 child-first 顺序释放 epoch 子树的记忆化关闭事务、以及 session 控制器把薄 Remote 架在服务原语之上的既定模式——但没有任何东西把它们组合在一个声称的 parent 权威之下，也没有任何 Remote 暴露其结果。

## 决策

一个服务原语，一个 Remote。`SubagentRuntime.kill(targetSessionId, authority)` 接纳 `SubagentKillAuthority`——单一种类，即人类客户端呈报的持久直接 parent 地址；kill 没有模型编写的消费方，因此没有 live ancestor 形式——并把该地址与存活目标的持久 `SessionHeader.parentSession` 进行鉴权。驻留可继续目标会被以 user 原因取消当前轮次，其待处理 inbox 工作被持久丢弃，其驻留 epoch 通过记忆化的关闭事务关闭，该事务按 child-first 顺序释放所拥有后代 Activation。存活的一次性子级以同样方式通过其自身 Agent 被取消，运行所有者把它结算为 `aborted` 并按惯例释放。调用是 fire-and-return：cancel 信号与 dispose 任务在它返回前均已发出；不存在的目标——未知、远程或已结算——以及未绑定管理器的组合是被接受的 no-op；一个正在关闭的 epoch 则交由其自身拆卸处理，该拆卸已经停止了目标并拥有这次释放。当 kill 输给一次并发作用域 drain 的竞态时，目标绝不会被信号两次，因为第一次关闭已经拥有该 epoch。

session 控制器把该原语暴露为 `ctx.remote.session` 上的 `session/killSubagent`：一条请求携带被寻址的 parent session 与持久子 session id，一条回执确认 kill 信号已被接纳，而非子级已经完全停稳。命令通过严格可选读取解析 subagent 服务——未挂载的组合会失败于 `gateway/internal`，而不是宣称一个它不具备的能力——并把原语的 `UNAUTHORIZED` 映射为携带子级 id 的远程 `subagent/unauthorized` 失败，其余一切作为带 cause 的 `gateway/internal` 包装。它不预验证被寻址 parent 存在或拥有该子级：原语是唯一的鉴权点，把声称与存活目标比对，因此指向一个已结算子级的请求只是被接受的 no-op。

首次取消胜出：被 kill 子级的 `turn/end` 记录 user 原因，而由父级拆卸停掉轮次的后代记录 parent 原因。被 kill 的子级结算为 `aborted`，其父级收到既有的针对被停止子级的结算句子，因此 kill 没有新增任何模型可见文本，也没有新增取消原因。

## 曾考虑的替代方案

**专门的 kill 取消原因。**持久取消原因已经记录了是谁要求的：user 原因覆盖 kill，正如它覆盖任何用户发起的停止；一个专属 kill 的原因会把控制便利泄漏进 `AgentCancelCause`，而该类型被每个消费方折叠。

**给模型一个 kill 工具。**模型已经拥有对自身子级的 `interrupt_agent`；一个会销毁它无法重建的状态的委派模型，并不是人类 parent 所处的权威。因此 kill 是 session namespace 上的人类控制——subagent namespace 没有 Remote，也没有工具——其他 host 代码仍可通过服务方法到达该原语。

**在 Remote 中预验证声称的 parent。**在调用原语前检查被寻址 session 存在并指名该子级，会重复原语的鉴权，为一个本身已是安全 no-op 的请求增加第二条失败路径；与存活目标的那一次比对在构造上就是无竞态的。

**在回执前等待完全停稳。**等待 dispose 任务会把一个 fire-and-return 控制变成一段时长未知的往返，而该拆卸本来就记录自己的失败；接纳才是有意义的确认，结算通过既有的结算通知观察。

## 后果

- 人类可以结束被寻址 session 的任意存活 subagent 子级：子级轮次以 user 原因中止，其待处理 inbox 工作以一条最终 `agent/inbox/spliced` 记录被丢弃，驻留子级的驻留 epoch 被关闭，后续提示词不再恢复它。
- kill 是无竞态的：并发的作用域 drain 或正在关闭的 epoch 绝不会向目标发出两次信号；目标释放之后发生的拆卸失败被记录而不是抛出。
- 一次性子级通过 Agent 注册表覆盖，因此没有 live Agent 注册表的组合接受 no-op 而不是失败。
- `subagent` namespace 的 Remote 面不新增任何 kill 条目，返回空回执的 Remote 也不需 kill 回执类型；session namespace 拥有该控制。
- 每个被 kill 的子级使其父级多一条结算通知——与 interrupt 产生的被停止句子相同——不存在新的模型可见面。

## 测试

continuation spec 端到端固定该原语：中途 kill（带 inbox 丢弃的 user 原因取消，随后是 parent 原因拆卸取消、带 canceled 结果的最终 splice 记录、user 原因 `turn/end`、以及关闭的 epoch），idle kill（两次取消都只作用于 inbox、停放工作被丢弃、epoch 关闭），被拒绝且 epoch 保持打开的外来声称，把运行结算为 `aborted` 的一次性 kill，指向非 subagent 与已结算目标的外来声称，输给作用域 drain 竞态时只信号一次的 kill，以 parent 原因 child-first 释放存活孙级，以及释放后记录 kill 触发的拆卸失败。service spec 固定无管理器的 no-op。session-controller host spec 固定未挂载失败、携带转发权威的接受回执、以及到远程失败的 `UNAUTHORIZED` 映射；client spec 固定 `session/killSubagent` 规则。subagent 表面测试把 `kill` 列入服务暴露的操作。

## 相关

- [Subagent 活动观察与运行中轮次 pill 阶段](2026-09-15-subagent-activity-observation.zh.md)——kill 所停止的实时运行观察；其 pill 携带 latched 本地子级的终止子级动作。
- [运行中轮次 pill 上的终止子级动作](2026-09-15-subagent-kill-child-action.zh.md)——调用本 Remote 的 pill 动作。
- [可继续的 subagent](2026-07-28-continuable-subagent-conversations.zh.md)——kill 所关闭的驻留 epoch。
- [相邻 Agent 消息](../architecture/2026-08-27-adjacent-agent-steer-messaging.zh.md)——kill 所扩展的消息与中断控制家族。
