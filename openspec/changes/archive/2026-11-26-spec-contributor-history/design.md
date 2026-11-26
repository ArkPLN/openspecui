# Design

## Context

当前工作台在总览接口中通过 `parseRepoMainSpecs` 一次性返回所有主规范正文，而 `git-service.ts` 仅提供仓库级状态、近期时间线与单次 Commit Diff。主规范（`openspec/specs/<capability>/spec.md`）自身不包含作者元数据，且远程仓库通过 `RemoteRepoManager` 使用 `--filter=blob:none` 克隆；因此作者追溯与功能点演进分析必须在服务端按单文件懒加载执行，并在 `extractRequirementsMap` 的基础上引入语义级块对比（动机与影响范围见 [proposal.md](./proposal.md)）。

## Goals / Non-Goals

**Goals:**
- 为单个主规范精确识别创建者（首个提交）及全部去重贡献者（按小写 `email` 归一化，保留最近一次提交的 `author` 显示名）。
- 通过对比相邻提交的 `### Requirement:` 块集合（而非纯文本 `+`/`-` 行数）识别追加、修改、重命名与移除功能点，并返回可读的 `Requirement` 标题清单。
- 支持工作区本地仓、远程缓存仓与声明了外部注册 Store 的仓库（解析实际承载 `openspec/` 的物理目录并定位其 Git 根）。
- 在前端「Specs 规范库」选中主规范时按需懒加载，并在非 Git 目录或超长历史时保持优雅降级与可控响应时间。

**Non-Goals:**
- 不在总览接口（`/api/workspaces/:id/overview`）中预计算所有主规范历史，避免触发远程仓库批量 blob 拉取。
- 不修改现有 `openspec/specs/**/*.md` 文件格式（不强制写入 YAML Frontmatter）。
- 不做行级 `git blame` 内联标注到正文每一行（聚焦提交粒度的功能点演进清单）。

## Decisions

### 1. 懒加载单文件接口设计与路径安全边界
- **选择**：新增 `GET /api/repos/:repoId/specs/history?capabilityPath=<cap>&limit=<n>`。服务端先由 `registry` 验证 `repoId` 存在，再通过 `resolveRepoSpecRoot` 解析实际 `openSpecDir` 并拼接 `specs/<capabilityPath>/spec.md`，经 `resolveSafePathInsideRepo`（针对 `openSpecDir`）校验无路径穿越后，向上定位实际 `.git` 根目录并计算相对路径。
- **原因**：`openspec` 目录可能直接位于绑定仓库内，也可能来自外部 `--store`；统一以 `openSpecDir` 为锚点找 `.git` 根，能同时兼容本地仓、远程仓与独立 Store 仓。
- **替代方案**：在 `/overview` 顺带计算所有 spec 的历史——在远程 `--filter=blob:none` 仓有数十个 spec 时会触发大量按需网络对象拉取，直接拖垮首屏。

### 2. 元数据全量 + 快照滑窗策略
- **选择**：
  1. 先执行轻量 `git log --follow --reverse --format=... -- <specRelPath>`（不带 `-p` 与文件正文），拿到完整提交列表 `[C1, ..., Cn]`，从而保证即使历史很长也能拿到真正的**创建者 `C1`** 与**全部去重贡献者**。
  2. 对最近 `snapshotLimit` 次提交（默认 `20`，最大 `40`；若总提交数超过窗口，从最早提交之外的窗口起点 `C(k-1)` 多取一版作为基线，同时仍尽可能取 `C1` 用于确认创建基准）使用 `git show <sha>:<pathAtCommit>` 读取文本快照。
- **注意 `--follow` 路径变化**：`git log --follow --name-status` 会记录历史重命名时的旧路径，`git show` 必须使用该提交当下对应的文件路径（`--name-only` / `--raw` 提取），否则文件曾经移动过目录时 `git show <oldSha>:<currentPath>` 会找不到对象。

### 3. Requirement 语义 Diff 与重命名相似度算法
- **选择**：
  1. 利用 `extractRequirementsMap` 提取每个版本规范的 `Map<normalizedName, rawBlock>`（同时保留原始大小写标题用于前端清单展示）。
  2. **确定性优先**：检查同一次提交中是否同步改动了 `openspec/changes/archive/*/specs/<capabilityPath>/spec.md`（或任何路径以 `/specs/<capabilityPath>/spec.md` 结尾的归档 Delta 文件）；若其中存在 `## RENAMED Requirements` 的 `FROM:`/`TO:` 映射，则以 100% 置信度优先匹配为 `RENAMED`。
  3. **相似度兜底**：对剩余仅在旧版出现的 `Removed` 集合与仅在新版出现的 `Added` 集合，先剥离首行标题与 OpenSpec 模板固定用语（`### Requirement:`、`The system SHALL`、`SHALL`、`WHEN`、`THEN`、`AND`、Markdown 强调符号），再将剩余文本切分为「英文/数字词 + CJK 字符 2-gram」集合，计算 Dice 相似度系数。按降序执行一对一贪心匹配，阈值设为 `>= 0.55` 判定为 `RENAMED`（记录 `similarity` 百分比）。
  4. 其余未匹配项分别归为 `ADDED`（追加）、`REMOVED`（移除）；同名且正文规范化后不同的归为 `MODIFIED`；所有 Requirement 集合与正文均一致但整文件发生提交的归为 `DOCS_UPDATED`。
- **替代方案**：直接使用 `git diff` 统计 `+`/`-` 行数——修改描述或重排格式都会产生 `-` 行，无法判断“是否移除以前的功能点”。

### 4. 贡献者去重与计数归因
- **选择**：以 `email.trim().toLowerCase()` 作为去重主键（若 `email` 为空则回退小写 `name`），显示名称取该主键最近一次提交的 `authorName`；统计每位贡献者在已解析快照窗口内的 `createdCount`、`addedCount`、`modifiedCount`、`renamedCount`、`removedCount` 与 `commitCount`（未进入快照窗口的更早提交仅计入 `commitCount` 并标注部分历史未展开）。

## Risks / Trade-offs

- **[Risk] 远程仓库 `--filter=blob:none` 离线或网络较慢时，连续 `git show` 耗时较高** → 限制单次快照读取窗口默认 20 条，单次 `git show` 复用 `runGitReadOnly` 设合理超时（如 10s），并在单仓内串行/小并发控制（并发度 3）防止把 Git 进程打满；超限返回 `truncated: true`。
- **[Risk] 同一条 Requirement 改标题同时大幅重写内容，相似度低于 0.55** → 若同次提交没有归档 Delta 的 `FROM:/TO:` 声明，会退化为“1 条移除 + 1 条追加”，属于保守可接受策略（宁可提醒审阅“可能移除了功能点”，不盲目把不同需求强行合并）。
- **[Risk] 多人协作采用 Squash Merge 或统一由一人执行 `openspec archive` 提交** → Git 历史仅能反映实际 commit author；界面在提示文案中客观标明“基于 Git 提交历史追溯”，不虚构未在 Git 中留痕的作者。
