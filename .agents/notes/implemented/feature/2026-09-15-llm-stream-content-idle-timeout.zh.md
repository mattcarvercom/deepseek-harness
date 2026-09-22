# Agent Note: LLM 流内容空闲截止

Status: implemented

[English](2026-09-15-llm-stream-content-idle-timeout.md) | 中文

## 问题

两个 LLM（大语言模型）适配器都用同一个看门狗约束流——按读空闲计时器（`streamIdleTimeoutMs`），它在每个待处理的读上武装，并在任何流活动上重置。两个适配器都在非内容数据上重置它：DeepSeek 适配器在每条 SSE keep-alive 注释上调用 pulse（续时），pi-ai 适配器在它 SDK 发出的每个值上重置。一个持续发送这类活动、却从不产生模型内容的流——[讨论 #5007](https://github.com/deepseek-ai/deepseek-harness/discussions/5007) 在一 vLLM 端点上报告的症状类别——因此永远不会失败：看门狗一直被重置，流永不终止，请求无限期挂起。由于没有失败发生，重试策略（它重试的是失败，而不是沉默）没有可重试的对象，诊断也不会浮现。看门狗对它自己的输入——完全沉默的连接——是正确的，漏洞在于缺失的第二层：没有任何东西度量进展，只度量活动。

## 决策

`dsh-timeout` 新增 `progressDeadline(upstream, timeoutMs, code)` 原语，其时序模型与 `idleWatchdog` 不同：计时器在构造时武装，跨越待处理读之间的空档持续运行，只通过显式 `progress()` 调用重置；`timeoutMs <= 0` 是无定时器直通（信号就是上游本身或一个新的从不中止的 controller，`progress()` 与 `dispose()` 均为空操作）；已触发的信号永远不能再武装；`dispose()` 幂等。

两个适配器都在配置中新增 `streamContentIdleTimeoutMs`：不大于共享 `MAX_TIMER_DELAY_MS` 的非负有限数，默认 `600_000`（十分钟），`0` 为那些健康状态是首 token 前长时间沉默的端点恢复无界限行为。流以两个看门狗信号融合后的结果（`AbortSignal.any`）构造，每个流调用武装自己的截止，消费循环只在 token 级内容上推进它——`isTokenDelta`：非空文本或推理增量，或工具调用载荷——因此 keep-alive 注释、SDK 元数据值与 usage 帧从不延长它。触发的截止以 `LlmError('… stream content idle timeout after <ms>ms', 'TIMEOUT')` 使请求失败：DeepSeek 适配器在 catch 中分类它，pi-ai 适配器在每次取值后内联检查，因为 pi-ai SDK 会把流中抛出转换为带内错误事件，只有内联检查能让内容截止赢得这场竞争。

## 考虑过的替代方案

**用 pulse 种类标签（内容 vs 活动）泛化 `idleWatchdog`。** 否决：两层具有不同的时序模型，按需求重新武装的原语表达不出来。`idleWatchdog` 在每个待处理需求上武装、在结果上清除；内容截止必须在构造时武装、在没有读待处理期间继续运行、只按内容重新武装。标签参数仍会在第一个需求超时的时刻触发——恰恰是那个要紧的空档，即上一个值与下一次读之间的时间。

**在线路帧层面检测进展（任何非 keep-alive 帧，或任何 SDK 事件）。** 否决，改用 chunk 层面：两个适配器共享 `dsh-llm` 的映射 chunk 词汇表，因此这一个共享谓词 `isTokenDelta` 让两个适配器得到完全一致的进展定义，而无需任何一方维护按线路协议区分的"什么算元数据"词汇表。该谓词刻意比"任何数据"更严格：推理增量与工具调用载荷算进展，纯元数据不算。

**在默认重试策略中把 `TIMEOUT` 变为可重试。** 无需改动：`TIMEOUT` 已是 `DEFAULT_RETRYABLE_CODES` 的成员。缺陷在于失败从未发生，截止提供了它；策略形态不变。

## 后果

- 一个占用线路忙碌却不产生模型内容的流，现在会在内容截止处以 `TIMEOUT` 失败，默认五次重试策略会重试它，持续损坏的端点表现为有界、有诊断的失败，而不是无限期挂起。
- `streamContentIdleTimeoutMs: 0` 恢复变更前行为（只应用按读空闲看门狗）；十分钟默认容忍首 token 长延迟，包括扩展推理。
- `dsh-timeout` 的公共面增加一个原语；`idleWatchdog` 语义不变，两者在每个请求上融合成一个信号。
- 无会话事件、会话格式或线格式变化：截止是提供方内部的失败路径，其结果就是普通的失败请求诊断。
- 配置通过两个适配器既有的显式解析步骤解析新字段，解析器内部的 `?? DEFAULT` 与既有 `streamIdleTimeoutMs` 模式一致。

## 测试

`dsh-timeout` 测试钉住原语的完整契约：构造时武装、只经 `progress()` 重置、跨需求空档运行、`<= 0` 直通（包括新的从不中止 controller）、触发后守卫、幂等释放。DeepSeek 适配器测试钉住 keep-alive-only 流在截止处以精确 `TIMEOUT` 消息失败、持续产生内容的流越过截止存活、`0` 作为禁用，以及解析器校验（负数、非有限数、超上限被拒；`0` 与默认值被接受）。pi-ai 测试针对 SDK 事件流钉住同样三个行为，并额外钉住两场竞争：内容截止胜过 SDK 对已中止流的带内转换，以及零界限在调用方中止时保留带内 `aborted` 结束。

## 相关

- [Provider-routed LLM 适配器](../architecture/2026-07-14-provider-routed-llm-adapters.zh.md) — 本注记所补充的按读流空闲超时的适配器架构；该注记保留其决策。
- [事故复盘（postmortem） 0006：永不终止的 vLLM 流](../../../../docs/postmortem/0006-vllm-stream-never-terminates.zh.md) — 本注记的截止所关闭的事故。
- [`dsh-timeout`](../../../../packages/util/timeout/README.zh.md) — `progressDeadline` 与 `idleWatchdog` 的归属地。
