# Agent Note: Codex 发布前握手截止时间

Status: implemented

[English](2026-09-15-codex-handshake-deadline.md) | 中文

## 问题

Codex app-server wire 用两个非响应事实结算发布前握手：请求信号的中止，以及所 spawn 子进程的直接失败。两者都不覆盖现场事故报告的那个输入——一个存活、保持 stdio 流打开但从不响应的子进程（[讨论 #6226](https://github.com/deepseek-ai/deepseek-harness/discussions/6226)）：`initialize` 与 `thread/start` 请求，以及建立在其上的运行，一直等到服务器重启，没有失败、没有诊断、没有重试。共享 JSON-RPC 传输只在响应、中止或流结算时结算待处理请求，本身没有计时，因此提供方没有地方限制握手；而当发布前失败确实浮现时，失败构造器没有任何存活观测能说明 app-server 进程是否仍在运行，诊断无法区分「存活但沉默」与「已经死亡」。

## 决定

提供方配置接受 `handshakeTimeoutMs`：不超过共享 `MAX_TIMER_DELAY_MS` 的非负有限数值，schema 默认值 `60_000`，`0` 恢复无界握手。该值经由 `CodexRunSpec` 流入 `CodexAppServerWire` 构造函数，后者通过传输的 `timeoutMs` 选项限制两个发布前请求；`runTurn` 保持无界，因为长的轮次是合法工作，而不是沉默。

截止时间触发时，运行在其阶段以 `transport` 类别失败——传输沉默类别，区别于 `unknown`——发生在任何处置之前。处置之前，`startupLivenessDetail` 用一个与零延迟中止信号竞争的 `waitForExit` 调用探测已获取的子进程；当探测补充了事实时，向安全失败诊断追加固定的存活详情：截止期限已过而 app-server 进程仍在运行，或子进程已经退出而其受管 range 尚未停稳。被取消的运行、已有解释的子进程失败、以及不可观测的 range 不追加详情；详情永远是诊断消息的最后一个字段。

## 考虑过的替代方案

**`SubprocessHandle.liveness()` seam 方法。** 现有的 `done` 承诺与 `waitForExit(signal?)` 已经表达了该探测——memoized 的退出 range 与零延迟中止竞争——因此 seam 方法会添加一个没有当前所有者的公开 API，并且要求每个 subprocess 提供方为只有一个消费方需要的行为做实现。

**针对沉默握手的仅 Host `ctx.logger.warn`。** 重试决定发生在模型的 tool result 处，而 harness 把模型可见事实与日志配对；仅 Host 的日志行对该决定不可见。该事实落入安全诊断，诊断会到达 tool result，而既有的失败日志把它带到 Host。

**针对整个运行的墙钟上限。** 合法的轮次会运行得比任何固定上限都长，而且发布后的存活问题是另一个设计——协议帧上的活动边界，而不是墙钟。一刀切的上限会杀死健康工作，同时让真正的缺口——无界的发布前请求——原样保留。

## 后果

- 沉默的 app-server 现在在 `handshakeTimeoutMs` 截止期限处让运行失败，处于其所在阶段，类别 `transport`，并带可执行的存活详情，因此调用方可以在有界失败上重试或取消，而不是等待重启。
- `handshakeTimeoutMs: 0` 恢复变更前无界握手；`60_000` 是 schema 默认值，因此直接 `apply` 调用显式传递该字段，与 `disposeGraceMs` 完全一致。
- wire 构造函数新增默认 `0` 的第五个参数；生产调用方是提供方的 `start()`，它传递已配置的值。
- 安全失败消息新增可选 `detail` 字段，永远在最后；诊断的其他字段不变。
- 无会话事件、会话格式或线上格式变更：截止期限是提供方内部失败路径，且轮次请求保持无界。

## 测试

wire 规格固定两个握手方法上的每请求截止拒绝——携带 `method` 与 `timeoutMs` 的 `JsonRpcTimeoutError`——并证明零截止不装任何定时器。run 规格用确切消息固定两种存活详情，以及针对取消、spawn 失败、无效帧、关闭前 EOF 与不可观测 range 的既有诊断保持不变。配置规格固定验证拒绝（负值、非有限值、超出上限）、对 `0` 的接受、`60_000` 默认值与直接 `apply` 路径。真实产品通道不变通过，证明默认截止期限下的健康握手。

## 相关

- [JSON-RPC 行传输的每请求截止时间](2026-09-15-jsonrpc-request-deadline.zh.md) — 本说明所装上的传输机制。
- [Claude Code 与 Codex subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md) — 本截止期限所约束的提供方生命周期。
- [事故复盘（postmortem） 0005：Codex subagent 握手挂起](../../../../docs/postmortem/0005-subagent-codex-handshake-hang.zh.md) — 暴露该缺口的事故。
