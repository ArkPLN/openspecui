# Design

## Context

`openspecui` 当前是一个刚完成 `openspec init` 初始化的空仓库（参见 [proposal.md](./proposal.md)），目标是为 OpenSpec 提供本地多项目、多仓库（含前后端各自维护 `openspec/` 的场景）可视化预览及只读 Git 关联工作台。

已确认的约束与技术基线：
- 运行环境：Node.js (v24+) + TypeScript 服务端 + React/Vite Web 前端，支持 `npx openspecui` / 本地 CLI 一键启动。
- 交互边界：Git 状态查询、跨仓时间线与代码 Diff 预览保持只读，同时支持用户显式触发非破坏性分支切换（`git switch`/`checkout`，禁止 `--force` 丢弃改动，局域网只读模式禁用）；本地仓支持 `tasks.md` 复选框精确行回写与跨仓关联配置；线上 Git URL 通过本地受控缓存目录克隆接入并支持手动/定时 `fetch` 同步（远程缓存仓禁用任何文件写回与向远端推送）。
- 安全边界：仅绑定 `127.0.0.1`、禁止 shell 字符串拼接执行 `git`/`openspec`、Git URL 协议白名单与 `protocol.ext.allow=never` / `protocol.file.allow=never` 防护、所有文件读写必须校验归属已注册工作区。

## Goals / Non-Goals

**Goals:**
- 构建单实例本地工作台架构：一个常驻或单实例 Node.js HTTP/WS 服务管理多个逻辑 Workspace，避免开多个项目占多个端口。
- 将「逻辑工作区（Workspace）」与「物理仓库（Repo）」解耦，统一支持单仓、前后端双仓各自维护 `openspec/`、外部 `openspec store` 以及线上 Git URL 只读缓存仓。
- 提供精确的 Delta Spec vs Main Spec 对比解析器，以及可应对并发外部编辑（如 AI `/opsx-apply`）的按需防抖 File Watcher 与行哈希校验回写。
- 提供清晰的架构分层与安全边界控制。

**Non-Goals:**
- 不做重型 Git 客户端：不提供 `commit`、`push`、`merge`、`rebase`、`stash` 或强制丢弃未提交改动的 `--force` 操作。
- 不做多用户云端协同/在线认证鉴权系统，也不内置托管平台 PAT Token 管理后台（远程访问复用本机已配置的 SSH Key / Git Credential）。
- 不在 UI 中全量在线编辑 `proposal.md` / `design.md` / `spec.md` 正文（正文的深度撰写和重构仍由用户编辑器或 AI CLI 完成）。

## Architecture & Security Audit

### 1. 整体架构图

```text
+-------------------------------------------------------------------------+
| Browser (React + Vite SPA)                                              |
|  - Workspace Switcher (逻辑项目切换 / 本地扫描 / 线上 URL 导入)         |
|  - OpenSpec Views (Change 聚合看板 | Delta vs Main Diff | Tasks 勾选)   |
|  - Git Views (多仓状态条 | 混合时间线 | 远程同步按钮 | Code Diff)       |
+-------------------------------------------------------------------------+
                   | REST API (HTTP)               ^ WebSocket (增量推送)
                   v                               |
+-------------------------------------------------------------------------+
| Local Workbench Server (Node.js + TypeScript, 127.0.0.1:<port>)         |
|                                                                         |
|  +-----------------------+    +--------------------------------------+  |
|  | API & Security Guard  |    | Lazy Watcher & Remote Sync Manager   |  |
|  | - Origin/Host 校验    |    | - 仅监听 activeWorkspace 本地仓库    |  |
|  | - Git URL 协议白名单  |    | - 300ms 防抖 + .git/index.lock 退避  |  |
|  | - 路径规范化越界检查  |    | - 远程仓按需/定时 git fetch 同步     |  |
|  +-----------------------+    +--------------------------------------+  |
|             |                                    |                      |
|             v                                    v                      |
|  +-----------------------+    +--------------------------------------+  |
|  | Workspace Registry    |    | Domain Adapters (按 repo.path cwd)   |  |
|  | (~/.openspecui/       |    | - OpenSpecParser (CLI + MD/Delta解析)|  |
|  |   workspaces.json)    |    | - GitService (execFile git, 只读)    |  |
|  +-----------------------+    +--------------------------------------+  |
+-------------------------------------------------------------------------+
        |                         |                          |
        v                         v                          v
  [Local Repos (.git +      [Optional Store           [Remote Cache
   openspec/)]               (.git + specs/)]          (~/.openspecui/repos/
                                                        只读 clone + fetch)]
```

