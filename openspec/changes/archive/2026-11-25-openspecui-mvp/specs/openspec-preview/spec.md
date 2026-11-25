# Spec Delta

## Purpose

解析并可视化展示工作区内各仓库的 OpenSpec 主规范（Specs）、进行中的变更（Active Changes）与历史归档（Archive），提供跨仓需求聚合、Delta Spec 差异预览以及任务复选框的轻量回写能力。

## ADDED Requirements

### Requirement: 跨仓 Change 聚合看板
The system SHALL aggregate active and archived changes across all repositories bound to the active workspace, grouping changes that share the same change name or belong to a manual cross-repo link, and SHALL compute per-repository and combined task completion progress.

#### Scenario: 自动聚合同名 Change 与混合归档状态
- **WHEN** 前端仓库的 `add-sso` 处于进行中而后端仓库的 `add-sso` 已移入 `archive/`
- **THEN** 工作区看板将两者聚合为同一逻辑条目，并分别标记前端进行中进度与后端已归档状态，不隐藏任何一方

#### Scenario: 独立展示单边 Change
- **WHEN** 仅后端仓库存在 `order-export` 而前端仓库不存在同名或手动映射的 Change
- **THEN** 看板仍展示该 Change，并清晰标明仅涉及后端仓库

### Requirement: 规范文档与 Delta Spec 合并对比预览
The system SHALL render `proposal.md`、`design.md`、`tasks.md` and spec files as formatted Markdown by default (with an option to view raw Markdown source), and SHALL provide a switchable view on change `Specs` between clean Markdown preview (default) and Delta vs Main Spec comparison against `openspec/specs/` when present.

#### Scenario: Proposal、Design 与 Specs 默认 Markdown 渲染
- **WHEN** 用户打开 Change 的 `Proposal`、`Design` 或主规范 `Specs` 视图
- **THEN** 系统默认以格式化 Markdown（标题、列表、代码块、表格、加粗等）安全渲染文档内容，并支持切换查看 Markdown 原文

#### Scenario: Change Specs 默认洁净预览并支持切换 Delta 对比
- **WHEN** 用户查看某 Change 下的 `Specs` 标签页
- **THEN** 系统默认以格式化 Markdown 展示规范内容（不强制展开 Diff），同时提供切换开关让用户按需切换到 `ADDED`/`MODIFIED`/`REMOVED`/`RENAMED` 与主规范的高亮对比视图

#### Scenario: 主规范尚未存在时的 Delta 预览
- **WHEN** 用户切换至 Delta 对比模式且主 `openspec/specs/<capability>/spec.md` 尚不存在
- **THEN** 系统清晰标识其为全新能力规范并完整渲染新增内容

#### Scenario: 跨仓同名能力并排对照
- **WHEN** 工作区内多个仓库存在相同能力路径或被关联为同一逻辑 Change
- **THEN** 界面支持并排或分栏切换查看各仓库的规范与任务清单

#### Scenario: Markdown 内部产物超链接自动跳转对应 Tab
- **WHEN** 用户在 `Proposal`、`Design`、`Specs` 或 `Tasks` 的 Markdown 预览中点击指向 `proposal.md`、`specs/**`、`design.md` 或 `tasks.md`（含 `./`、`../<change>/` 前缀及可选 `#anchor`）的相对超链接
- **THEN** 系统拦截浏览器外跳，在当前 `Change` 详情工作台内自动切换至对应的 `Proposal`、`Specs`、`Design` 或 `Tasks` 标签页（并在存在锚点或具体能力路径时滚动定位），而 `http://`/`https://` 外部链接仍在新标签页打开

### Requirement: Tasks 复选框安全回写
The system SHALL allow users to toggle task completion checkboxes in `tasks.md` from the preview interface and SHALL perform a targeted line-level update to the underlying markdown file while preserving unrelated formatting and comments.

#### Scenario: 点击复选框更新任务状态
- **WHEN** 用户在界面上勾选一条未完成的任务 `- [ ] 实现登录接口`
- **THEN** 系统仅将该行更新为 `- [x] 实现登录接口`，保留文件其余内容不变，并立即刷新聚合进度条

#### Scenario: 文件并发变更冲突保护
- **WHEN** 用户尝试勾选的任务行自上次加载后已被外部编辑器或 AI 修改或删除
- **THEN** 系统拒绝盲目覆盖文件，返回冲突提示并自动重新加载最新文件内容

