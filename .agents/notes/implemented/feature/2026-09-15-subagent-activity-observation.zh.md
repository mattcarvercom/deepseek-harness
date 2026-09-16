# Agent Note: Subagent 活动观察与运行中轮次 pill 阶段

Status: implemented

[English](2026-09-15-subagent-activity-observation.md) | 中文

## 问题

已发布的 subagent 委派在运行期间是不透明的。Web 聊天中运行轮次的 pill——带经过时钟的深度求索指示器——只能报出在途工具的名字：委派进入长时子运行几分钟之后，显示的内容与刚刚提交的委派完全相同；子进程正在调用工具与正在流式产出模型输出，没有任何区分。同样的缺口延伸到 pill 的其它轮次事实：在尚无任何 assistant 输出可见时，subline 只能报出最新在途工具，所以一个在等存活后台任务的轮次与其它任何安静时刻无法区分；兜底 subline 甚至声称"等待首个 token"，而那时模型其实已经产出了用户尚未看到的输出。这一切还都是客户端本地的：经过时钟锚定在客户端首次观察到轮次的时刻，因此中途重新加载页面会把时钟清零；面对卡住的轮次，pill 除了一个裸的取消之外没有提供任何恢复手段。修正这些事实所需的全部输入都已经存在——provider 能看到子运行的粗粒度阶段转换，会话日志携带轮次的 `turn/start` 边界，job 视图发布存活任务，轮次的首条用户消息是已提交节点——但子会话的详细事件流不是父会话观察者能读取的表面，也没有任何东西把它的粗粒度版本投影出来。

## 决定

每个 subagent provider 通过启动请求上的观察型 `onActivity` 回调上报粗粒度活动，由 [sessionEventActivityKind](../../../../packages/subagent/subagent/src/activity.ts) 归类为共享的 `SubagentActivityKind`——`tool` 对应子工具调用，`output` 对应子 assistant 消息，`other` 对应其余一切。按契约，上报是纯观察：它永远不能影响运行的计时、取消或结算。委派工具为每次调用组合一个 fail-soft 记录器：在首次观察、每次阶段变化、以及同一阶段持续期间的 30 秒心跳上，向调用方父 Session 追加一条 `subagent/activity` 事件——该工具追加的唯一一个包自有持久事件，仅日志、永不对模型可见——载荷包含 call id、provider 名、kind，以及截断到 200 字符的委派 description。追加失败只记一条警告并在本次调用剩余时间禁用上报，运行本身不受影响；job 结算时记录器被释放，因此没有任何观察活得比它的调用更久。

客户端把事件折叠为每会话活动 map（[SubagentActivityFeed](../../../../packages/client/ui-chat/src/client/subagent-activity.ts)）：一条 `subagent/activity` 按委派 call id 覆盖写入最新事实，该调用的 `tool/result` 到达时剔除条目；窗口 replace 或 prepend 时按日志顺序整体重扫，因此回放会话重建出完全相同的 map。map 通过会话作用域选择器 hook 到达 pill，[derivePillPhase](../../../../packages/client/ui-chat/src/client/chat/pill-phase.ts) 从已发布事实上的固定优先级链中为运行轮次选出单一阶段：开启中的压缩、计划中的模型请求重试、携带最新活动事实的在途 subagent 委派、其它任一在途工具、assistant 的实时流（reasoning 尾部是 `thinking`，其余可见内容是 `generating`）、存活后台任务（按启动时间取最新），最后才是诚实兜底——轮次已有可见 assistant 输出时为 `working`，请求确实还没有任何 chunk 时为 `first-token`。每个分支渲染一条 locale 拥有的 subline（`Waiting on child {label}`、`Running {tool}`、`Waiting for job {label}`、`Working…` 等），且只有 subagent 分支提供查看日志动作，它打开该调用的 trajectory 视图。独立于 pill，委派自身的工具行在其运行期间将粗粒度阶段——产出输出、执行工具中、或工作中——作为 locale 拥有的 subline 渲染，已结算的行从不显示。

pill 的经过时钟锚定在轮次的日志化启动时刻上：当 `turn/start` 边界位于已加载窗口内时用其实时时间，否则用每条[轮次大纲](../../../../packages/session/session-turn-outline/README.zh.md)条目上新增的 `startedAt` 字段——在严格 wire schema 下以投影 stateVersion `3` 追加——因此中途重新加载保持真实的经过时间。动作行随轮次增长：取消恒在；取消并重试仅在轮次已结算至少一个工具结果后才出现，它通过确认对话框把轮次自身的首条用户消息（读自已提交节点）作为新轮次重发；查看日志仅在 subagent 分支出现。

## 考虑过的替代方案

