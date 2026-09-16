# Agent Note: 运行中轮次 pill 上的终止子级动作

Status: implemented

[English](2026-09-15-subagent-kill-child-action.md) | 中文

## 问题

kill 控制交付了人类可寻址的 `session.killSubagent` Remote，活动观察为运行中轮次 pill 提供了 subagent 阶段——但 pill 从未暴露该控制。kill 以子级持久 session id 寻址，而客户端没有任何面承载该 id：活动载荷观察的是子级的阶段与标签，不是它的地址。一个正在注视飞行中 subagent 阶段的人类，无法从正在显示它的这个面停止该子级，也没有其他轮次内面携带该地址。

## 决策

`subagent/activity` 载荷获得可选的 `childSessionId`，工具只在进程内（本地）运行时设置它：此时运行的 `id` 即 kill 所寻址的已发布子 session id。进程外运行携带 parent 命名空间内唯一、kill 无法到达的 id，因此省略该键，pill 隐藏动作。该键是真正缺席而非 `undefined`——`exactOptionalPropertyTypes` 适用于发射方、ui-chat fold、pill 派生与 `TurnStatus` 调用点——因此不认识该字段的消费方只会永远看不到它。

latch 时序是显式的：在 scripted 流程中，`onStart` 在 `start()` 内部同步触发，早于运行存在，因此第一条活动记录可以合法地先于 latch 而不带该键；id 落在 `start` 结算之后的记录上。前台调用在结算时同步 latch；后台调用在结算后的微任务中 latch。pill 反映最新一条 latched 事实，因此 latch 前的记录先渲染无动作的阶段，id 到达后动作出现。

pill 在其 subagent 阶段上长出 `终止子代理` 动作，仅当阶段携带 `childSessionId` 时存在。点击调用 ui-chat inject 面新增的 `killChild` 入口，`apply` 将其映射到 `session.killSubagent`。失败的 kill——非 ok 的 `RemoteResult` 或传输故障——被吞掉：子级消失后 kill 只是被接受的 no-op，而子级的活动事实在子级结算前一直挂载该动作，因此动作天然可重试。文案由 locale 拥有（`chat.action.killChild`）。

## 曾考虑的替代方案

**在 pill 中展示子 session id，把 kill 留给其他面。**id 是内部地址；展示它不会在该位置增加任何可用控制，也没有其他轮次内面寻址单个子级——subagent 面板是事后的 transcript 面，`interrupt_agent` 归模型所有。

**把 kill 挂到 subagent 只读 composer 或面板上。**这些面属于子级 session，而 kill 是父级 session 面上的动词。pill 是显示飞行中阶段的面，停止被观察运行的动作应归属在那里。

**用 toast 显示 kill 失败。**失败要么已经无意义（子级已结算，kill 为被接受的 no-op），要么可重试（子级仍在运行，动作保持挂载）；对一个在结算前保持可用的 fire-and-return 控制，toast 只制造没有可操作状态的噪音。

**提升 `SESSION_FORMAT_VERSION`。**这是已 ignorable 载荷上的可选字段：不知道该事件类型的构建会整体忽略该事件，知道类型的构建把字段视为可选；没有任何结构变化触及已知事件。

**在可继续分支也携带 id。**可继续分支的 recorder 从不武装（无活动事件、无 pill 阶段），且可继续子级有自己的结算通知与消息/中断面；不存在会消费该地址的 pill 状态。

## 后果

- 用户可以直接从运行中轮次 pill 停止进程内一次性子级；kill 是 fire-and-return，对已消失子级的重复点击是被接受的 no-op。
- 进程外（远程）子级隐藏该动作：其地址不可被 kill 到达，可见的 no-op 按钮会误导。
- latch 前的记录合法地缺少该键；在 latch 落地之前——至多 `start` 结算前发射的记录——pill 显示无动作的阶段。
- `ISession` 被加宽出 `killSubagent`，因此每个客户端测试夹具的 session 面都必须桩接它；`FixtureSession` 的桩 fail-loud，未桩接的假面不能悄悄通过。
- 没有新事件类型，没有格式版本提升，也没有已记录会话输出的变化：`subagent/activity` 仅面向 UI 且 ignorable，因此黄金回放逐字节一致。
- 没有新增 web e2e：Remote 传输由 kill 控制的 session-client 与 remote 规格固定，客户端规格端到端固定 pill 接线（事实 → 阶段 → 按钮 → inject → `Session`）。

## 测试

tool-subagent 规格固定 latch：后台本地运行用 held gate 让第一条记录先于 latch（键缺席），latch 后的记录携带 id；前台运行中 latch 前的第一条记录不带键、后续记录携带；既有远程运行测试断言键保持缺席；可继续测试保持沉默（无活动事件）。ui-chat 规格固定客户端侧：fold 的 upsert、替换（移动或丢失 id 即事实变更）与键缺席；rebuild 在调用结算前携带 latched id；pill 派生携带获胜事实的 id 或省略；`ChatView` 为 latched 事实渲染本地化的终止按钮、对 unlatched 事实隐藏，点击以子级 id 路由到注入的 `killChild`；apply 规格固定 `Session.killSubagent` 调用与静默 reject 分支。test-support 运行时规格固定裸 `FixtureSession` 桩在未桩接调用上 fail-loud。cordis inspect-catalog 再生器固定加宽后的 `ISession` 声明。

## 相关

- [Subagent 活动观察与运行中轮次 pill 阶段](2026-09-15-subagent-activity-observation.zh.md)——本 note 所扩展的载荷与本 note 所修改的 pill。
- [Subagent kill 控制](2026-09-15-subagent-kill-control.zh.md)——本动作所调用的 `killSubagent` Remote。
- [locale 拥有的客户端 UI 文案](../architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)——按钮文案的字典归属。