#### Scenario: 拒绝修改远程缓存仓库的任务状态
- **WHEN** 所查看的 Change 来自通过线上 Git URL 导入的只读缓存仓库
- **THEN** 预览界面禁用复选框点击交互并标识“远程仓库为只读缓存”，且服务端拒绝针对该缓存仓库的任何 `tasks.md` 写入请求

#### Scenario: Tasks 按 Markdown 文档原貌展示并支持行级勾选回写
- **WHEN** 用户切换到 Change 详情弹窗的 `Tasks` 标签页
- **THEN** 系统依据 `tasks.md` 完整 Markdown 结构安全渲染标题、分组、说明文本、行内代码、嵌套列表与文档内超链接（支持切换源码），并将任务列表项的 `- [ ]`/`- [x]` 复选框（按绿色勾选样式展示已完成状态）绑定至对应行号实现直接点击回写，同时保留远程仓库/已归档/局域网只读禁用保护

### Requirement: 生命周期阶段 Kanban、Artifact 依赖状态与筛选排序
The system SHALL classify each change into lifecycle stages (`Planning`, `Ready to apply`, `In progress`, `Complete`, and `Archived`) with per-artifact dependency states (`done`, `next`, `blocked`), and SHALL provide repo overview filter cards, `Stages` / `By repo` / `Cross-Repo` layout modes, search/sort controls, and light/dark theme switching.

#### Scenario: 展示 Planning 阶段 Artifact 依赖状态
- **WHEN** 某 Change 尚未完成全部规划产物（例如已完成 `proposal` 和 `specs`，尚缺 `design` 和 `tasks`）
- **THEN** 系统将其归入 `Planning` 列，并分别标记 `Proposal` 与 `Specs` 为已完成、`Design` 为下一步（`next`）、`Tasks` 为被阻塞（`blocked`）及依赖说明

#### Scenario: 仓库概览过滤与布局切换
- **WHEN** 用户点击顶部仓库筛选卡片或在 `Stages`（阶段列）、`By repo`（按仓库泳道）、`Cross-Repo`（跨仓项目关联组与跨仓 Change 聚合组）之间切换，或输入关键词搜索与排序
- **THEN** 看板即时按选定仓库、布局模式、搜索词和排序规则刷新展示，同时保留对归档列显隐切换的支持；其中点击「关联跨仓项目」可选择 2 个及以上项目仓库组成跨仓项目组并在 `Cross-Repo` 中统一聚合展示与解除关联

#### Scenario: 全屏自适应工作台布局
- **WHEN** 用户在桌面宽屏或不同分辨率下打开 Web 工作台及 Change 详情弹窗
- **THEN** 主工作台占满浏览器整个视口宽度自适应展开，且 Change 详情弹窗支持一键切换全屏查看长篇规范与 Diff

#### Scenario: 亮色与深色主题完整覆盖无暗色残留
- **WHEN** 用户点击顶部主题按钮切换至浅色（白色）主题
- **THEN** 页面背景、看板列、卡片、弹窗、Markdown 与 Diff 差异区、悬停态、滚动条及原生下拉控件均切换为协调的浅色高对比度样式，不残留暗色色块或低对比度文字

#### Scenario: 弹窗支持 Esc 键关闭
- **WHEN** 用户打开任意工作台弹窗并按下键盘 `Esc` 键
- **THEN** 系统关闭当前最顶层弹窗（若存在嵌套子弹窗，仅关闭最上层子弹窗而不连带关闭父弹窗）

#### Scenario: 看板卡片与仓库支持自定义拖拽排序
- **WHEN** 用户将排序方式切换为 `Custom` 或在同阶段列内拖拽 Change 卡片、在 `Ideas` 列内拖拽 Idea 卡片、或在顶部仓库条拖拽仓库卡片
- **THEN** 界面实时重排同列内展示顺序并持久化至本地配置（禁止跨生命周期阶段拖拽伪造完成状态，且局域网只读模式下禁用拖拽写入）

#### Scenario: 归档列表入口与归档时间展示
- **WHEN** 仓库 `openspec/changes/archive/` 下存在已归档变更
- **THEN** 系统解析目录日期前缀（`archivedDate`）及归档目录文件系统时间戳（`archivedAt`），在顶部与 `Board 看板`、`Specs 规范库` 并列提供 `Archive 归档库 (N)` 页签（看板右上角 `Archived (N)` 按钮同步显示数量），并在 `Archive 归档库`、看板 `Archived` 列及 `Cross-Repo` 归档组默认按「`archivedDate` 降序 → 同日 `archivedAt` 降序 → 名称降序」展示最新归档项，同时在卡片与 `Change` 详情弹窗头部清晰展示归档时间
