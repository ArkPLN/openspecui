# Tasks

## 1. 工程骨架与共享契约搭建

- [x] 1.1 初始化 npm workspaces 单仓多包结构（`packages/shared`、`packages/server`、`packages/web`）、根 `package.json` 与 TypeScript 配置，并验证 `npm install` 与 `tsc --noEmit` 通过
- [x] 1.2 在 `packages/shared` 定义 Workspace、RepoBinding、CrossRepoChangeGroup、DeltaDiffResult、GitStatus、GitCommitItem 与 WebSocket 消息的共享 TypeScript 类型与校验 Schema，并验证服务端与前端均可正常导入类型编译

## 2. 本地工作台服务端与安全基础设施

- [x] 2.1 在 `packages/server` 搭建 Fastify HTTP + WebSocket 服务骨架，实现 `127.0.0.1` 绑定、`GET /api/health` 应用标识接口、Origin/Host 白名单与写操作防 CSRF Token 校验，并通过集成测试验证跨站与越界请求被拦截
- [x] 2.2 实现 `realpath` 路径规范化安全守卫、Git URL 协议白名单校验（放行 `https/http/ssh/git@`，封禁 `ext::`/`file://`）与受控子进程执行器（`execFile` + `shell: false` + `GIT_TERMINAL_PROMPT=0` 超时控制），并编写单元测试覆盖 `..` 路径穿越拦截、恶意 URL 拦截与非 `tasks.md` 写入拒绝逻辑
- [x] 2.3 实现 `openspecui` CLI 入口（检测已有单实例端口并复用切换上下文，或启动新实例、自动探测可用端口并注册当前工作目录），验证在空目录与 OpenSpec 目录执行 CLI 均可正常启动并响应健康检查
- [x] 2.4 修复非项目目录启动自动注册漏洞与首屏阻塞：仅在目录含 `openspec/` 或 `.git/`（且非用户主目录/盘符根）时自动注册，`GET /api/session` 秒回令牌不阻塞等待外部 CLI，`GET /api/env` 改为并行异步探测，并通过测试验证非项目目录不写入注册表且 `/api/session` 快速响应
- [x] 2.5 支持 `--host` 参数（默认 `127.0.0.1`）与局域网只读降级：当绑定非本机回环地址（如 `0.0.0.0`）时强制开启 `readOnlyMode`（拦截全部写请求与本机目录浏览/弹窗接口），返回 `lanUrls` 信息，且支持 CLI 传入多项目父目录或 `openspec-ui.json` 自动导入工作区，并编写集成测试验证局域网模式只读拦截

## 3. 工作区注册表与 OpenSpec 解析引擎

- [x] 3.1 实现基于 `~/.openspecui/workspaces.json` 的原子持久化存储（工作区 CRUD、区分 `local`/`remote` 来源与多 worktree 路径、跨仓 Change 手动关联映射与 Change-Branch 手动绑定），并验证并发写入与异常重启后数据完整
- [x] 3.2 实现本地目录扫描发现（识别含 `openspec/` 或 `.git` 的子目录）、远程 Git 缓存管理器（克隆至 `~/.openspecui/repos/`、URL 去重、解绑按需清理缓存）及 `openspec store list --json` / `openspec workset` / `openspec/config.yaml` (`store:`) 兼容解析，验证单仓、双仓、外部 Store 与线上 URL 仓均可正确识别规范源
- [x] 3.3 实现 OpenSpec 文档与 Delta Spec 解析器（聚合 Active Changes 与 Archive、按 Change 名或手动映射分组、解析 `ADDED/MODIFIED/REMOVED/RENAMED` 并与主 `specs/` 生成对比模型），并验证针对混合归档状态与全新能力规范的单元测试全部通过
- [x] 3.4 实现 `tasks.md` 解析器与基于 `fileHash` + 行号的乐观并发单行勾选回写接口（冲突返回 `409`，并对 `sourceType === 'remote'` 缓存仓库拒绝写回），并通过单元测试验证正常勾选保留其余格式、外部并发修改拒绝覆盖与远程仓只读拦截
- [x] 3.5 更新 `discoverLocalRepos` 与 `/api/workspaces/discover` 支持 `onlyOpenSpec` 参数且默认 `true`（仅返回含 `openspec/` 的项目，显式传 `false` 时才包含纯 `.git` 仓），并补充单元测试验证纯 Git 目录在默认扫描下被过滤
- [x] 3.6 实现本机目录浏览与系统文件夹选择器服务端接口（`GET /api/system/browse-dirs` 枚举盘符及子目录并标记 `hasOpenSpec`/`hasGit`，`POST /api/system/pick-folder` 校验 CSRF 并跨平台调起原生目录选择框），编写单测验证目录浏览只读安全与越界/非法路径处理
- [x] 3.7 实现 `openspec-ui.json` 兼容导入与工作区 `Ideas` 增删改查接口（持久化至 `workspaces.json` 不污染代码仓），编写单元测试验证 `openspec-ui.json` 解析与 Ideas 持久化
- [x] 3.8 扩展 OpenSpec 解析引擎输出生命周期阶段（`planning`/`ready_to_apply`/`in_progress`/`complete`/`archived`）、`artifactStates`（`done`/`next`/`blocked` 及阻塞说明）与 `proposal` 摘要，并通过单元测试验证各阶段与依赖阻塞状态计算准确
- [x] 3.9 在 `packages/shared` 与服务端实现 `customOrder` 模型（`changeOrder`、`ideaOrder`）及 `PUT /api/workspaces/:id/order` 原子持久化接口（支持重排 `repos`、`changes`、`ideas`，局域网只读模式拒绝），并编写单元测试验证持久化与重启保留

