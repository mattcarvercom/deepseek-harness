# Agent Note: slot 扫描对扫描中途被删文件的容忍

Status: implemented

[English](2026-09-15-slot-scan-vanished-file-tolerance.md) | 中文

## 问题

客户端 slot catalog 的扫描器 glob 每一个包源码目录，随后读取每个列出的文件：[slot-walk.ts](../../../../scripts/slot-walk.ts) 里的两个循环——slot 契约扫描与导出类型索引——共同供给 `cordis inspect what:"client"` 所教的那个 catalog。

oxlint 契约 spec 会往包 src 目录写入短命的 `oxlint-contract-<uuid>.ts` 探针来验证逐文件类的 tsconfig 发现，并在其 `finally` 中删除。它与 catalog spec 运行在同一 full-suite job 的独立 fork worker 中。catalog 的 glob 可能列出 oxlint worker 已经删除的探针，其后的读取抛出 ENOENT，整个扫描失败。窗口很小且是概率性的：该失败无法按需复现，一次完整的 `test:coverage` 运行正是在它上面失败的，而同一组 spec 在所有聚焦运行中都通过。

## 决定

两个循环都通过共享的 `readListed` 读取每个列出的文件：缺失的文件被报告为 `undefined`（循环跳过它），其余任何读取错误原样重抛。

- ENOENT 是唯一被容忍的码。探针不携带 slot 契约头，所以即使被完整读取的探针也不贡献任何东西；而在列出与读取之间被删的文件也不可能悄悄改变 catalog，因为该扫描读取全部源文件本身即是其穷尽性兜底——声明在扫描中途消失的 slot 会以被拒绝的注册（未声明 slot 的盲区）现形，门禁响亮地失败，而绝不会是悄悄错误的 catalog。
- catalog 的源码 glob 保持不收窄：语料中没有排除任何探针模式，vitest 配置既有的 `oxlint-contract-*.ts` 排除继续只覆盖测试文件发现。

## 考虑过的替代方案

**把 catalog spec 与 oxlint 契约 spec 串行化。** 家规是不因为某个 fixture 缺少隔离就串行化整个套件，而且顺序块本来也无法把宿主文件系统保护起来免于其他进程或 job。串行化要为只存在于恰好两个 spec 之间的窗口给每一次 full run 缴税；探针的写入者已经拥有唯一、自删除的资源，所以消费侧的容忍是更窄的修复。

**对 ENOENT 重试读取。** 文件在通常情形下是真的消失了，重试只是延迟同样的失败，并把确定性的跳过变成时序赌注；在这里重试循环是 flake 遮罩，不是修复。

**把 `oxlint-contract-*.ts` 从 catalog 的源码 glob 中排除。** 那会收窄扫描用作其穷尽性兜底的语料：一个未来确实携带 slot 头的探针样文件会从 catalog 中悄悄消失，而该扫描是有意读取整个工作区的。

**提高 catalog spec 的超时。** 不存在可等待的状态；更大的预算只是延迟同样的 ENOENT。

## 后果

catalog spec 不再在它不拥有的竞态上失败：oxlint worker 在 catalog 扫描并行期间创建和删除探针时，完整的 `test:coverage` 运行仍让两个 spec 都通过。语料文件在扫描中途消失的另一种途径是同 checkout 上的并发删除，那种情形解析为响亮失败的契约校验，或一次运行中暂时过期的 catalog——而绝不会是悄悄错误的 catalog。其余任何读取错误仍使扫描失败，oxlint 契约 spec 保持不变。

## 测试

新增的 [slot-walk.spec.ts](../../../../scripts/slot-walk.spec.ts) 在一个每测试的临时根里的 fixture 包上固定该行为，mock 的 `readFileSync` 从一张表应答：对某个列出文件报 ENOENT 时跳过它，扫描其余部分带着已解析的所属包存活；其余任何错误以抛出的那个确切错误使扫描失败；普通扫描保留每个存在的文件。一次完整的 `pnpm run test:coverage` 运行中，两个 spec 都通过，oxlint 契约 spec 的探针生命周期与 catalog 扫描并行。
