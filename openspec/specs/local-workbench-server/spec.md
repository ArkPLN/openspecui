# local-workbench-server Specification

## Purpose

提供本地单实例 `openspecui` CLI 与后台服务，承载 React Web 界面、工作区 API、当前激活工作区的按需实时文件监听以及本地进程与文件系统访问安全边界控制。

## Requirements

### Requirement: 单实例本地服务与 CLI 启动
The system SHALL provide an `openspecui` CLI command that starts or reuses a single local HTTP and WebSocket server bound by default exclusively to localhost (`127.0.0.1`), supports an explicit `--host 0.0.0.0` flag that enforces strict read-only mode for LAN/mobile viewing, opens or prints the web workbench URL, and registers target directories when they are valid OpenSpec/Git repositories or multi-project parent folders containing OpenSpec repositories or `openspec-ui.json` (never auto-registering user home or filesystem root directories).

#### Scenario: 在项目目录或包含多个 OpenSpec 子项目的父目录执行 CLI
- **WHEN** 用户在含 `openspec/`、`.git/`、`openspec-ui.json` 的目录，或直接包含多个 OpenSpec 子项目的非主目录父文件夹下执行 `openspecui`
- **THEN** 服务检测本地端口监听状态；若尚未运行则启动单实例服务并自动注册激活单仓或多仓工作区，若已在运行则复用现有实例并将该上下文激活

#### Scenario: 显式使用 --host 0.0.0.0 开启局域网只读查看
- **WHEN** 用户显式以 `--host 0.0.0.0` 启动 `openspecui`
- **THEN** 服务允许局域网设备访问并输出本机局域网访问 URL，同时强制关闭所有写接口（`tasks.md` 回写、Git 分支切换、工作区/Ideas 增删改、远程同步与系统目录浏览/弹窗）返回只读拒绝

#### Scenario: 在非项目目录（如用户主目录）执行 CLI 启动工作台
- **WHEN** 用户在既无 `openspec/` 也无 `.git/` 的普通目录或用户主目录下执行 `openspecui`
- **THEN** 服务正常启动并展示已有激活工作区或空工作台引导页，不将该普通目录自动注册为工作区仓库

#### Scenario: 仅监听本机回环地址（默认）
- **WHEN** 本地工作台服务在未传 `--host` 时启动网络监听
- **THEN** 服务默认绑定 `127.0.0.1`（不暴露到 `0.0.0.0`），防止局域网未授权访问本地代码仓与文件回写接口

### Requirement: 按需实时文件监听与增量推送
The system SHALL watch filesystem changes only for valid OpenSpec or Git targets (`openspec/` and `.git/` refs/head/index) belonging to local repositories in the currently active workspace, disabling symlink traversal and never falling back to recursive full-directory watching, and SHALL keep initial session bootstrap non-blocking without waiting synchronously on external CLI probing.

#### Scenario: 切换工作区时释放旧监听并挂载新监听
- **WHEN** 用户从工作区 A 切换到工作区 B
- **THEN** 后台服务关闭工作区 A 的文件系统监听器，并为工作区 B 绑定仓库的 `openspec/` 与 `.git/` 状态目标开启按需监听

#### Scenario: 仓库目录缺少 OpenSpec 与 Git 时不挂载全盘监听
- **WHEN** 工作区中的某目录既不存在 `openspec/` 也不存在 `.git/`
- **THEN** 服务端不为该目录挂载任何递归根目录监听器，防止主目录或大目录扫描卡死事件循环

#### Scenario: AI 批量写入文件时防抖刷新
- **WHEN** 外部工具在短时间内连续写入 `openspec/changes/` 下的多个文档与代码文件
- **THEN** 服务端对事件进行防抖合并并在写操作稳定后向前端推送增量更新通知，且遇到 `.git/index.lock` 时安全延迟重试而不中断服务

### Requirement: 本地命令执行与路径安全边界
The system SHALL execute `openspec` and `git` commands using parameterized arguments without shell interpolation, SHALL validate remote Git URLs against an explicit protocol allowlist (`https://`, `http://`, `ssh://`, and `git@...:` SCP syntax) with interactive prompts disabled (`GIT_TERMINAL_PROMPT=0`), and SHALL restrict file read and `tasks.md` write-back operations strictly to canonicalized paths inside registered local (non-remote-cache) workspace repositories.

#### Scenario: 拒绝越权路径访问与任意文件写入
- **WHEN** API 请求包含目录穿越路径（`..`）、指向未注册工作区之外的文件路径，或尝试写入非 `tasks.md` 文件或远程只读缓存仓库
- **THEN** 服务端校验路径规范化归属或只读来源失败并拒绝请求，返回明确的权限错误码

#### Scenario: 拦截危险 Git 传输协议与恶意 URL
- **WHEN** 用户提交包含 `ext::`、`file://`、`fd::` 等非白名单协议或非法格式的 Git URL
- **THEN** 服务端拒绝执行克隆或拉取，返回明确的 URL 校验错误，且在调用 `git` 时显式禁用危险传输协议并强制非交互超时保护

#### Scenario: 本机目录浏览与系统弹窗安全边界
- **WHEN** 前端请求列举本机目录树或触发系统原生文件夹选择器
- **THEN** 目录浏览接口仅返回目录名、绝对路径与 `openspec/`/`.git` 标记（不读取文件内容），系统弹窗接口校验本机 `127.0.0.1` 与 CSRF Token 后以受控参数及超时限制执行