## 4. 只读 Git 集成与按需文件监听

- [x] 4.1 实现只读 `GitService`（`status --porcelain=v2 -b`、本地及 `origin/*` 远端分支列表、近期提交 `log`、未提交与 Commit 级 `diff` 截断保护及 `.git/index.lock` 短暂退避重试），并验证非 Git 目录降级返回友好状态而不抛错
- [x] 4.2 实现工作区级跨仓 Git 混合活动时间线聚合接口、Change-Branch/Commit 自动匹配引擎（支持按分支名/提交消息匹配及手动 Pin 覆盖）与远程缓存仓手动/定时 `git fetch` 同步调度器，并验证同步成功更新与凭证失败非阻塞报错
- [x] 4.3 实现 `LazyWatcherManager`（基于 `chokidar` 仅监听当前激活工作区、忽略 `.git/objects` 与 `node_modules`、300ms 防抖并通过 WebSocket 广播刷新事件），验证切换工作区时旧监听器正确关闭释放
- [x] 4.4 修复 `LazyWatcherManager` 禁止无 `openspec/` 且无 `.git/` 时回退全盘监听 `repo.localPath`，并设置 `followSymlinks: false`，通过单元测试验证非仓库目录挂载监听数为 0
- [x] 4.5 更新 `matchChangeToGitAcrossWorkspace` 与 `/api/workspaces/:id/git/match` 接收所属 `ownerRepoIds`，仅将所属仓及真正命中 `manual-pin`/`branch-name`/`commit-message` 的仓库标记为 `isRelated: true`，补充单元测试验证无关仓库不会混入默认关联列表
- [x] 4.6 在 `packages/shared` 与 `GitService` 实现安全切换分支方法 `switchRepoBranch`（校验目标分支引用、支持本地分支与远端跟踪分支自动 `--track` 检出、禁止 `--force` 强切丢弃本地改动、冲突报错透传）及 `POST /api/repos/:repoId/git/checkout` 接口，并补充单元测试验证正常切换与脏工作区冲突保护

## 5. React + Vite 前端工作台实现

