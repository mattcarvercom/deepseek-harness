# Agent Note: Verify context-overflow compaction actually fits before retrying

Status: implemented

[English](2026-09-14-overflow-recovery-retry-verification.md) | 中文

## 问题

一次真实的 dsh 会话卡住了大约 41 分钟，先后经历了 7 次以上完全相同的 `CONTEXT_WINDOW_EXCEEDED` 失败，最终该轮次仍以同一个错误结束。此结论通过会话自身的事件日志诊断得出（`assistant/attempt` 流式 chunk 携带 `finish.reason.kind: "error"`，分布在相隔数分钟、不同 step 的多次记录中）。

`BasicCompactionEngine` 的 `agent/request-error` listener 此前已经会响应提供方确认的 `CONTEXT_WINDOW_EXCEEDED`：它会强制执行一次 context-overflow 压缩，并在 `agent.session.surface.replaceGeneration` 超过压缩前的值时授权重试。这个判定标准回答的是「压缩是否持久地改变了表层」，而不是「压缩是否让下一次请求重新回到模型自身的上下文窗口以内」。

`selectCompactableRange`（此触发场景下以 `retainTokens: 0` 调用）刻意从不缩减最新的平衡表层单元——该区域事务无法拆分一个不可分的工具调用／结果对，也无法拆分最新的一条消息。当这个受保护的最新单元本身正是溢出成因时（在此次真实事故中，是智能体在每个 step 反复重新读取同一个大文件），一次压缩通常能可靠地缩小*更旧*的历史——这是真实、被记录下来的进展——而真正超量的内容却原封未动。仅看 generation 是否前进的判定把这种情况当作完全成功，从而授权了一次在数学上必然会得到相同 400 错误的重试。

按 agent 计数的 `overflowRetries` 预算（`maxOverflowRetries`，默认值 1）只在*单次溢出事件内*限制重试次数；它会在 `agent/status` 变为 idle，或此后任意一次成功的 `assistant/message` 时被重置。一个轮次如果在溢出事件之间穿插了真实的成功工作（更多工具调用、更多文件读取），就会不断重新武装这个预算，使得「压缩不足→仍然重试」的循环可以在一个长轮次中反复发生多次，而不是在第一次就快速失败。

另有一点经过单独确认并已排除为本次真实事故的成因，但值得记录：`dsh-llm-retry` 的 `mode: 'always'` 策略完全没有失败代码过滤（这是刻意设计，其自身文档注释写明会重试「每一次模型请求失败」），也没有重试次数上限，因此如果某个提供方 profile 采用该配置，且位于一个已经放弃处理的 compaction-basic listener 下游，就会无休止地重试一个根本不可能成功的 `CONTEXT_WINDOW_EXCEEDED`。本次事故涉及的提供方使用的是未配置时的默认值（`mode: 'normal'`，且 `CONTEXT_WINDOW_EXCEEDED` 不在 `DEFAULT_RETRYABLE_CODES` 之中），因此 `llm-retry` 每次都正确地放弃并交给 compaction-basic 处理；它并未导致本次事故。此处未做改动——这是一个真实存在的缺口，但属于一个独立的、刻意排除在本次范围之外的策略问题，即 `'always'` 模式应当排除哪些失败代码。

## 决定

`packages/compaction/compaction-basic/src/index.ts` 中的 `agent/request-error` listener 现在仅在以下两个条件同时成立时才会授权重试：表层替换 generation 已经前进，*并且*会话当前的测量大小已经重新回落到路由目标自身压力阈值以下（`resolveCompactSpec(policy, context.contextWindow).thresholdTokens`——与 `'pressure'` 触发路径已经信任的、经过 `thresholdRatio` 缩放的同一个安全余量数值，直接复用而非发明新的判定标准）。该检查应用于两条分支：常规成功路径，以及此前把「剪枝已落地但摘要抛出异常」视为足够重试证据的既有 catch 分支。

该检查位于新增的私有辅助方法 `isUnderOverflowThreshold(agent, policy, target, signal)` 中：它通过 `ctx.llm.resolveModelInfo` 解析目标的上下文容量，解析出压缩规格，并将 `ctx.tokenMeter.measure(agent.session).totalTokens` 与 `spec.thresholdTokens` 比较。容量查询失败、`context` 未定义，或 `resolveCompactSpec` 抛出异常，均返回 `true`（放行之前仅看 generation 的行为）——与溢出本身无关的配置缺口不应因这次改动而新增地阻塞恢复。

