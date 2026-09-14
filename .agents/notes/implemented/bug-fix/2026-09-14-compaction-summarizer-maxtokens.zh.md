# Agent Note: Raise compaction-basic's default summarization maxTokens

Status: implemented

[English](2026-09-14-compaction-summarizer-maxtokens.md) | 中文

## 问题

一次真实的 dsh 会话（"Deep diving"，`~/dev/mattcarvercom`，路由到 `vllm-3090`/`qwen3.8-27b`，150k 上下文）在当天早些时候的重试授权修复（[[2026-09-14-overflow-recovery-retry-verification]]）已经生效之后，仍然持续数小时反复遇到 `CONTEXT_WINDOW_EXCEEDED`——那次修复正确地阻止了会话在同一个无法修复的溢出上无限循环，但用户依然被卡住：几乎每个轮次都会在开始后不久再次触发溢出。

从同一会话解压后的事件日志（`session.v3.jsonl.zstd`）诊断得出：在受影响的这几个小时里，大多数 `compaction/start` → `compaction/end` 配对都携带 `error: "summarization truncated at the token cap (incomplete checkpoint)"`，而不是落地一个 `compaction/summary`。这个错误来自 `packages/compaction/compaction-basic/src/summarizer.ts` 的 `finishError()`，由辅助摘要调用的 `finish.kind === 'max-tokens'` 映射而来——模型在摘要尚未完成前就耗尽了自己请求的输出预算。`compactSurfaceRegion` 的事务只会在 `summarizeCompaction` 成功后才提交替换，因此一次被截断的摘要调用什么都不会落地：没有缩减、没有进展，紧接着的下一次请求（或下一个轮次）会再次撞上完全相同的超量提示词。

`compaction-basic` 的摘要调用请求一个固定的 `maxTokens`（默认 `8192`，本次部署未做配置），与被遮蔽区域的实际大小无关。同一份日志中成功的压缩，其遮蔽区域大小相当一致地偏大（`shadowedTokenCount` 78132–101411 token）——把这么多密集、充满代码与细节的智能体对话，压缩进该软件包要求的 8 个结构化 Markdown 小节检查点中（保留「精确的文件路径、命令、错误字符串、标识符、数值、函数签名」），本身就有可能合理地需要超过 8192 个输出 token。软件包自己的架构 Note 早已直接点名过这类风险："provider output caps can be spent on hidden or surfaced reasoning tokens and summary size is unpredictable"（提供方输出上限可能被隐藏或显式的推理 token 消耗，摘要大小也不可预测）——本次部署正是反复撞上了这一点，而固定默认值对这两个因素都没有留出余量。

一项并行调查沿着 `@earendil-works/pi-ai` 的 `openai-completions` 适配器（`resolveChatTemplateKwargValue`／`qwen-chat-template` 分支）追踪了路由模型实际的 `enable_thinking` 线上派发逻辑，专门检查隐藏推理 token 是否正是成因：在未请求任何 `reasoningEffort` 的情况下，两条派发路径针对该路由都会计算出 `enable_thinking: false`，因此就当前配置而言，推理很可能*不是*本次这个具体模型的直接成因。这使得摘要本身的必要大小成为证据更充分的主要解释——不过软件包自身已记录的不确定性（"summary size is unpredictable"）意味着，无论是这一因素还是推理因素，都有可能在其他提供方或模型上再次出现。

## 决定

将 `packages/compaction/compaction-basic/src/config.ts` 中 `resolveConfig()` 的内置默认值从 `maxTokens: 8192` 提高到 `maxTokens: 24576`（3 倍）。这只是默认值——`BasicCompactionConfig.maxTokens` 与按路由的 `modelPolicies[].maxTokens` 覆盖项保持完全可配置、未受影响；需要为特定路由设置不同数值的部署，早已拥有这个机制。

24576 这个数值是依据观测数据而非随意选定的：诊断会话中观测到的最大遮蔽区域约为 10 万 token，而 `compaction-basic` 的压力触发只会在总用量越过 `thresholdRatio × contextWindow`（默认 `0.8`，即 150k 窗口下的 120,000 token）后才会触发——因此即使采用这个更大的上限，辅助摘要调用自身的请求（回放的遮蔽区域前缀加上这个 `maxTokens`）在大多数路由模型自身的上下文窗口下仍有相当余量，同时也为一份确实较长的结构化检查点、以及在某些模型上确实存在的推理 token 消耗，留出了真实的缓冲空间。

