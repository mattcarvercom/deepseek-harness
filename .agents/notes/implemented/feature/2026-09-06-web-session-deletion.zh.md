# Agent Note: Web 会话删除（持久、不可恢复）

Status: implemented

[English](2026-09-06-web-session-deletion.md) | 中文

## 问题

会话悬停菜单原有重命名、Fork 与归档三个操作。[归档](2026-07-31-session-archive-global-set.zh.md)只把会话从所有展示表面隐藏，日志及其派生数据永远留在磁盘上。一次性会话——实验、测试运行、跑偏的对话——会无限累积：它们的 JSONL 会话目录（每一代日志加锁残留）、`~/.dsh/storages/session_projcache` 里的 `session_projcache` 行、以及工作区注册表记录内的 id（`sessionIds`、header 索引、归档集合）。产品此前没有释放这些存储的路径：归档是隐藏，不是清理。菜单里最初的"删除会话"行只是一个视觉占位（无处理器），在归档集合上线时被归档替换。

## 决策

**悬停菜单新增第四行"删除会话"，确认弹窗明确该操作不可恢复；确认后客户端调用新的 `sessions.delete` Remote，宿主按一个有序生命周期执行：拒绝、释放 Agent、销毁日志、尽力（fail-soft）清除派生数据、最后发布事件。**

- UI：`ui-workspace` 的行在重命名/Fork/归档旁新增 `delete` 菜单行（文案归属语言包，zh/en 提供 `menu.deleteSession` 与 `deleteSession.*` 字典）。确认后弹出对话框，说明日志与全部内容将被销毁且无法撤销；确认按钮是唯一破坏性控件，Remote 执行期间显示进行状态。
- 宿主：`SessionDeleteController.delete`（`packages/api/session-controller/src/delete.ts`，`@Remote('delete')`）从已附加的 `ctx.sessions.get`、否则 `sessionPersistence.stat` 解析会话头（确定缺失 → `session/not-found`，details 携带会话 id），以共享的 `session/agent-busy` 拒绝子代理拥有的会话，然后 `ApiSessionAgentController.disposeAgent` 停止存活的 Agent——保留表（retention map）条目在 `handle.dispose()` 执行前移除，`agent/disposed` 监听器会清掉并发 create/resume 在释放期间重新登记的条目。
- 存储：新增 `SessionPersistence.delete(id)` 抽象方法。JSONL 后端在本进程存在打开句柄时拒绝（`SessionAlreadyOwnedError`——未物化的 pending 会话必然挂着它的创建者句柄，因此打开句柄探针已覆盖它），然后销毁该 id 的会话目录（每一代日志加锁残留，按会话名解析，与编码和布局无关）或旧式扁平产物，并清除该 id 的冷日志记忆。返回 `true`/`false` 报告数据是否存在；持久化失败在任何清理步骤之前中止操作，因此失败的删除绝不会发布移除事件。
- 尽力派生清除，顺序执行：`sessionProjectionCache.remove(id)`（行及其挂起的写回状态；失败只告警——没有日志的行是惰性的，冷读无法服务它）与 `workspaceRegistry.removeSession(id)`（从每条记录的 `sessionIds`、header 索引、归档集合中剔除该 id；残留的记录 id 对列表是惰性的，因为列表由持久化驱动，且注册表在下一条记录变更时会清除它）。`api-session/removed` 只在持久化日志删除提交之后发出。
- 客户端：`ISessions.delete` / manager 的 `deleteSession` 转发 Remote；service 的 `delete` 在任何宿主失败时抛错，成功后立即通过共享的会话移除路径清除本地行（转发的 `api-session/removed` 帧会幂等地重复该操作）。若打开的会话被删除，选择回落到新建会话视图，与其他移除情形一致。

## 已考虑的替代方案

**墓碑或软删除加恢复窗口。** 会把该操作要释放的存储保留下来，且会话域没有服务墓碑的恢复表面；产品决策是确认过的删除不可恢复，这正是弹窗所陈述的。

**Agent 存活时拒绝删除，而不是在操作内部释放。** 生命周期更简单，但把"先停止会话"的额外步骤推给用户，并使该命令成为部分命令；在操作内部释放使命令成为完全命令，运行中的回合会被释放取消。

**缓存或注册表清除抛错时让删除整体失败。** 走到那一步时日志销毁已经提交；对一个实际已完成的删除报告失败——或回滚日志去对齐——比留下惰性残留（没有日志的行、没有持久化的 id）更糟，后者没有任何表面能列出或服务。

**把持久化删除排在派生清除之后。** 派生表故障会掩盖仍完好的日志，且后续重试可能重复报告；持久化日志是事实来源，所以它最先、也是最硬地失败。

## 后果

- 删除按设计不可恢复；确认弹窗是唯一防线，且它明确说明。
- 若某个存活 Agent 不在保留表中，它会留下打开的持久化句柄，`delete` 便以 `SessionAlreadyOwnedError` 响亮地拒绝，而不是销毁一个进行中的会话——对破坏性操作而言，响亮拒绝是期望的失败模式（当前没有任何路径会留下未保留的存活 Agent）。
- 尽力清除失败会留下惰性残留——没有日志的投影缓存行、没有持久化的注册表 id——任何展示表面都不会列出，任何冷读都无法服务；后续写入会清除或忽略它们。
- `~/.dsh/storages/session_projcache` 与工作区注册表记录不再累积一次性会话的 id。
- 归档仍是非破坏性的姊妹操作；删除一个已归档会话是允许的（注册表清除同时抹掉它的归档集合条目）。

## 测试

`tests/session-delete.host.spec.ts` 通过组合宿主驱动 Remote（冷路径与存活 Agent 路径、子代理拒绝、未命中、以及每个尽力失败与其告警）；JSONL 套件负责目录/扁平产物销毁、打开句柄拒绝与 stat 故障重抛；持久化契约套件负责抽象 `delete` 语义（含从未物化的空操作）；缓存与注册表套件负责 `remove` 和 `removeSession` 的行/记录/账务行为；客户端测试替身与 ui-workspace 行/弹窗规格覆盖菜单、弹窗文案与幂等的本地移除。
