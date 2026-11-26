# Tasks

## 1. Git Path Decoding & Diff Header Parsing

- [x] 1.1 在 `packages/server/src/git-service.ts` 为 `runGitReadOnly` 默认注入 `-c core.quotePath=false`，并实现 `decodeGitEscapedPath`（还原外层双引号、C 风格 `\NNN` 多字节 UTF-8 八进制序列与转义符）及 `parseDiffGitHeaderPaths`（按双 Token 状态机兼容双引号包裹、单边引号重命名与空格路径），运行 `npm run typecheck --workspace=openspecui` 验证通过。
- [x] 1.2 在 `packages/server/src/git-service.ts` 将 `parseUnifiedDiffOutput`、`getRepoGitStatus`（含 `porcelain=v2` 跟踪/重命名/未跟踪路径）、`getSpecEvolutionHistory` 及 `readCommitMatchingDeltaSpecs` 接入 `decodeGitEscapedPath` 与 `parseDiffGitHeaderPaths`，确保所有文件列表、Diff 条目路径与 `diff --git`/`---`/`+++` 头部展示原始 UTF-8 路径，运行 `npm run typecheck --workspace=openspecui` 验证通过。

## 2. Tests & Full Build Verification

- [x] 2.1 在 `packages/server/test/git-and-watcher.test.ts` 补充单元测试与真实 Git 集成测试：覆盖带八进制转义的 `"a/sql/...\347\220\206..."` 原始 Diff 解析、含空格与引号的重命名路径解析，以及真实 Git 提交中文路径文件后的 `getRepoGitStatus` 与 `getRepoDiff` 输出验证，运行 `npm run test --workspace=openspecui` 全部通过。
- [x] 2.2 运行全仓类型检查、测试与完整构建（`npm run typecheck && npm run test && npm run build`），确认产物打包成功且无任何报错。
