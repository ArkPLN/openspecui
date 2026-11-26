## ADDED Requirements

### Requirement: Spec 文件历史追溯与 Requirement 语义演进分析
The system SHALL inspect the Git commit history of a requested main spec file (`openspec/specs/<capability-path>/spec.md`, following renames via `--follow` and resolving external registered store roots when applicable) on demand, identifying the spec creator, deduplicating all contributors by normalized author email, and classifying each inspected revision into structured `Requirement` deltas (`CREATED`, `ADDED`, `MODIFIED`, `RENAMED`, `REMOVED`, or `DOCS_UPDATED`).

#### Scenario: 追溯 Spec 创建者与全部贡献者并识别追加与移除
- **WHEN** 客户端请求一个位于有效 Git 仓库内的主规范历史，该规范经历过初始创建提交 `C1`、新增两条需求并修改一条需求的提交 `C2`，以及删除一条废弃需求的提交 `C3`
- **THEN** 系统返回 `C1` 的作者作为创建者，返回包含 `C1`、`C2`、`C3` 去重作者的贡献者汇总（按小写邮箱归一化并统计各自新增/修改/重命名/移除计数），并在逐次提交记录中分别列出 `C2` 追加与修改的 `Requirement` 标题清单以及 `C3` 被移除的 `Requirement` 标题清单

#### Scenario: 自动识别 Requirement 重命名而非误判为移除加追加
- **WHEN** 某次提交将已有 `Requirement` 标题重命名且正文语义高度相似（或同次提交内包含声明 `RENAMED` 的归档 Delta Spec `FROM:/TO:` 映射）
- **THEN** 系统将该条变更归类为 `RENAMED` 并记录原名称、新名称与匹配来源/相似度，不再将其误判为“移除旧功能点 + 追加新功能点”

#### Scenario: 非 Git 仓库或无历史记录时优雅降级
- **WHEN** 目标主规范所在的本地目录或外部 Store 目录未初始化 `.git`，或该规范文件尚未纳入任何 Git 提交
- **THEN** 系统返回明确的只读降级状态（标记非 Git 仓库或暂无提交历史）而不抛出未处理异常或阻塞主规范正文预览

#### Scenario: 路径校验与远程只读缓存保护
- **WHEN** 客户端传入非法 `capabilityPath`（如包含 `..` 或绝对路径）或查询通过 `--filter=blob:none` 克隆的远程仓库主规范历史
- **THEN** 系统严格校验目标路径不得越界出解析后的 OpenSpec 规范根目录，并对单次快照对比的提交窗口设置上限（同时标注历史是否被截断）以避免全量历史拉取导致超时
