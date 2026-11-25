# Spec Delta

## Purpose

管理本地多项目工作区与物理仓库注册表，将单仓库、前后端各自维护 `openspec/` 的多仓库以及 OpenSpec 原生 `store`/`workset` 统一组织为可切换的逻辑工作区，并持久化跨仓需求映射配置。

## ADDED Requirements

### Requirement: 逻辑工作区与物理仓库注册
The system SHALL allow users to create, list, update, and remove logical workspaces, where each workspace binds one or more local repository paths identified by canonical filesystem path rather than repository name.

#### Scenario: 创建绑定前后端双仓的逻辑工作区
- **WHEN** 用户创建一个名为 `ecommerce` 的工作区并绑定前端仓库目录与后端仓库目录
- **THEN** 系统在本地配置中持久化该工作区及其仓库路径列表（含角色标签如 `FE` / `BE`），并可在工作区切换器中立即可见

#### Scenario: 同一远程仓的多个 Git Worktree 并存注册
- **WHEN** 用户将同一远程仓库的两个不同本地 `git worktree` 路径加入注册表
- **THEN** 系统将它们作为两个独立的仓库条目分别保存，互不覆盖状态

#### Scenario: 扫描发现本地工作目录
- **WHEN** 用户指定一个父级目录触发项目扫描
- **THEN** 系统默认仅返回包含 `openspec/` 的 OpenSpec 候选项目（除非用户显式启用包含纯 `.git` 仓选项），结果默认不自动全选且不自动修改任何被扫描目录的文件

### Requirement: 本机目录浏览与系统文件夹选择
The system SHALL allow users to browse local filesystem drives and subdirectories via a read-only server directory listing or invoke the host operating system's native folder picker dialog to populate local repository or scan root paths without manual typing.

#### Scenario: 在网页内浏览本机盘符与子目录树
- **WHEN** 用户在添加仓库或扫描目录弹窗中点击“浏览本机目录”
- **THEN** 系统返回本机可用盘符或指定目录下的只读子目录列表（附带 `openspec/` 与 `.git/` 标记），用户点选后即可回填该目录绝对路径

#### Scenario: 调用本机系统文件夹选择弹窗
- **WHEN** 用户点击“系统选择文件夹”触发原生选择器并选定目录
- **THEN** 服务端将所选文件夹的规范化绝对路径返回给前端输入框；若用户取消选择则保持原值不变且不报错

### Requirement: 兼容 openspec-ui.json 与工作区 Ideas 管理
The system SHALL support importing workspace sources from an `openspec-ui.json` configuration file when present, and SHALL allow users to create, edit, and delete lightweight workspace ideas stored locally without modifying repository files.

#### Scenario: 识别并导入 openspec-ui.json
- **WHEN** 用户启动目录或选定目录中存在合法的 `openspec-ui.json`（含 `sources` 路径列表）
- **THEN** 系统解析其中的仓库名称与路径并生成或导入对应的工作区绑定，且不修改原配置文件

#### Scenario: 管理工作区本地 Ideas
- **WHEN** 用户在界面中新建、编辑或删除一条关联某个仓库或未归属仓库的 Idea
- **THEN** 系统将 Ideas 持久化在本地注册表中并与当前工作区绑定展示，不向代码仓库写入任何文件

#### Scenario: 持久化工作区自定义拖拽排序
- **WHEN** 用户对工作区内的仓库展示顺序、Change 卡片或 Ideas 进行自定义拖拽重排
- **THEN** 系统将排序配置保存在本地注册表中且刷新页面或重启服务后保持不变，不修改任何业务代码仓库文件

### Requirement: OpenSpec 规范源与 Store 兼容解析
The system SHALL detect whether each bound repository uses a local `openspec/` directory or declares an external `store:` in its `openspec/config.yaml`, and SHALL discover locally registered OpenSpec stores and worksets as importable sources.

#### Scenario: 识别使用外部 Store 的仓库
- **WHEN** 绑定仓库的 `openspec/config.yaml` 中声明了 `store:` 指向本地已注册的独立规范仓
- **THEN** 系统将该仓库的代码 Git 上下文与对应 Store 的规范路径关联展示，并在 Store 未注册或配置无效时给出明确提示

#### Scenario: 从现有 OpenSpec Workset 导入工作区
- **WHEN** 本机存在已保存的 OpenSpec workset 且用户选择导入
- **THEN** 系统读取其成员目录列表并生成对应的逻辑工作区视图，且不修改原生 workset 配置

### Requirement: 跨仓项目关联与跨仓 Change 映射
The system SHALL allow users to manually link 2 or more repositories (projects) within a workspace into a logical cross-repo project group (`repoLinks`), and SHALL also support optional manual change-level linking (`changeLinks`), persisting all mappings locally without modifying repository files.

#### Scenario: 将两个或多个项目仓库关联为跨仓协同组
- **WHEN** 用户在「关联跨仓项目」弹窗中输入项目组名称（如 `驾校前后端`）并勾选工作区内的 2 个及以上项目仓库
- **THEN** 系统在本地注册表持久化该跨仓项目关联组；当组内任意仓库被移除导致剩余成员少于 2 个时，自动清理失效关联组

#### Scenario: 绑定异名跨仓 Change
- **WHEN** 用户将前端仓库的 `fe-sso` 与后端仓库的 `sso-api` 手动关联到同一逻辑组 `统一登录`
- **THEN** 系统在本地注册表持久化该映射，并在工作区聚合看板中将两者合并展示

### Requirement: 线上 Git 仓库注册与受控缓存
The system SHALL allow users to register remote Git repositories via HTTPS or SSH URLs into a workspace as read-only code repositories or remote OpenSpec stores, cloning them into a managed local cache directory distinct from user-edited local directories.

#### Scenario: 通过线上 Git URL 导入只读仓库或远程 Store
- **WHEN** 用户输入一个合法的 HTTPS 或 SSH Git 地址（如 `https://github.com/org/repo.git` 或 `git@gitlab.com:org/repo.git`）并将其添加到工作区
- **THEN** 系统将其克隆到本地受控缓存目录，在注册表中标记为远程只读来源并记录原始 URL 与最近同步时间

#### Scenario: 重复导入相同线上 Git URL
- **WHEN** 用户在同一或不同工作区中再次添加已缓存过的相同线上 Git URL
- **THEN** 系统复用或提示关联已有缓存条目，避免无意义地重复克隆多份相同仓库

#### Scenario: 移除远程仓库绑定并清理缓存
- **WHEN** 用户从工作区移除一个远程只读仓库绑定
- **THEN** 系统解除该工作区绑定，且仅在无其他工作区引用并经用户确认时清理对应的本地缓存目录