### 2. 安全性审计（Security Audit）

针对本地开发工具最容易被忽略的本地提权、CSRF、恶意 Git URL 和目录穿越风险，在编码前明确以下控制措施：

1. **CSRF / 恶意网页跨站攻击本地服务（高风险）**
   - 风险：用户浏览器打开恶意网页时，网页 JS 可能向 `http://127.0.0.1:3456/api/...` 发起请求，读取本地仓库源码或篡改 `tasks.md`。
   - 缓解：
     1. 服务端默认仅监听 `127.0.0.1`（禁止 `0.0.0.0`）。
     2. 启动时生成一次性随机 Session Token 或校验 `Host` / `Origin` 头（白名单仅允许当前本地服务 Origin 或显式 `--dev` 前端 Origin），对所有写请求（`PATCH tasks`、工作区增删改、触发远程 clone/fetch）强制校验自定义 Header / Token。
2. **命令注入（Command Injection，高风险）**
   - 风险：仓库路径、Git URL、Change 名称、分支名或 Commit SHA 传入 `git` / `openspec` 时若拼接 shell 命令，遇到恶意输入会触发命令注入。
   - 缓解：统一使用 Node.js `child_process.execFile` / `spawn` 并设置 `shell: false`，所有参数作为数组传递；分支名与 SHA 均做严格正则/参数边界（例如在 git pathspec 与 URL 前加 `--` 分隔符）。
3. **恶意 Git URL 传输协议攻击与阻塞挂起（高风险）**
   - 风险：Git 支持 `ext::`（可直接执行任意本地命令）与 `file://`（可能通过恶意路径或本地符号链接探测文件），且私有 HTTPS/SSH 仓缺失凭证时 `git` 可能无限等待终端交互输入导致服务卡死。
   - 缓解：
     1. URL 白名单仅放行 `https://`、`http://`、`ssh://` 与标准 SCP 形式 `git@...:`，严禁空白字符、参数注入前缀（`-`）及非白名单协议；
     2. 每次执行 `clone` / `fetch` 显式附加 `-c protocol.file.allow=never -c protocol.ext.allow=never`；
     3. 强制设置环境变量 `GIT_TERMINAL_PROMPT=0` 与 `GIT_SSH_COMMAND`（含 `BatchMode=yes`）及操作超时（如 60 秒），鉴权失败立即返回可读错误。
4. **任意文件读写与路径穿越（Path Traversal，高风险）**
   - 风险：前端传入 `repoId` 和相对路径读取 Diff 或回写 `tasks.md` 时通过 `../` 或软链接逃逸到系统目录（如 `~/.ssh`）。
   - 缓解：先通过 `fs.realpathSync` 解析仓库根目录与目标文件真实路径，验证目标路径严格位于已注册仓库根目录前缀之下；`tasks.md` 写入接口仅允许匹配 `openspec/changes/*/tasks.md` 的合法路径，且当仓库为 `sourceType: 'remote'` 时直接拒绝写入。
5. **敏感信息与资源耗尽（DoS）**
   - 风险：超大仓库或二进制大文件 Diff 导致内存飙升，或 20 个项目全量开 Watcher 耗尽文件句柄。
   - 缓解：按需懒监听（仅激活工作区挂载 Watcher）；远程缓存默认优先采用浅层/过滤克隆策略（如 `--filter=blob:none` 并在不支持时回退普通克隆）并限制同时克隆并发数；`git diff` 与 `git log` 设置明确条数上限（如默认 50 条）与单文件 Diff 字节上限（超过阈值提示截断，不渲染二进制内容）。

## Decisions

### Decision 1: 包结构采用 npm Workspaces 单仓多包（`packages/server`、`packages/web`、`packages/shared`）
- **选择**：在一个 TypeScript 工程下划分 `shared`（类型与契约）、`server`（CLI + HTTP/WS 后台 + 解析器）、`web`（React + Vite 前端，构建产物由 `server` 静态托管）。
- **替代方案**：前后端完全独立发布两个仓库或把 React 直接写进同目录混合编译。
- **理由**：`shared` 直接共享 Workspace、Change、DeltaDiff、GitTimeline 的类型定义，避免接口漂移；`server` 打包时直接嵌入 `web/dist`，用户只需一条 `npx openspecui` 即可无感知跑起来。

