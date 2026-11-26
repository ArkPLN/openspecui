# Design

## Context

`packages/server/src/git-service.ts` 通过 `runGitReadOnly` 执行 `git status`、`git diff`、`git show`、`git log --follow`、`git diff-tree` 等只读命令。Git 默认启用 `core.quotePath=true`，会将任何字节值大于 `0x7f`（如 UTF-8 中文）的路径转义为 `\347\220\206...` 并包裹双引号；同时即使关闭 `core.quotePath`，包含空格、制表符或双引号的路径仍会被 Git 用双引号包裹。现有 `parseUnifiedDiffOutput` 仅按无引号的 `^a\/(.+?)\s+b\/(.+)$` 匹配首行，导致带引号或八进制转义的文件路径直接暴露原始字符串（动机见 [proposal.md](./proposal.md)）。

## Goals / Non-Goals

**Goals:**
- 所有通过 `runGitReadOnly` 发起的 Git 查询默认携带 `-c core.quotePath=false`，从源头直接获取 UTF-8 原始路径。
- 提供可单测的 `decodeGitEscapedPath` 与 `parseDiffGitHeaderPaths` 公共解析函数，完整兼容双引号包裹、单边引号重命名与 C 风格八进制 UTF-8 字节序列还原。
- 同步修复 `parseUnifiedDiffOutput`、`getRepoGitStatus`、`getSpecEvolutionHistory` 及 `readCommitMatchingDeltaSpecs` 中的路径解析，确保状态文件列表、Diff 文件名与 Spec 演进历史路径一致还原。

**Non-Goals:**
- 不修改用户本地或全局 `~/.gitconfig` 配置，仅在单次 `git` 子进程调用参数中传入 `-c core.quotePath=false`。
- 不改变 Diff 正文内容本身的编码处理（仅处理文件路径与 Diff/Status 头部路径字段）。

## Decisions

### 1. 进程级禁用 `core.quotePath`
- **选择**：在 `runGitReadOnly` 中统一将参数前缀为 `['-c', 'core.quotePath=false', ...args]`。
- **原因**：`runGitReadOnly` 是 `git-service.ts` 所有 Git 命令的唯一出口；通过 `-c` 传参只作用于当前子进程，零副作用，不污染宿主机的 Git 配置。
- **替代方案**：仅在后处理里做正则替换——如果 `git status` 或 `git diff` 仍输出八进制转义，Diff 正文里的 `diff --git`、`---`、`+++`、`rename from`、`rename to` 行也会全是 `\347...`，直接影响可读性。

### 2. Git 引号与 C 风格八进制路径解码器
- **选择**：实现 `decodeGitEscapedPath(rawPath: string): string`：
  1. 若整串由双引号包裹（`"..."`），剥去首尾双引号；
  2. 遍历字符并写入字节数组：遇到 `\NNN`（3 位八进制数字）按单字节 `parseInt(octal, 8)` 写入，遇到 `\"` / `\\` / `\t` / `\n` / `\r` 还原对应控制字符，其余普通字符按 UTF-8 编码写入字节数组；最终通过 `Buffer.from(bytes).toString('utf8')` 解码为完整 UTF-8 字符串（确保多字节中文字符的连续 `\347\220\206` 不会在按字符拆分时损坏）。
- **原因**：一个中文 UTF-8 字符对应 3 个连续八进制字节（如 `理` = `\347\220\206`），必须在字节缓冲层拼接后再统一 `toString('utf8')`。

### 3. `diff --git` 首行双 Token 状态机解析
- **选择**：实现 `parseDiffGitHeaderPaths(firstLine: string): { oldPath: string; newPath: string } | null`，按顺序读取两个 Git 路径 Token：若以 `"` 开头则扫描至未转义的闭合 `"`，否则读取至空白分隔符；分别调用 `decodeGitEscapedPath` 后剥离前导 `a/` 与 `b/`。
- **原因**：正则 `^a\/(.+?)\s+b\/(.+)$` 无法处理 `"a/..." "b/..."`、含空格路径或仅单侧加引号的重命名头（如 `a/plain.txt "b/中文 空格.txt"`）。

## Risks / Trade-offs

- **[Risk] 对非 UTF-8（如老旧 GBK 编码）仓库路径，`Buffer.toString('utf8')` 会出现替换符** → 现代 Git 与 OpenSpecUI 全栈均以 UTF-8 为标准，且 `-c core.quotePath=false` 在 Windows Git 下直接输出 UTF-8，影响面可控。
- **[Risk] `git show <sha>:<path>` 使用解码后的含空格/中文路径时参数安全** → `readGitBlobText` 通过 `execFile`（无 shell 插值）直接传递 `${sha}:${relPath}` 参数，不会因空格拆分参数，且仍经过 `..` 与前导 `-` 校验。
