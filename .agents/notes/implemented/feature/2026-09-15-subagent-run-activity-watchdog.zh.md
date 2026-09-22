# Agent Note: Subagent 运行活动看门狗

Status: implemented

[English](2026-09-15-subagent-run-activity-watchdog.md) | 中文

## 问题

发布后的 subagent 运行自身没有任何时间边界。Codex wire 只在 `turn/completed` 通知或子进程失败上结算已发布的轮次，而 app-server 子进程可以保持存活、保持 stdio 流打开、不再发出任何协议帧——正是 [握手截止时间](2026-09-15-codex-handshake-deadline.zh.md) 所约束的发布前沉默的补集。Claude Code 流有同样的补集：查询发布之后，SDK 流可以在子进程仍然存活时停止产出消息，`for await` 消费者则永远等待下一个值。两种情况下，运行、它的工具调用以及建立在其上的会话状态都只能等一个外部行动者——取消、杀死或服务器重启——没有失败、没有诊断、没有重试。共享的 `dsh-timeout` 原语填不上这个缺口：`idleWatchdog` 只在一个迭代器 demand 尚未结算时武装、在结算时清除，因此无法约束 Codex 那种推送式帧流——帧与帧之间没有任何 demand 待处理——而且两个原语都不携带 subagent 运行失败所带的带标签细节与提供方拥有的触发动作。

## 决定

两个产品提供方的配置都接受 `runActivityTimeoutMs`：不超过共享 `MAX_TIMER_DELAY_MS` 的非负有限数值，schema 默认值 `300_000`，`0` 恢复无界运行。该值经由每个提供方的运行规格流入拥有看门狗的运行生命周期代码。Codex wire 在运行提交其轮次时武装计时器，在它观察到的每一个 app-server 帧上重置——通知与服务到客户端请求，以 `notification:` 或 `request:` 加方法名作标签——截止期限届满时让运行在其所在阶段失败，类别 `transport`，细节指出最后观察到的帧或 `none`。Claude Code 的 attempt 在查询发布时武装同一形状的看门狗，在每一条 SDK 流消息上以 `type:subtype` 标签重置，触发时关闭查询——流随后干净结束，子进程走正常路径拆除——之后 catch 把触发映射为 `query-run` 失败，类别 `transport`、同样的细节形状，压过关闭的流本会产生无效结果失败；attempt 的 `finally` 清除看门狗。`runActivityTimeoutMs` 为 `0` 时不武装任何东西，运行保持无界，与之前一致。

Codex wire 同时关闭同一缺口的终态不匹配方面：引用了另一线程的 `turn/completed`、在运行提交轮次之前到达的 `turn/completed`、或引用了另一轮次的 `turn/completed`，都会让运行失败，细节中指明该不匹配；而无法属于本运行的非终态帧通过 wire 的 `onUnassociatedFrame` 诊断接收器上报，但不使运行失败，因为只有失配的终态帧会让运行被搁置。

## 考虑过的替代方案

**复用 `dsh-timeout` 的 `idleWatchdog`。** 该原语约束 LLM 请求流上尚未结算的迭代器 demand：计时器在每个待处理 `next()` 上武装，在结算时清除，超时中止一个融合信号，适配器用其能力超时原因来分类。subagent 运行需要另一种时序模型——一个从提交到终态跨度的边界、在每一个观察到的帧或消息上重置、在失败细节中指明最后的活动、并触发提供方拥有的失败路径（查询关闭加 `transport` 类别），而不是一个会被 catch 分类为调用方取消的中止。运行作用域的看门狗把该状态作为运行生命周期的一部分放在每个提供方包里；共享库保留其 demand 作用域的契约。

**在任何非关联帧上失败。** 只有失配的终态帧会让已发布的运行被搁置；失配的非终态帧不会，而对每一个非关联帧都失败会把协议噪声变成运行死亡，殃及那些本可以靠自己的终态帧结算的运行。非终态帧通过诊断接收器上报、只对终态不匹配失败，两种行为都保留了：运行保留结算的机会，沉默看门狗约束剩下的一切。

**对整个运行做墙钟击杀。** 健康的轮次——长构建、长的代理工作——合法地比任何固定上限运行得更长，而活动边界已经关闭了所报告的缺口：沉默是今天唯一会让发布后运行被搁置的输入。总时间边界仍是部署显式选择的后续项；它不是默认值。

## 后果

- 沉默的发布后运行现在在 `runActivityTimeoutMs`（默认 `300_000` 毫秒）内于其所在阶段失败，类别 `transport`，细节指出最后观察到的帧（Codex）或消息（Claude Code）——为两个产品提供方关闭 [事故复盘（postmortem） 0005](../../../../docs/postmortem/0005-subagent-codex-handshake-hang.zh.md) 的发布后方面。
- 一条超过默认值的静默命令（例如安静的构建）会触发截止期限；想要变更前无界运行的部署设置 `runActivityTimeoutMs: 0`。
- Codex 运行的 catch 把 wire 收集的失败细节合并进它选定的事实中，因此一个看门狗触发或一个被丢弃的终态帧——即使它比最先拒绝竞争的子进程退出活得更久——也能把细节留在模型可见的诊断里。
- Claude Code 的触发在 catch 分类之前关闭查询：`for await` 消费者结束，子进程拆除保持在其正常路径上，触发的映射优先于流的提前结束本会产生的无效结果失败。
- 两个 `Config` 对象都新增经过校验的字段（非负有限、不超过 `MAX_TIMER_DELAY_MS`、schema 默认 `300_000`）；直接 `apply` 调用显式传递该字段，与 `handshakeTimeoutMs` 和 `disposeGraceMs` 一致。
- 无会话事件、会话格式或线上格式变更：看门狗是建立在既有失败诊断之上的提供方内部失败路径。
- 姊妹提供方包中平行的看门狗是有意重复，标记在重复率门禁的忽略区域内。

## 测试

Codex wire 规格固定了触发（轮次提交后的沉默与在途沉默）、在每一个流出帧与服务请求上的重置、被禁用的截止期限、以及非关联帧行为——非终态帧上报但不失败，终态帧带着所指明的不匹配失败。Codex 运行规格固定了沉默的发布后运行在活动截止期限处失败，wire 细节合并进诊断。Claude Code 规格固定了关闭查询的触发、从未有消息到达时的细节（`last: none`）、压过截止期限的逐消息重置、以及被禁用的流。两个配置规格固定了验证拒绝（负值、非有限值、超出上限）、`300_000` 默认值与直接 `apply` 路径。真实产品通道保持不变并通过。

## 相关

- [Codex 发布前握手截止时间](2026-09-15-codex-handshake-deadline.zh.md) — 发布前的姊妹边界；两个截止时间一起关闭事故复盘 0005。
- [JSON-RPC 行传输的每请求截止时间](2026-09-15-jsonrpc-request-deadline.zh.md) — 握手截止时间所装上的传输机制。
- [LLM 流内容空闲超时](2026-09-15-llm-stream-content-idle-timeout.zh.md) — LLM 适配器上的两层活动/内容看门狗；同样的「活动不是进展」区分应用到 subagent 流。
- [超时截止期限库](../architecture/2026-07-06-timeout-deadline-library.zh.md) — 本说明有意不复用的共享原语的归属地。
- [Claude Code 与 Codex subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md) — 这些边界所覆盖的提供方生命周期。
- [事故复盘（postmortem） 0005：Codex subagent 握手挂起](../../../../docs/postmortem/0005-subagent-codex-handshake-hang.zh.md) — 本说明关闭其发布后方面的事故。