- [x] 5.1 搭建 `packages/web` React + Vite + Tailwind/UI 基础框架、API/WebSocket 客户端与顶部全局工作区切换栏（含多仓分支与脏文件状态指示徽章、本地目录扫描导入与线上 Git URL 导入弹窗）
- [x] 5.2 实现「统一 Change 聚合看板」与「跨仓 Specs 目录树」（展示联合进度条、混合归档标识、单边变更标识与手动绑定跨仓 Change 弹窗），验证前后端同异名 Change 均能正确汇总展示
- [x] 5.3 实现 Change 详情工作台：支持 Proposal / Design / Specs / Tasks 标签页、Delta vs Main Spec 并排/内联差异高亮视图、双仓规范并排对照模式以及本地仓 `tasks.md` 实时勾选回写（含 409 冲突自动刷新提示与远程只读仓禁用态提示）
- [x] 5.4 实现 Git 关联面板与跨仓活动流视图：展示多仓独立状态卡片（含远程仓“只读缓存”标签、最近同步时间与手动“立即同步”按钮）、混合提交时间线、Change 关联分支选择器与只读 Unified/Split 代码 Diff 查看器，并验证前后端联调构建产物由 `packages/server` 静态托管可完整端到端运行
- [x] 5.5 优化前端首屏与接口请求韧性：将环境探测改为异步后台加载（不阻塞工作区展示），为 API 请求增加超时控制与可见加载/失败重试提示
- [x] 5.6 更新前端 `WorkspaceModal` 本地目录扫描：默认只展示 OpenSpec 项目（提供可选“同时显示纯 Git 仓”开关），默认不自动全部勾选并提供“全选 / 清空”按钮
- [x] 5.7 在前端 `WorkspaceModal` 的“本地目录路径”和“扫描本地目录”输入旁增加「浏览本机目录」树形选择弹窗与「系统选择文件夹」按钮，选中后自动回填本地绝对路径并验证端到端构建通过
- [x] 5.8 实现全局亮/暗主题切换、「手机/局域网访问」说明弹窗与 `readOnlyMode` 只读横幅降级提示
- [x] 5.9 升级 `ChangeBoard` 为兼容 `OpenSpec UI` 的多阶段 Kanban 看板：新增顶部仓库概览筛选卡片条、搜索/排序与 `Archived` 切换、`Stages` / `By repo` / `Cross-Repo` 三布局切换，以及 `Planning` 卡片上的 Artifact 状态胶囊
- [x] 5.10 实现可折叠 `Ideas` 侧边栏与 `New idea` / 编辑删除弹窗，并升级 `ChangeDetailView` 标签页展示 `✓` / `next` / `🔒` Artifact 依赖状态提示
- [x] 5.11 在全部新功能完成后重新运行 `npm run typecheck`、`npm run build`、`npm test` 与 `openspec validate openspecui-mvp --strict`，验证全部测试与构建端到端通过
- [x] 5.12 移除 `App.tsx` 的 `max-w-7xl` 宽度限制改为全屏铺满布局（占满视口宽高），优化 Kanban 多列铺满屏幕，并为 `ChangeDetailView` 增加「全屏 / 退出全屏」切换按钮
- [x] 5.13 集成 `react-markdown` + `remark-gfm`（禁用危险 HTML 防止 XSS），在 `Proposal`、`Design`、`Main Specs` 与 `Change Specs` 默认展示格式化 Markdown（支持源码切换），并将 `ChangeDetailView` 的 `Specs` 改为默认 Markdown 展示且可切换「Markdown 预览 / Delta vs Main 对比」，重新构建与验证通过
- [x] 5.14 修复浅色（白色）主题样式残留暗色块与对比度问题：完善 `packages/web/src/index.css` 中 `html.theme-light` 对所有 `slate` 透明背景变体、语义 Diff 提示块、悬停态、滚动条与原生控件 `color-scheme` 的覆盖，重新构建并验证通过
- [x] 5.15 抽取公共 `useEscapeKey` Hook，为全部弹窗（`ChangeDetailView`、`WorkspaceModal`、`LocalFolderPickerModal`、`IdeaModal`、跨仓关联弹窗与手机访问弹窗）接入 `Esc` 关闭支持并处理嵌套弹窗层级，重新构建并验证通过
- [x] 5.16 在前端 `ChangeBoard` 为顶部仓库筛选卡、`Ideas` 卡片、Kanban 同阶段列 Change 卡片及 `Cross-Repo` 卡片接入原生拖拽重排与 `Custom (自定义)` 排序模式，拖拽后自动持久化并验证构建通过
- [x] 5.17 更新 `ChangeDetailView` 的「Git 分支 & Diff」面板：默认仅渲染 `isRelated: true` 的所属及命中仓库，提供可选“显示工作区其余未关联仓库”折叠按钮以便按需手动 Pin，完成全量构建、测试与校验
- [x] 5.18 为 `MarkdownViewer` 增加标题锚点与 `onNavigateLink` 超链接拦截能力，在 `ChangeDetailView` 解析指向 `proposal.md`、`specs/**`、`design.md`、`tasks.md` 的相对链接（含 `#anchor`）并自动切换对应 Tab 与滚动定位，保持外链新标签打开，重新构建并验证通过
- [x] 5.19 在 `packages/shared` 与 `openspec-parser` 为归档条目增加 `archivedAt`（目录/文件时间戳）解析与单元测试；在前端 `ChangeBoard` 新增顶部 `Archive 归档库 (N)` 独立页签（按归档时间倒序，支持搜索与仓库筛选）及 `Archived (N)` 计数徽标，并在归档卡片、`Cross-Repo` 卡片与 `ChangeDetailView` 头部清晰展示归档时间，完成构建与测试验证
- [x] 5.20 抽取公共归档倒序比较器（优先 `archivedDate` 降序、同日按 `archivedAt` 降序、再按名称降序），将 `Archive 归档库`、看板 `Archived` 列（未手工调整顺序时）及 `Cross-Repo` 归档组统一改为归档时间倒序展示，完成构建与测试验证
- [x] 5.21 升级 `MarkdownViewer` 与 `ChangeDetailView` 的 `Tasks` 视图按 `tasks.md` 原文 Markdown 渲染（支持完整标题/分组/代码/超链接与渲染源码切换，隐藏 task-list 圆点并按参考图样式渲染绿色勾选框），通过 AST 行号映射任务项实现交互式勾选回写与只读禁用保护，完成全量构建与测试验证
- [x] 5.22 将看板「关联跨仓」升级为项目/仓库级关联：在 `packages/shared`、服务端 `RegistryManager` 与 API 新增 `repoLinks`（关联 2 个及以上项目仓库）持久化与单元测试，前端看板改为「关联跨仓项目」弹窗（勾选项目仓库而非 Spec/Change）并在 `Cross-Repo` 视图展示项目关联组，同时在 `ChangeDetailView` Git 面板自动联动同项目关联组内的协作仓库，完成构建、测试与校验
- [x] 5.23 在前端 `api.ts` 与 `GitActivityView` 仓库状态卡片增加工作区切换分支下拉交互（支持本地与 `origin/*` 分支切换、切换中禁用态、冲突失败内联报错提示、局域网只读禁用保护），切换成功后自动刷新工作区规范与时间线，完成构建与测试验证

## 6. 验证与打包交付准备

- [x] 6.1 配置 `packages/server` 打包嵌入 `packages/web` 构建产物并执行全量 `npm run build`、`npm test` 与 `openspec validate openspecui-mvp` 检查，确保所有单元/集成测试与生产启动流程（`npx .` 或 `node dist/cli.js`）端到端通过
