# Agent Note：pi-ai 路由限制每次请求保留的图片数量

Status: implemented

[English](2026-09-17-pi-ai-image-count-budget.md) | 中文

## 问题

pi-ai 适配器此前只有字节与像素预算（`maxRequestImageBytes`、`requestImagePixelBudget`、`requestImageMaxBytes`），没有任何上限约束一次请求保留的图片出现次数。当部署在限制每提示词图片数量的提供方之后——这里是一个以 `--limit-mm-per-prompt {"image":{"count":4}}` 启动的 vLLM 路由——会话历史累积到第五张图片（一张拖入的附件加上几张生成结果）后，每次请求都会失败，提供方的 `400 At most 4 image(s)` 以 `INVALID_REQUEST` 暴露出来。DeepSeek 适配器已经用 `maxImagesPerRequest` 加上 `dsh-compaction-image-offload` 解决了同样的形态。

## 决策

`PiAiProviderProfile` 新增 `maxImagesPerRequest`（默认 600，与 DeepSeek 适配器事实上无界的默认值一致；必须是正的安全整数，在 `resolveProfiles` 中校验）。`toPiContextWithImages` 将它作为共享 `requiredImageOffload` 预算的计数上限，与既有字节上限并列；任一上限被超出时抛出带待省略数量的 `IMAGE_OFFLOAD_REQUIRED` —— 与 DeepSeek 相同的恢复路径：`dsh-compaction-image-offload` 插件把选中的最旧出现位置记录进 `image/offload` 事件并重试该步骤，因此提供方永远不会看到超过其上限的图片数量。现在只设置计数上限时检查也会运行；两个上限都缺省时请求仍然无界。

部署在 `~/.dsh/settings.yaml` 的两个 eGPU 路由上都设置了 `maxImagesPerRequest: 4`，与 vLLM 的上限一致。

## 测试

`context.spec.ts` 新增计数上限用例：恰好达到上限的一张图片通过；两张图片对上限为一的配置以 `IMAGE_OFFLOAD_REQUIRED` 和 `offloadImages: 1` 拒绝。真实的 settings 文档通过严格 schema 解析后，两个路由都得到 `maxImagesPerRequest: 4`（用 `resolveProfiles` 针对 `~/.dsh/settings.yaml` 探测）。

## 考虑过的替代方案

**提高提供方的图片上限。** 只能推迟失败：历史会保留每一张生成的图片，数量迟早超过任何固定上限，而更高的上限会让每次请求的视觉编码开销成倍增加。

**只收紧像素或字节预算。** 两者都不对应数量；小图片仍会在远低于字节预算的同时超出提供方的每提示词数量上限。

## 后果

超出数量的会话会把最旧的图片持久省略为占位文本，并让模型继续看到最新的若干张。对没有每提示词图片上限的提供方，默认值保持与上游一致的行为。