### Decision 2: 本地服务框架选用 Fastify（或原生 Node HTTP + `ws`）+ `chokidar`
- **选择**：服务端使用轻量级 HTTP 框架（Fastify + `@fastify/static` + `@fastify/websocket`）与 `chokidar` 进行跨平台文件监听。
- **替代方案**：重型全栈框架（如 Next.js / NestJS）或手动手写裸 `http` 路由。
- **理由**：Next.js 对本地单进程 CLI 工具过重且打包体积大；Fastify 启动毫秒级、TypeScript 支持好、自带 Schema 校验，配合 `ws` 实现增量推送非常干净。

### Decision 3: 数据持久化保存在用户本地配置目录（`~/.openspecui/workspaces.json`）
- **选择**：Workspace 定义、Repo 绑定关系、跨仓 Change 手动连线映射、Change-Branch 手动 Pin 关系全部存入 `~/.openspecui/workspaces.json`，采用原子写（写临时文件再 `rename`）。
- **替代方案**：在每个代码仓里写 `.openspecui.json`。
- **理由**：多项目注册表和前后端跨仓映射属于用户本地视图状态，写入业务仓库会污染团队 Git 工作区。

### Decision 4: OpenSpec 解析采用「CLI 权威状态 + 轻量 Markdown/Delta AST 解析」混合模式
- **选择**：项目根发现、Store 列表、Workset 列表、Change 状态优先调用 `openspec` CLI（`--json`）保证与官方行为一致；Delta Spec 块解析（`## ADDED/MODIFIED/REMOVED/RENAMED Requirements`）、主规范对照 Diff 与 `tasks.md` 行解析由服务端 TS 解析器直接读取文件完成，并缓存在内存中按文件 mtime 失效。
- **替代方案**：全部用正则自己重写一遍 OpenSpec 配置解析逻辑，或每次页面点击都全量调一遍 CLI。
- **理由**：混合模式既能无缝兼容 `openspec` 后续的 `store`/`workset` 规则演进，又能避免频繁起子进程导致列表卡顿，还能精准支持 `tasks.md` 的行级哈希校验回写。

### Decision 5: `tasks.md` 交互回写采用「行号 + 原文行哈希（Optimistic Concurrency）」校验
- **选择**：前端加载 `tasks.md` 时，每条任务附带 `lineNumber` 与该行规范化文本/文件摘要（`fileHash`）。点击勾选时向服务端提交 `{ fileHash, lineNumber, expectedChecked, nextChecked }`；服务端重读文件比对 `fileHash`（或目标行上下文），匹配才执行单行替换并原子写回，不匹配则返回 `409 Conflict` 并触发重新加载。
- **替代方案**：直接覆盖整份 `tasks.md` 字符串。
- **理由**：AI 执行 `/opsx-apply` 时随时可能修改 `tasks.md`，整文件覆盖极易把 AI 刚写进去的新任务或勾选状态冲掉。

### Decision 6: Git 状态集成与受控分支切换通过直接调用 `git` CLI（`execFile`）实现
- **选择**：直接调用系统 `git` 命令（`status --porcelain=v2 -b`、`log`、`diff`、`show-ref`、`switch`），不引入 `nodegit` 等原生 C++ 绑定库。切换分支时通过 `switchRepoBranch` 先校验分支引用合法性并检测是否存在于仓库分支列表中，优先使用 `git switch <branch>`（对于 `origin/<name>` 且本地尚无同名分支时使用 `git switch --track <remoteBranch>` 创建本地跟踪分支，不进入 `detached HEAD`），绝不附加 `-f`/`--force`；切换成功后广播 `workspace:refresh` 同步刷新顶栏分支、OpenSpec 规范与活动时间线。
- **替代方案**：`nodegit` 或纯 JS 实现 `isomorphic-git`。
- **理由**：`nodegit` 在 Windows / 新版 Node 24 下编译极易踩坑；`isomorphic-git` 对 `worktree` 和复杂配置兼容性差；系统 `git` 行为最准确，且通过 `execFile` + 参数数组零注入风险。遇到 `.git/index.lock` 报错时做短暂退避重试即可。

### Decision 7: 线上 Git 地址接入采用「受控缓存只读 Clone + Fetch 同步」
- **选择**：用户输入线上 Git URL（HTTPS/SSH）后，由服务端统一克隆至 `~/.openspecui/repos/<hash>/` 缓存目录，标记 `sourceType: 'remote'`，复用同一套 `OpenSpecParser` 和 `GitService` 读取规范、分支（含 `origin/*`）与代码 Diff；提供手动“立即同步”与可配置周期的后台 `git fetch` 同步，并禁止对远程缓存仓执行 `tasks.md` 写回。
- **替代方案**：直接对接 GitHub/GitLab/Gitee 各自 REST/GraphQL API 进行无克隆读取。
- **理由**：本地缓存方式通吃 GitHub、GitLab、Gitee、Bitbucket 及内网私有 Git 服务，可直接复用本机 SSH Key 与 Git 凭证管理器，不受各平台 API 限流及接口差异限制，且解析逻辑与本地仓库 100% 统一；禁止远程缓存仓写回可避免本地缓存产生无法推送的分叉状态。