## 替代方案

**为摘要调用显式关闭推理**（在其 `GenerateOptions` 上设置显式的 `reasoningEffort`）。未采用：对 `@earendil-works/pi-ai` 实际派发逻辑的追踪表明，对于该路由的当前配置，完全省略 `reasoningEffort` 本就已经解析为 `enable_thinking: false`（`options.reasoningEffort` 在省略和显式传入 `'off'` 两种情况下都是假值，`resolveChatTemplateKwargValue` 的 `!!reasoningEffort` 在两种情况下都计算为 `false`）——因此显式传入 `'off'` 在这里只是一次空操作，而非真正的修复；而且 compaction-basic 也没有一种与提供方无关的方式来请求"可用的最低有效等级"，若要实现又会引入软件包一直刻意避免的厂商特定耦合。

**在本次部署自己的 cordis.yml／preset 中添加按模型覆盖，而不是改动软件包默认值。** 曾经考虑过，但本次部署实际使用的 preset（`~/.dsh/.agent-presets/standard-nosearch/agent.cordis.yml`）是一份本地的、不在仓库中的定制文件——只把修复放在那里，既无法惠及运行同一分支的其他人，也不会像用户要求的那样出现在 `git log`／PR review 中。软件包默认值本身也被观察到（与这一条具体路由无关）偏低，这与架构 Note 自身对摘要大小不可预测性的一般性警告相符——值得从源头修复，而不是逐个部署地打补丁。

**让 `compactIfNeeded` 的 context-overflow 分支在遇到 `max-tokens` 截断时以更大的 `maxTokens` 重试，类似 pressure 分支的 `compactionRetries` 循环。** 这是一个侵入性更强的行为改动（增加了第二个重试维度，需要自己的预算／退避策略，触及该事务的失败／重试语义），而对于目前实际观测到的区域大小，一次简单的默认值提升就已经足够解决问题。留待未来——如果提高后固定上限仍不够用——再做改动。

## 后果

压缩那些内容详尽、密度较高的对话片段（本机常见的智能体编码对话）时，现在在触及自身输出上限之前，大约多出 3 倍的空间来完成一份完整的检查点，且无需任何部署侧配置。如果某次部署所路由模型的上下文窗口小到一次 24576 token 的摘要调用加上其回放前缀本身就有溢出风险，应当通过 `modelPolicies` 为该路由设置更小的 `maxTokens`——新默认值假定的是本机以及当前大多数智能体编码模型所处的 128k 及以上上下文级别的路由。

这并不能修复 `summarization truncated at the token cap` 的所有可能成因：异常巨大的遮蔽区域，或者某个模型尽管经过上面的派发追踪仍确实在这次调用上消耗了真实的隐藏推理 token，都仍可能导致截断。`overflowRetries`／`maxOverflowRetries` 以及当天早些时候的重试校验修复，仍然是让一次仍然截断的压缩快速失败、而不是陷入循环的最后一道防线。

## 测试

将 `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` 中 `resolveConfig({})` 的默认值断言更新为 `maxTokens: 24576`。没有其他测试硬编码了旧的默认值（两处显式写出 `maxTokens: 8192` 的测试都是把它作为覆盖值传入，不受内置默认值影响）。`compaction-basic`／`agent-loop`／`llm-retry`／`agent` 的完整套件（201 个测试）、仓库范围的 `typecheck` 与 `lint` 均通过。

**同一分支中一并修复**：当天早些时候那次修复的后续提交，把 `compaction-basic/src/index.ts` 中三处 `oxlint-disable-next-line typescript/no-unnecessary-condition` 注释当作看似未使用的内容删除了，但当时仅通过对那一个文件单独运行 lint（`npx oxlint <file>`）来验证——这种方式缺少完整的跨包 TypeScript 项目类型信息，产生了错误的"未使用"结果。仓库真正的门禁（`pnpm run lint`，会先构建 host 面以获得完整类型信息）仍然需要这三处注释；在本分支上一次干净的全量运行在合并前就发现了这个回归，已将其恢复。**留给下次的教训**：不要相信单独针对某一个文件的 `oxlint` 运行来判断某个类型感知的指令是否真的未被使用——只有完整的 `pnpm run lint`（或具备完整项目已构建类型信息的等价运行）才对 `typescript/*` 规则具有权威性。