**把子会话事件流灌进父会话。** 子日志已经详细记录了全部事件，但把那条流重新暴露到父会话，会让父日志变成子日志的镜像、把持久数据在两个会话间复制，并把每个子事件变成一条父追加。在 provider 边界做粗粒度阶段分类，恰好抓住 pill 真正需要的信息——哪个阶段、何时变化——而且是一个观看者读得过来的速率。

**客户端轮询子会话。** 运行中的子会话没有稳定的客户端读取通道；工具结果是唯一结算过的表面，而一套新的轮询传输只会用更多机制去观察一个单行 provider 回调已经提供的东西。

**每次观察都发事件、不做节流。** 话多的子进程每个子事件都会产出一条阶段观察；逐条追加会向父日志灌入任何消费者都渲染不出来的亚分钟记录。相位变化加心跳的节流在持有相位语义的 producer 一侧限定记录流的速率。

**从已加载窗口内的事件推导时钟。** 运行轮次的 `turn/start` 会落在分页或重载后的窗口之外，而窗口内任何更晚的事件都不是轮次的启动。整日志轮次大纲中的持久化逐轮 `startedAt`——投影事实，而非窗口事实——是唯一能扛过重新加载、又无需新 wire 格式的锚点。

**让 `subagent/activity` 对模型可见。** 该阶段只是子进程进度的 UI 呈现；把它加进模型请求，会让会话中其后每次委派都多花 token。仅日志的记录让事实对 UI 持久，同时不触碰模型可见表面。

## 后果

- 运行中的委派在 pill subline 显示其 label 与粗粒度阶段，并在自身工具行下渲染粗粒度阶段；二者都随每次阶段变化更新、同一阶段期间至多每 30 秒一次，并随该调用的 `tool/result` 到达而一同消失——实时与重新加载后一致，因为折叠纯粹由日志推导。
- pill 的 subline 在每一个分支上都是诚实的：已有可见输出的轮次报 working，确实还停在首个 chunk 之前的轮次报等待首个 token，在等存活任务的轮次会点名该任务。
- 中途重新加载经由新的 `turnOutline[].startedAt` 锚点保持真实经过时钟；wire 变更是追加的（stateVersion `3`），缓存的投影行在版本不一致时重新折叠。
- 未知构建的读者在标准"默认必读"规则下遇到新类型时会拒读这样的日志，而不是跳过它；自本变更起的构建认识并折叠该类型。
- 每次委派每个阶段至多追加一条 `subagent/activity` 记录；一个长时单阶段子进程在该阶段持续期间每半分钟产生一条记录。
- zh locale、持久化目录、事件生产/消费图与重新录制的 Web golden 随新 subline 一同变化；golden 变化是因为 pill 的可见文本变了，而不是任何会话行为变了。

## 测试

工具 spec 钉住记录器的首观察、相位变化与心跳上报，心跳窗口内不上报，追加失败后的 fail-soft 禁用，以及结算时的释放。客户端折叠 spec 钉住覆盖写入、结果到达时的剔除、窗口 replace 与 prepend 之下的回放一致性，以及 feed 释放。pill spec 钉住阶段链的每个分支、流式分支的 reasoning 与 text 之分、最新 job 的选取，以及 working 与 first-token 兜底之分。ChatView spec 钉住每条 subline 的渲染与 locale 文案、动作集合（取消恒在；取消并重试以已结算工具结果为门槛并重发首条用户提示；查看日志仅在 subagent 分支）、以及重新加载稳定的时钟锚点。轮次大纲 specs 钉住 `startedAt` 折叠与追加式 stateVersion `3` 重折叠。工具行 spec 钉住 subline 仅在运行中的委派行持有活动事实时出现，以及按 kind 的文案。重新录制的 Web golden 携带修正后的 subline。

## 相关

- [Subagent 运行活动看门狗](2026-09-15-subagent-run-activity-watchdog.zh.md) —— 同一运行上的孪生边界：看门狗让沉默的已发布运行失败；本 note 观察活着的运行。
- [深度求索 pill 下的压缩进度 subline](2026-09-14-compaction-progress-subline.zh.md) —— pill subline 的先例；它的分支是本 note 阶段链的开头。
- [会话流中的在途 prompt 可见性](2026-09-14-inflight-prompt-visibility.zh.md) —— 共享运行轮次作用域的邻近轮次级折叠。
- [Web 后台任务展示](2026-08-08-web-background-job-display.zh.md) —— pill 的 job 分支所读取的 job 视图。
- [保留 ignorable 外部会话事件](../architecture/2026-08-30-retain-ignorable-external-session-events.zh.md) —— 规定这个新仅日志事件在未知构建上行为的"默认必读"规则。
