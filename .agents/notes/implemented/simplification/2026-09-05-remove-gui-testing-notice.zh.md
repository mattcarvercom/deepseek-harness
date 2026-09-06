# Agent Note: 移除 GUI 内测声明

Status: implemented

[English](2026-09-05-remove-gui-testing-notice.md) | 中文

## 问题

[共用弹窗的产品引导](../feature/2026-08-13-shared-modal-product-onboarding.zh.md)决策在 DeepSeek 凭据弹窗之前恢复了一个简洁的测试阶段声明。在本 fork 上，这份声明唯一的读者就是运行自己本地部署的维护者本人；只要 `settings.yaml` 未确认 `welcomeNoticeVersion` 或被重置，每次首次使用都会再次弹出这个插页，却已经不再带来任何收益。

## 决策

本决策将该声明从产品组合中彻底移除，与[首次全屏内测声明移除](../../archived/simplification/2026-08-13-remove-first-run-beta-notice.md)的做法一致。`ui-settings-models` 不再登记 `welcome-notice` 步骤：声明的组件（`WelcomeNotice.tsx`／`.module.css`）、store（`welcome-store.ts`）、文案持有者（`onboarding-copy.ts`）及本地化字段全部删除，只剩 `deepseek-official` 作为该插件在 `settings.onboarding` 中唯一的注册项。Host 端仍保留 `ui-onboarding` namespace 的注册，使仍带有旧 `welcomeNoticeVersion` 的 settings 文档保持有效，这一点与首次移除时的理由不变。只用于验证已删除步骤的测试覆盖——`welcome-notice.client.spec.tsx`、`welcome-store.client.spec.ts`、`remote-welcome.e2e.ts`、`apply.client.spec.ts` 中两个仅涉及欢迎声明的用例，以及 e2e 的 `welcome.expected.md` golden——一并删除而非改指别处，因为已经没有它们需要钉住的行为。

## 曾考虑的替代方案

**不做版本升级，只加一个本地「不再显示」开关。** 不采用：一旦整个步骤都不存在，第二套无版本的抑制机制只是重复已有的 `welcomeNoticeVersion` 字段，没有任何实际收益。

**保留声明，只是精简或软化文案。** 不采用：对单一本地维护者而言，凭据弹窗之前的任何首次使用插页都是摩擦，与文案措辞无关。

**只在维护者自己的 workspace 中跳过声明，靠一个配置开关控制。** 不采用：本 fork 始终只会走同一个分支，为它设一个按部署区分的开关等于持有两条路径却只用一条；代码库里也没有其他地方会读取它。

## 后果

新的回环 profile 现在会在没有任何可用提供方时直接进入行内 DeepSeek 密钥弹窗，不再有前置步骤。`deepseek-official` 保留既有的 order-`0` 注册，以及它的[共用弹窗](../feature/2026-08-13-shared-modal-product-onboarding.zh.md)展示与[步骤自持的接管界面框架](../bug-fix/2026-08-06-onboarding-step-owned-takeover-chrome.zh.md)机制——这两者均以通用方式描述协调器与 slot 约定，并不钉死固定的步骤数量，因此仍然成立。`ui-onboarding.welcomeNoticeVersion` 仍是一个有效但惰性的 settings 键。若本 fork 未来要重新引入任何首次使用声明，需要一个新的版本化字段与一份新的 Agent Note；被移除声明的文案与版本号只留存于 git 历史中。
