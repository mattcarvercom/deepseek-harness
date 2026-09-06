# Agent Note: 会话取消归档与已归档会话视图（Web）

Status: implemented

[English](2026-09-06-web-session-unarchive.md) | 中文

## 问题

[会话归档](2026-07-31-session-archive-global-set.zh.md)会把会话从所有显示面隐藏，但被隐藏的会话无法被触及：没有任何视图列出它们，行菜单的归档行也没有反向操作。被归档的会话在暗中不断累积——用户既看不到自己隐藏了什么，更无法把一个会话请回来。归档 note 已把恢复面记为后续工作：一个 UI 面加一个反向 RPC。本 note 就是那个面。

## 决策

**反向 RPC 是一次纯集合移除（`unarchiveSession`）；查看面是现有视图选项菜单内的"显示已归档会话"开关——默认关闭，因此没有任何常显 chrome 变化。**

- Registry：`ctx.workspaceRegistry.unarchiveSession(id)` 走 `enqueueOperation`，把 id 从 `archivedSessionIds` 中过滤掉。它刻意不做 `sessionKnown` 检查——取消归档一个不在集合中的 id 是幂等空操作，日志在归档之后才消失的会话也能顺利提回。保留的 `sessionIds` 槽位让被提回的行直接落回原位置，无需任何重新归组逻辑。
- RPC：`workspace.unarchiveSession({sessionId}) → {archivedSessionIds}` 复用归档的 request 与 value 类型（对称性：两者都以完整更新后的集合应答）；操作对未知 id 从不失败，因此不需要新的错误码。feed 既有的按集合差异发出的 `archived` 帧像其他变更一样发布变化。
- Client：`ClientWorkspaceModel.unarchiveSession` 与其归档同族一样安装回声；`IWorkspaces` 面与 `UiWorkspaceService` 转发它。`tree.ts` 新增一个贯穿 `deriveGroups`、`deriveFlat` 与 `deriveSearchResults` 的 `showArchived` 标志：隐藏集合在开关关闭时是 `archivedSessionIds`，打开时是空集合，因此同一个 `sessionVisible` 分支服务两种姿态，被提回的行保留其保留槽位。`SessionNode.archived` 标记被提回的行，用于暗淡标题与菜单互换。
- UI：视图选项弹出层新增一条分隔线、一个"已归档"区段标签与一行"显示已归档会话"勾选项（通过 Menu 的 `selectedIds` 呈现勾选）。被提回的行在分组、单列表与搜索各面中按其保留位置以暗淡样式渲染（`--dsw-alias-label-dimmed`）；行菜单把归档换成取消归档，复用归档图标，因为 `ui-primitives` 中没有取消归档图标。开关存放在入口声明的视图 store 中（`showArchived`，持久化键升到 `dsh.workspace.view.v6`）；取消归档失败时告警并保留该行。

## 备选方案

**独立的已归档会话面板或第二个浏览器 tab。** 为一个小而很少触碰的集合增加更多 chrome，并把浏览器的单一行词汇表劈成两半；放进现有视图选项的过滤器保住了单一面与单一行设计，默认 DOM 不变（e2e fixture 无需重录）。

**像 `archiveSession` 一样要求 `unarchiveSession` 的 session 已知。** 表面上对称，但取消归档没有任何可校验的归组：它唯一的副作用是集合移除，而拒绝一个在日志清理前归档过的用户，会让集合里留下集合差异帧无法清除的 id。幂等才是诚实的契约。

**新增取消归档图标。** 图标库没有取消归档箭头；复用归档图标并配上反向标签，让成对图标在视觉上保持关联，把图标工作留给更大范围的图标更新。

## 影响

- 已归档会话可以从现有浏览器查看与提回；默认视图与此前逐字节相同（开关关闭），因此已发布的 e2e fixture 无需重录即可回放。
- 持久化键升级是一次性 client 重水合：新的 `showArchived` 字段无法并入原始 JSON 的重水合路径，因此旧键的状态被丢弃而不是被误读。
- 取消归档恢复的是位置，不是状态：会话的日志、标题与交互保持原样；提回时不重新派生任何东西。
- 删除仍是破坏性同族操作：`removeSession` 依旧剥离归档成员身份，取消归档也永远不会复活一个已删除的会话（其 id 已从所有记录中消失）。

## 测试

`packages/workspace/workspace` 的 registry 规格固定了移除、幂等空操作、持久化与日志已消失 id 的提回；workspace-controller 的 host/model/transport 规格固定了命令、回声安装与 facade 错误映射；`tree.client.spec.ts` 固定了被提回行在分组、单列表与搜索中带标记落在其保留槽位，以及隐藏集合的翻转；store 规格固定了开关默认值与动作；browser 与 rows 规格固定了开关行、被提回的暗淡行、菜单互换与两处失败告警。web e2e 通道（`apps/web/tests/workspace-management.e2e.ts`）固定了浏览器往返：过滤器把暗淡行提回其保留位置，行菜单换成反向动作，取消归档无需对话框即提交并清空集合，过滤器关闭后恢复的行仍然可见。
