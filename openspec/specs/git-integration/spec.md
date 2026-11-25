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
