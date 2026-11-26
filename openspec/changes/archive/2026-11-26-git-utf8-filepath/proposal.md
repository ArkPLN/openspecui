# Proposal

## Why

Git 默认开启 `core.quotePath=true`，会将中文等非 ASCII 文件路径编码为 C 风格八进制转义串（例如 `\347\220\206...`）并用双引号包裹（`"a/... "b/..."`），导致当前工作台在 Commit/工作区 Diff 视图、脏文件列表及文件历史中把路径直接显示为转义乱码且无法匹配干净的 `b/...` 目标文件名。

## What Changes

- 在服务端所有只读 Git 调用入口统一禁用 `core.quotePath`（传入 `-c core.quotePath=false`），确保 `git status`、`git diff`、`git show`、`git log --follow`、`git diff-tree` 直接输出原始 UTF-8 文件路径。
- 在 `git-service.ts` 新增通用的 Git 路径解引号与 C 风格八进制转义还原工具函数（支持八进制 UTF-8 字节序列、转义引号/反斜杠及双引号包裹的含空格路径）。
- 升级 `parseUnifiedDiffOutput`、`getRepoGitStatus` 与 `getSpecEvolutionHistory` 的路径解析逻辑：兼容带双引号的 `"a/..." "b/..."`（含单边带引号重命名）Diff 头部提取，并对历史残余转义路径或文件头做兜底解码，使前端展示还原后的原始文件名。

## Capabilities

### New Capabilities

### Modified Capabilities
- `git-integration`: 新增对 Git 状态、代码 Diff 与文件路径历史中非 ASCII（中文）及含空格/引号文件路径进行 UTF-8 还原与规范化展示的要求。

## Impact

- `openspecui`（`packages/server`）：
  - `src/git-service.ts`：`runGitReadOnly`、`getRepoGitStatus`、`parseUnifiedDiffOutput`、`getSpecEvolutionHistory` 及 `readCommitMatchingDeltaSpecs` 接入 `core.quotePath=false` 与 `decodeGitQuotedPath` / Diff 头部引号拆解。
  - `test/git-and-watcher.test.ts`：补充中文路径与含空格路径的 `getRepoDiff`、`getRepoGitStatus` 及 `parseUnifiedDiffOutput` 单元测试与真实 Git 集成测试。
- `@openspecui/web`：无需变更接口协议，[DiffViewer.tsx](file:///d:/code/not_itc/openspecui/packages/web/src/components/DiffViewer.tsx) 与 `GitActivityView.tsx` 自动获得还原后的原始 UTF-8 `file.path` 与可阅读的 Diff 头部。
