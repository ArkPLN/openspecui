# Tasks

## 1. Shared Types & Validation Schemas

- [x] 1.1 在 `packages/shared/src/types.ts` 新增 Spec 演进分析共享类型（`SpecRequirementChangeItem`、`SpecRevisionEntry`、`SpecContributorSummary`、`SpecHistoryResponse`）并在 `packages/shared/src/schemas.ts` 新增查询参数校验 Schema（`capabilityPath` 与 `limit` 范围校验），运行 `npm run typecheck --workspace=@openspecui/shared` 与 `npm run build --workspace=@openspecui/shared` 验证通过。

## 2. Semantic Requirement Diff & Similarity Engine

- [x] 2.1 在 `packages/server/src/openspec-parser.ts` 实现 `compareSpecRequirementSnapshots` 纯函数：解析相邻两版 `spec.md` 的 `### Requirement:` 块（保留原始标题）、结合同提交可选归档 Delta Spec 的 `RENAMED` 映射，并对剩余 `Removed × Added` 候选剥离 OpenSpec 模板词后以中英文混合分词计算 Dice 相似度（默认阈值 `0.55`）执行一对一匹配，输出 `CREATED` / `ADDED` / `MODIFIED` / `RENAMED` / `REMOVED` / `DOCS_UPDATED` 结果与标题清单。
- [x] 2.2 在 `packages/server/test/registry-and-openspec.test.ts` 补充单元测试覆盖首次创建、纯追加、纯移除、修改描述不误判移除、同提交 Delta `RENAMED` 匹配、相似度自动识别重命名与非模板词高阈值保护，运行 `npm run test --workspace=openspecui` 验证全量通过。

## 3. Git Spec History Service & API Endpoint

- [x] 3.1 在 `packages/server/src/git-service.ts` 新增 `getSpecEvolutionHistory` 函数：支持通过 `resolveRepoSpecRoot` 定位真实 `openSpecDir`（兼容本地仓、远程缓存仓与外部注册 Store）并向上查找 `.git` 根目录；执行 `git log --follow --reverse` 获取全量提交元数据确定创建者与按小写邮箱去重的贡献者列表，受控拉取最近窗口内各提交对应历史路径的 `git show` 快照及同提交归档 Delta Spec，聚合每位贡献者的增/改/重命名/移除统计；对非 Git 仓库或无提交文件返回中性降级结构。
- [x] 3.2 在 `packages/server/src/server.ts` 注册只读路由 `GET /api/repos/:repoId/specs/history`（校验 `repoId` 归属、`capabilityPath` 防穿越与 `limit` 边界），并在 `packages/server/test/git-and-watcher.test.ts` 与 `packages/server/test/security-and-server.test.ts` 增加真实 Git 仓库多作者演进、文件移动 `--follow`、非 Git 降级及路径穿越拦截集成测试，运行 `npm run test --workspace=openspecui` 验证通过。

## 4. Web UI Integration in Specs 规范库

- [x] 4.1 在 `packages/web/src/api.ts` 新增 `getSpecHistory(repoId, capabilityPath, limit?)` 客户端方法与对应类型导出，确保请求携带统一超时与错误处理，运行 `npm run typecheck --workspace=@openspecui/web` 验证无类型错误。
- [x] 4.2 在 `packages/web/src/components/ChangeBoard.tsx`（及按需拆分的 `SpecHistoryPanel.tsx` 子组件）接入懒加载历史面板：选中左侧主规范时异步拉取该 Spec 的创建者、去重贡献者统计徽章、逆序演进时间线，以及每次提交下展开可见的 `+ 追加`、`~ 修改`、`> 重命名`、`- 移除` Requirement 标题清单（对移除以前功能点的条目做醒目警示，兼容亮/暗双主题与非 Git 降级提示）。
- [x] 4.3 运行全仓类型检查、服务端测试与完整构建（`npm run typecheck && npm run test && npm run build`），确认零报错且本地工作台端到端预览与 Spec 历史加载正常。