### Decision 8: 首屏会话初始化与 `openspec` CLI 环境探测异步解耦
- **选择**：`GET /api/session` 仅返回内存中的 `csrfToken` 与 `activeWorkspaceId`（毫秒级无阻塞响应）；耗时的 `openspec --version` / `store list` / `workset list` 改由独立 `GET /api/env`（内部并行执行并带短超时）与后台预热完成，不阻塞前端首屏渲染。
- **替代方案**：在 `/api/session` 中串行 `await` 所有 CLI 子进程。
- **理由**：在 Windows 环境下串行启动多个 Node CLI 子进程耗时长，阻塞首屏会让浏览器长期停在加载态。

### Decision 9: 本机文件夹选择采用「内置目录树浏览 + 系统原生文件夹弹窗」双通道
- **选择**：提供 `GET /api/system/browse-dirs`（枚举 Windows 盘符/`/` 与子目录，仅暴露目录名与 `hasOpenSpec`/`hasGit` 标记）和 `POST /api/system/pick-folder`（按 OS 调用 PowerShell STA `FolderBrowserDialog` / macOS `osascript` / Linux `zenity`）。
- **替代方案**：仅依赖浏览器 `<input webkitdirectory>` 或仅依赖系统弹窗。
- **理由**：浏览器出于安全沙箱禁止暴露 `<input webkitdirectory>` 的真实绝对路径；系统弹窗方便快捷但在部分浏览器全屏或远程桌面场景可能被遮挡，内置目录树浏览则 100% 可靠且能边选边看到哪些目录是 OpenSpec 项目。

### Decision 10: 兼容 `ToruAI/openspec-ui` 看板模型与 `--host 0.0.0.0` 只读安全降级
- **选择**：在保留 Git 集成、Delta Diff、跨仓手动映射与本地 `tasks.md` 回写能力的基础上，扩展解析层输出 `stage`（`planning`/`ready_to_apply`/`in_progress`/`complete`/`archived`）和 `artifactStates`（`done`/`next`/`blocked`）；在 `RepoChangeEntry` 保留 `archivedDate` 并新增 `archivedAt`（取归档目录与核心文件最近 `mtime` 的 ISO 时间戳）；支持 `openspec-ui.json` 导入及 `Ideas` 本地存储；`ChangeBoard` 在 `Board 看板` 与 `Specs 规范库` 之外提供独立的 `Archive 归档库 (N)` 视图以及看板右上角 `Archived (N)` 开关，并统一通过公共归档倒序比较器（优先比较业务归档日期 `archivedDate` 降序、同日再比较 `archivedAt` 降序、再按名称降序，避免 Git 克隆重写 `mtime` 造成错序）对归档项排序且在卡片、跨仓组与详情头部展示归档时间；仅当显式传 `--host 0.0.0.0` 时开放局域网监听并同时锁定全局 `readOnlyMode = true`（拦截一切 `POST/PUT/PATCH/DELETE` 与宿主机目录浏览/弹窗接口）。
- **替代方案**：在 `--host 0.0.0.0` 下开放写接口或另起一套独立前端。
- **理由**：统一数据模型即可在同一个前端无缝提供 `Stages` / `By repo` / `Cross-Repo` 三种视角，而 `readOnlyMode` 强制降级可彻底消除局域网手机查看模式下的远程越权写入与信息泄露风险。