当该检查报告仍处于阈值之上时，listener 会记录一条独立的警告并调用 `next()`——保留原始的提供方错误——而不是授权一次会重复该错误的重试。`compactIfNeeded` 自身的 `'context-overflow'` 分支保持不变：它仍然只执行一次尽力而为的压缩；新增的校验完全位于决定这次压缩是否「值得」重试的调用方逻辑中。

## 替代方案

**让 `compactIfNeeded` 的 `'context-overflow'` 分支像 `'pressure'` 分支一样循环，在仍超过阈值时抛出异常。** 已否决：既有的 catch 分支已经把「抛出异常之前 generation 已前进」当作足够的重试证据（用于处理「剪枝已落地、随后摘要失败」这一合理场景），因此一次「有进展但仍不足够」的压缩若以抛异常方式失败，同样会落入这个分支并被照样授权——修复必须落在授权重试这一决策本身，而不是让 `compactIfNeeded` 换一种方式抛出异常。

**与原始 `contextWindow` 比较，而不是与经比例缩放的 `thresholdTokens` 比较。** 曾经考虑过，但引发本篇 Note 的那次真实 400 错误，其成因正是输入 token 与请求的输出 token 合计超过窗口（117,233 输入 + 32,768 请求输出 = 150,001，超过 150,000 的窗口）；而 token meter 的测量只覆盖输入。`thresholdTokens`（默认取窗口的 80%）已经是本系统对这类余量问题的现成答案，已按部署配置，也已经在 pressure 路径中被实际使用——复用它无需新增可配置项，也无需把待发送请求预留的输出预算一路传递过来。

**扩大 `dsh-llm-retry` 的 `'always'` 模式，使其排除 `CONTEXT_WINDOW_EXCEEDED`。** 本次未做。`AlwaysRetryPolicyConfig` 明确将「无限重试每一次模型请求失败」写入了文档化的契约；悄悄收窄这一行为会改变该公开、已文档化策略语义对所有 `'always'` 模式使用方的影响，而不仅仅是本次场景。它也并未导致本次被诊断出的事故（受影响的提供方使用的是默认的 `'normal'` 策略，该策略本就已经排除这个代码）。作为一个已知、被单独划定范围之外的缺口保留。

## 后果

当 context-overflow 的成因是单个超大、最新、受保护的表层单元时，现在会在第一次尝试时就以原始提供方错误快速失败，而不再可能只要轮次持续产生穿插的成功 step 就无限循环下去。这是一个比此前更严格的契约：一次只缩小了大小、却未确认结果确实能放得下的压缩，不再被当作恢复成功。对于依赖旧有尽力而为语义的部署，当一次压缩确实能重新回到阈值以下时（既有测试套件覆盖的常见情形），或当目标容量／策略无法解析时（回退到旧行为），行为不会发生变化。

`llm-retry` 的 `'always'` 模式缺口依然真实存在且相互独立：如果某个提供方 profile 显式配置为该模式，在 compaction-basic 放弃处理后，它仍可能无限重试一个 `CONTEXT_WINDOW_EXCEEDED`（或任何其他结构性不可恢复的代码）。这不在本次改动范围内；在此标注，留给下一位处理该策略代码过滤逻辑的人。

## 测试

`packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts` 新增了 `PersistentOverflowAdapter`（每一次对话请求都会溢出；引发问题的内容是最新的表层节点，`selectCompactableRange` 从不触碰它）以及一个新用例「does not retry a request a compaction pass could not bring under threshold」：断言只尝试了一次对话请求、一次真实的压缩（`compaction/start` → `compaction/summary` → `compaction/end`）确实运行过并处理了更旧的种子历史，并且该轮次以 `reason: { kind: 'error' }` 结束，而不是发起重试。

`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` 中「preserves the newest whole tool-call/result pair during forced overflow compaction」这一用例此前使用了一个 1,000 token 的测试上下文窗口，在该窗口下，受保护的最新工具调用／结果对本身（约 2,000 多个启发式 token）永远无法通过新的阈值检查——这是本次修复所针对场景的一次意外实例，与该测试实际想要验证的内容（被保留的这一对内容保持完整且平衡）无关。已将其放宽为 `createContext(10_000)`，与同一文件中其他使用相同 `toolConversation()` 夹具的兄弟用例保持一致。

`packages/compaction/compaction-basic`、`packages/core/agent-loop`、`packages/llm/llm-retry` 与 `packages/core/agent` 的完整套件全部通过（201 个测试）；仓库范围内的 `typecheck` 与 `lint` 均干净通过。
