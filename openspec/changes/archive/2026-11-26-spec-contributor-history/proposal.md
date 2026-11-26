# Proposal

## Why

当前 OpenSpec 主规范（`openspec/specs/<capability>/spec.md`）与 `openspecui` 的「Specs 规范库」仅展示当前规范全文与 Requirement 总数，无法回答“某个 Spec 是谁创建的、中间有哪些人修改过、每次修改是追加了新功能点还是移除了已有功能点”。引入按需追溯的 Spec 贡献者与 Requirement 级演进分析后，团队可以直接在工作台内追踪规范责任人并第一时间识别功能删减或重命名风险。

## What Changes

- 新增单 Spec 维度的只读 Git 演进历史查询能力（基于 `git log --follow` 与受控 `git show`），定位主规范文件的创建者与全部去重贡献者（按小写邮箱合并），并在无 `.git` 目录或外部只读 Store 无 Git 时优雅降级。
- 新增基于 OpenSpec `### Requirement:` 块级结构的相邻版本语义对比算法：区分 `CREATED`（首次创建）、`ADDED`（追加功能点）、`MODIFIED`（修改功能点）、`REMOVED`（移除已有功能点）、`RENAMED`（重命名）与 `DOCS_UPDATED`（仅修订背景/Purpose 等非 Requirement 内容）。
- 新增重命名自动识别策略：优先读取同提交内归档 Delta Spec 的 `FROM:`/`TO:` 声明，兜底在剔除 OpenSpec 固定模板词后对 `Removed × Added` 候选执行中英文分词相似度一对一匹配，避免标题微调被误判为“移除旧功能点 + 追加新功能点”。
- 在「Specs 规范库」右侧详情面板按需懒加载当前选中 Spec 的贡献者汇总栏（标注创建者、各贡献者增/改/删计数）与逆序演进时间线，每条提交直接列出被追加、修改、重命名与移除的具体 Requirement 标题清单，并对移除操作做高亮警示。

## Capabilities

### New Capabilities

### Modified Capabilities
- `git-integration`: 新增基于单个 Spec 相对路径（含外部 Store 场景）的只读提交历史追踪、跨重命名追踪（`--follow`）及按 `Requirement` 语义块对比分析功能点增删的能力。
- `openspec-preview`: 新增在「Specs 规范库」右侧主规范详情面板中懒加载展示 Spec 创建者、去重贡献者统计与按提交列出的 Requirement 追加/修改/重命名/移除清单的能力。

## Impact

- `@openspecui/shared`：`types.ts`、`schemas.ts` 新增 Spec 历史查询入参校验与贡献者/演进条目的共享类型定义。
- `openspecui`（`packages/server`）：
  - `openspec-parser.ts`：扩展主规范定位（暴露底层 `spec.md` 相对路径与实际 Git 根目录归属）及 `Requirement` 语义差异与文本相似度重命名匹配纯函数。
  - `git-service.ts`：新增按文件 `--follow` 获取提交元数据列表与受控单提交快照读取函数（限制快照回溯窗口以保护远程 `--filter=blob:none` 仓库性能）。
  - `server.ts`：新增只读接口 `GET /api/repos/:repoId/specs/history`（带路径安全校验与本地/Store 根解析）。
- `@openspecui/web`：`api.ts` 与 `ChangeBoard.tsx`（及配套子组件）在「Specs 规范库」视图接入按需查询、加载态/降级提示、贡献者摘要与 Requirement 增删清单展示。