### Decision 11: 前端安全 Markdown 渲染、内部链接 Tab 跳转与全屏铺满工作台布局
- **选择**：使用 `react-markdown` + `remark-gfm`（不启用 `rehype-raw`）安全渲染 `proposal.md`、`design.md`、`tasks.md` 与 `specs/**/*.md`；Change `Specs` 默认以洁净 Markdown 视图呈现，通过顶部开关按需切换至「Delta vs Main 对比」；`Tasks` 视图改用 `MarkdownViewer` 按 `tasks.md` 原文 Markdown 展示（保留章节标题、段落、代码与源码切换，隐藏任务列表圆点并将复选框按绿色勾选风格渲染），利用 `remark-gfm` 节点的 `node.position.start.line` 精确映射 `TasksDocument.items` 行号，复用现有行级乐观锁勾选回写与只读保护；在 `MarkdownViewer` 为标题生成稳定锚点并注入 `onNavigateLink` 拦截回调，`ChangeDetailView` 解析指向 `proposal.md`、`specs/**`、`design.md`、`tasks.md`（含 `#anchor`）的相对路径自动切换至对应 Tab 与定位锚点，纯 `#anchor` 页内滚动，外部 `http/https/mailto` 维持新窗口打开；主应用移除居中窄宽度约束改用全视口流式布局，详情弹窗支持一键切换全屏。
- **替代方案**：使用 `marked` + `dangerouslySetInnerHTML` 或在 `Specs` 强制默认展示 Diff。
- **理由**：禁用原始 HTML 解析可杜绝恶意仓库 Markdown 中的脚本 XSS 风险；默认洁净 Markdown 预览符合阅读规范的直觉，保留开关即可兼顾回归核对 Delta 差异的需求。

### Decision 12: 看板自定义拖拽排序、跨仓项目关联组与 Change-Git 精确关联作用域
- **选择**：基于原生 HTML5 Drag & Drop 实现工作区仓库卡、`Ideas` 及同阶段 Kanban Change 卡片的拖拽重排，并将 `customOrder`（`changeOrder`、`ideaOrder`、`repos` 顺序）通过 `PUT /api/workspaces/:id/order` 持久化至 `~/.openspecui/workspaces.json`（只读模式下禁用）；新增工作区级跨仓项目关联模型 `repoLinks`（`id`、`title`、`repoIds[]`）及 `POST/DELETE /api/workspaces/:id/repo-links` 接口，将看板主关联入口改为选择 2 个及以上项目仓库组建逻辑协同项目组并在 `Cross-Repo` 展示（向后保留既有 `changeLinks`）；同时在 Change-Git 匹配接口传入所属仓库及同属 `repoLinks` 协同项目组的 `ownerRepoIds`，仅返回相关仓库，未在同组且未命中的其余无关仓库通过 `isRelated: false` 标记默认折叠。
- **替代方案**：引入重型第三方拖拽库并允许跨阶段拖拽，或对工作区全部仓库无差别兜底展示 `current-branch`。
- **理由**：原生 DnD 零依赖且不破坏 OpenSpec 基于真实产物的阶段真实性；精确作用域过滤避免同工作区内其他独立项目的 Git 记录干扰当前 Change 审查。

## Risks / Trade-offs

- **[Risk] Windows / macOS 下大量文件、用户主目录误挂载或符号链接（Junction）触发 Watcher 卡死** → **Mitigation**: `cli.ts` 仅当目标目录存在 `openspec/` 或 `.git/`（且非用户主目录/盘符根）时才自动注册；`LazyWatcherManager` 严禁在无 `openspec/` 且无 `.git/` 时回退全盘监听 `repo.localPath`，并强制 `followSymlinks: false`，仅精确监听 `openspec/**` 与 `.git/HEAD`、`.git/refs/**`、`.git/index`。
- **[Risk] 外部独立 `store` 仓库与代码仓库分离时，Change 关联逻辑变复杂** → **Mitigation**: 在数据模型中明确区分仓库的 `kind: 'code' | 'store' | 'hybrid'` 与 `sourceType: 'local' | 'remote'`，允许 Workspace 同时包含代码仓与关联 Store，Git 面板按仓各自独立渲染，Store 仓也能参与分支与时间线展示。
- **[Risk] 线上仓库体积较大导致首次克隆耗时，或私有仓未在本机配置凭证** → **Mitigation**: 克隆优先尝试 `--filter=blob:none`（部分老版本服务端不支持时自动降级常规克隆），异步返回克隆进度状态不阻塞主界面；鉴权失败通过 `GIT_TERMINAL_PROMPT=0` 快速失败并提示用户检查本机 SSH/Git 凭证。
- **[Risk] 用户机器未全局安装 `openspec` CLI 或版本过旧** → **Mitigation**: 启动时探测 `openspec --version` 并缓存能力状态；若不可用，降级为纯文件扫描模式并在界面顶部给出友好提示，保证基础 Markdown 和 Git 预览仍可使用。
- **[Risk] 单实例检测在端口冲突或僵尸进程时误判** → **Mitigation**: 结合 PID + 端口健康探测接口（`GET /api/health` 校验应用标识 `openspecui`），若端口被其他程序占用则自动递增尝试可用端口，并在终端清晰输出实际访问地址。
