# Proposal

## Why

目前使用 OpenSpec 进行规范驱动开发时，缺少直观的可视化预览界面，且难以将多仓库（如前后端各自维护 `openspec/` 的分离项目）与 Git 分支/提交/代码改动联动起来查看。我们需要一个本地单实例的 `openspecui` 工作台，让开发者和 AI 协作时能在一个界面里统一管理多项目、对比 Delta Spec 差异、勾选任务进度并追踪关联的代码 Diff。

## What Changes

- 新增基于 Node.js + TypeScript 的本地单实例服务与 CLI 入口（支持 `npx openspecui` 启动），提供 React + Vite 构建的 Web 预览界面。
- 新增逻辑工作区（Workspace）与多仓库注册机制，支持单仓项目、前后端分仓各自维护 `openspec/` 的联合视图，以及对 OpenSpec 原生 `store` / `workset` 的读取兼容。
- 新增线上 Git 地址接入能力：支持通过 HTTPS/SSH Git URL 将远程仓库或远程 Store 克隆至本地受控缓存目录，作为只读仓库参与工作区视图并支持手动或定时 `fetch` 同步。
- 新增 OpenSpec 可视化与轻交互能力：兼容阶段式 Kanban 看板（`Planning` / `Ready to apply` / `In progress` / `Complete` / `Archived`）、`By repo` 泳道与跨仓聚合视图、Artifact 依赖状态提示、工作区 `Ideas` 灵感栏、搜索排序、亮暗主题切换、Main Spec 与 Delta Spec 合并对比视图、`tasks.md` 复选框点击回写（远程缓存仓与局域网模式禁用写回），以及跨仓 Change 同名聚合与手动关联映射。
- 新增多源配置与局域网查看兼容：兼容读取 `openspec-ui.json` 与父目录多项目 CLI 参数，支持显式 `--host 0.0.0.0` 启动局域网手机只读查看模式（自动禁用全部写操作与本机目录控制）。
- 新增只读浏览与受控分支切换的 Git 集成能力：多仓独立分支与脏状态展示、安全切换分支（禁止强切覆盖未提交修改）、跨仓统一 Commit/工作区活动时间线、基于分支/提交匹配 Change 的代码 Diff 查看器。
- 新增按需文件监听（Lazy File Watcher）机制，仅实时监听当前激活的工作区目录并通过 WebSocket 推送增量刷新，避免多项目下的句柄与性能损耗。

## Capabilities

### New Capabilities

- `workspace-registry`: 管理本地多项目、逻辑工作区（Workspace）与多仓库绑定（支持本地目录、线上 Git URL 受控缓存、前后端独立 `openspec/` 与原生 `store`/`workset`），以及跨仓 Change 手动关联映射的持久化。
- `openspec-preview`: 解析并聚合工作区内各仓库的 Specs、Active Changes 与 Archive，提供 Delta Spec 与 Main Spec 对比渲染、`tasks.md` 进度统计与本地仓库复选框回写交互（远程缓存仓保持只读）。
- `git-integration`: 为工作区内的每个物理仓库提供 Git 状态查询（分支、脏文件）、受控分支切换、远程仓库同步（`fetch`）、跨仓混合提交时间线、Change 与分支/提交的关联匹配，以及工作区与 Commit 级代码 Diff 展示。
- `local-workbench-server`: 提供 `openspecui` CLI 启动入口、本地 HTTP/WebSocket API 服务、当前激活工作区的按需文件监听、Git URL 协议白名单校验与本地安全边界校验。

### Modified Capabilities

<!-- 空白：当前项目尚无已有能力规范 -->

## Impact

- 全新初始化工程结构（Node.js + TypeScript 服务端、React + Vite Web 前端、共享类型定义）。
- 运行时依赖本地已安装的 `git`（含本机已配置的 SSH Key / Git Credential）与 `openspec` CLI（通过受控子进程按目标仓库 `cwd` 执行），并在用户本地配置目录保存工作区注册表（`~/.openspecui/workspaces.json`）及受控远程仓库缓存（`~/.openspecui/repos/`）。
- 仅对用户显式触发的本地工作区 `tasks.md` 复选框勾选执行精确行回写，以及在用户显式点击切换分支时执行非破坏性分支切换（禁止强切丢弃本地修改）；远程缓存仓库禁用文件写入，且不对任何仓库执行自动 `git commit`、`git push` 或破坏性 Git 操作。
