# git-integration Specification

## Purpose

为工作区内的每个物理代码仓库与独立规范仓库提供只读 Git 上下文集成，展示分支与工作区脏状态、跨仓统一提交时间线、Change 与分支/提交的关联匹配以及代码 Diff 预览，确保开发规范与真实代码改动可追溯对齐。

## Requirements

### Requirement: 多仓库独立 Git 状态展示
The system SHALL inspect each repository's Git state independently, reporting current branch name, upstream ahead/behind counts, and dirty working tree file counts without requiring repositories in a workspace to be on the same branch.

#### Scenario: 前后端处于不同分支时的状态展示
- **WHEN** 工作区中前端仓位于 `main` 分支（无脏文件）且后端仓位于 `feat/add-sso` 分支（有 3 个未提交改动）
- **THEN** 系统在工作区头部与仓卡片中分别准确显示各自独立的分支名与脏文件数量

#### Scenario: 目标目录未初始化 Git 仓库
- **WHEN** 工作区中某个绑定目录尚未执行 `git init`
- **THEN** 系统正常展示该目录的 OpenSpec 内容，并在 Git 面板标明“非 Git 仓库”而不报错崩溃

### Requirement: 跨仓混合 Git 活动时间线
The system SHALL fetch recent commit history and uncommitted working-tree changes from all bound repositories in the active workspace and SHALL merge them into a single reverse-chronological activity timeline tagged with repository role and branch.

#### Scenario: 混合展示前后端提交记录
- **WHEN** 用户打开工作区 Git 活动流
- **THEN** 系统按提交时间倒序混排前端仓、后端仓及关联 Store 仓的最近提交，每条记录标注所属仓库标识、分支、作者、时间与变更文件数

### Requirement: Change 关联分支/Commit 匹配与代码 Diff 查看
The system SHALL correlate a selected OpenSpec change ONLY with repositories that own the change or match explicit correlation rules (manual pin, branch name, or commit message) by default—hiding unrelated workspace repositories unless explicitly expanded—and SHALL provide a read-only code diff viewer for both uncommitted changes and individual commits.

#### Scenario: 按 Change 名称自动匹配关联分支与提交并过滤无关仓
- **WHEN** 用户查看 Change `add-sso`，工作区中除了所属仓（及其所在的跨仓项目关联组 `repoLinks` 成员仓）之外还绑定了其他无关项目仓库
- **THEN** Git 关联面板默认展示该 Change 所属的仓库、所属跨仓项目关联组内共同协作的项目仓库，以及命中 `manual-pin`、分支名或提交消息匹配的关联仓库，隐藏其余未关联的无关仓库（仅提供可选“展开工作区其他仓库”入口以便手动 Pin）

#### Scenario: 手动指定 Change 关联分支
- **WHEN** 某仓库的实际开发分支命名未包含 Change 名称
- **THEN** 用户可在界面上手动选择该仓库的特定分支或提交绑定到当前 Change，以查看其关联代码 Diff

#### Scenario: 查看 Commit 与工作区代码 Diff
- **WHEN** 用户点击关联面板中的任意未提交文件或历史 Commit
- **THEN** 系统只读展示对应文件列表与统一格式（Unified / Split）代码 Diff，不执行任何暂存、提交、切换分支或合并等写入操作

### Requirement: 仓库分支安全切换
The system SHALL allow users in local workbench mode to switch a bound repository's checked-out branch via explicit selection in the Git activity panel using safe non-destructive git switching (without force-discarding uncommitted changes), and SHALL forbid branch switching when running in read-only LAN mode (`--host 0.0.0.0`).

#### Scenario: 安全切换本地已有分支并联动刷新工作台
- **WHEN** 用户在「多仓 Git 状态与活动流」的某个仓库卡片中选择目标本地分支（如 `feat/add-sso`）并确认切换，且当前工作区无冲突未提交修改
- **THEN** 服务端通过受控 `git` 命令切换该仓库工作树至目标分支并返回最新 Git 状态，前端同步刷新顶栏分支徽章、OpenSpec 规范视图与活动时间线

#### Scenario: 切换到远端跟踪分支时自动创建本地跟踪分支
- **WHEN** 用户选择列表中尚未在本地检出的远端分支（如 `origin/release-v2`）进行切换
- **THEN** 服务端自动以跟踪模式创建并切换到对应的本地分支（或本地已有同名跟踪分支时直接切换），避免工作区陷入 `detached HEAD` 状态

#### Scenario: 存在冲突改动或只读模式时安全拒绝切换
- **WHEN** 当前仓库工作区存在会与目标分支冲突的未提交改动，或服务运行在 `--host 0.0.0.0` 局域网只读模式下
- **THEN** 系统拒绝或中止切换（绝不使用 `--force` 丢弃改动），保留原工作区与未提交修改不变，并返回可读的提示信息

### Requirement: 远程缓存仓库同步与只读分支查看
The system SHALL support manual and configurable periodic synchronization (`git fetch`) for remote cached repositories in non-interactive mode using local Git credentials, and SHALL expose remote-tracking branches (such as `origin/*`) for read-only commit timeline and diff inspection.

#### Scenario: 手动或定时同步远程仓库最新提交
- **WHEN** 用户对远程只读仓库点击“立即同步”或达到配置的自动同步间隔
- **THEN** 系统在非交互模式下执行远程拉取更新远程跟踪分支状态，刷新界面上的最新分支、规范与提交时间线，并更新最近同步时间戳

#### Scenario: 私有远程仓库鉴权失败或网络超时
- **WHEN** 拉取私有远程仓库时本机未配置有效 SSH Key 或 Git 凭证导致鉴权失败或超时
- **THEN** 系统在超时阈值内终止操作并返回明确的鉴权/网络错误提示，不挂起后台服务且保留上次可用的缓存视图

### Requirement: 非 ASCII 与含引号 Git 文件路径 UTF-8 还原
The system SHALL disable Git octal path quoting (`core.quotePath=false`) during repository inspection and SHALL decode C-style quoted/octal-escaped file paths across Git status, Diff output, and file-level commit history so that non-ASCII (such as Chinese) and space-containing paths display as their original UTF-8 relative paths.

#### Scenario: 查看含中文目录与中文文件名的 Commit 或工作区 Diff
- **WHEN** 某次提交或工作区改动包含非 ASCII 路径（例如 `sql/2026/20260922理论课堂/20261125线下收款登记权限补齐.sql`）
- **THEN** 系统返回解码后的原始 UTF-8 相对路径 `sql/2026/20260922理论课堂/20261125线下收款登记权限补齐.sql` 作为文件条目标题，且 Diff 头部不显示八进制转义乱码或多余的双引号 `a/`、`b/` 前缀

#### Scenario: 兼容含空格、特殊字符及旧式八进制转义的 Diff 与状态行
- **WHEN** Git 状态输出、带引号的重命名 Diff 头（如 `"a/old name.md" "b/新 文件.md"`）或单边引号 Diff 头中出现双引号或 C 风格八进制字节序列（`\NNN`）
- **THEN** 系统正确拆解左右路径、还原 UTF-8 字符并去除 `a/`、`b/` 前缀与外层引号，同时保持路径遍历安全校验对还原后路径的有效性

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
