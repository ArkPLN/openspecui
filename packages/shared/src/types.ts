/**
 * @file 共享领域模型类型定义
 * @description 定义 Workspace、Repository、OpenSpec 解析结果、Delta 对比、Git 只读状态及 WebSocket 推送消息契约。
 * @author ypc
 */

/** 仓库物理来源类型：本地用户目录或线上受控只读缓存 */
export type RepoSourceType = 'local' | 'remote';

/** 仓库在 OpenSpec 体系中的角色类型 */
export type RepoKind = 'code' | 'store' | 'hybrid';

/** 远程缓存同步状态 */
export type RemoteSyncState = 'idle' | 'cloning' | 'syncing' | 'error';

/**
 * 工作区下绑定的单个物理仓库配置。
 * 使用规范化本地路径（local）或缓存路径（remote）区分同一远程仓的不同 worktree。
 */
export interface RepoBinding {
  /** 仓库唯一标识（UUID 或稳定哈希 ID） */
  id: string;
  /** 展示名称 */
  name: string;
  /** 角色标签，例如 FE、BE、Store、Docs */
  role: string;
  /** 仓库角色类型 */
  kind: RepoKind;
  /** 来源类型：local 可勾选 tasks.md，remote 为只读受控缓存 */
  sourceType: RepoSourceType;
  /** 本机规范化绝对路径（对于 remote 仓指向 ~/.openspecui/repos/<hash>） */
  localPath: string;
  /** 线上 Git URL（仅 sourceType === 'remote' 时存在） */
  remoteUrl?: string;
  /** 声明使用的外部 Store ID（解析自 openspec/config.yaml） */
  declaredStoreId?: string;
  /** 远程同步状态 */
  syncState?: RemoteSyncState;
  /** 最近一次 fetch 同步的 ISO 时间戳 */
  lastSyncedAt?: string;
  /** 最近一次同步或解析错误信息 */
  lastError?: string;
  /** 自动 fetch 间隔（分钟），0 或未设置表示仅手动同步 */
  autoSyncIntervalMinutes?: number;
}

/** 跨仓项目关联组（将 2 个或多个物理仓库关联为协同项目组） */
export interface CrossRepoProjectLink {
  /** 关联组 ID */
  id: string;
  /** 项目组名称 */
  title: string;
  /** 参与关联的仓库 ID 列表 */
  repoIds: string[];
  /** 创建时间 ISO */
  createdAt: string;
}

/** 跨仓 Change 手动关联映射（解决前后端 Change 命名不一致） */
export interface CrossRepoChangeLink {
  /** 关联组 ID */
  id: string;
  /** 用户自定义的逻辑需求显示名 */
  title: string;
  /** 参与关联的仓库 Change 引用列表 */
  members: Array<{
    repoId: string;
    changeName: string;
  }>;
}

/** Change 与特定仓库分支/Commit 的手动绑定 */
export interface ChangeBranchPin {
  /** 所属逻辑 Change 标识（组 ID 或同名 slug） */
  changeKey: string;
  /** 目标仓库 ID */
  repoId: string;
  /** 手动绑定的分支名（如 origin/feat/sso 或 feat/sso） */
  branch?: string;
  /** 手动绑定的特定 Commit SHA */
  commitSha?: string;
}

/** 工作区轻量灵感条目（持久化于本地注册表，不写入代码仓） */
export interface WorkspaceIdea {
  id: string;
  repoId?: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** 工作区自定义拖拽排序配置 */
export interface WorkspaceCustomOrder {
  /** Change 卡片排序键列表（格式 `${repoId}:${changeName}` 或 `groupKey`） */
  changeOrder: string[];
  /** Idea 卡片排序 ID 列表 */
  ideaOrder: string[];
}

/** 逻辑工作区（一个工作区可包含单仓、前后端多仓及关联 Store） */
export interface Workspace {
  /** 工作区唯一 ID */
  id: string;
  /** 工作区名称 */
  name: string;
  /** 绑定的仓库列表 */
  repos: RepoBinding[];
  /** 跨仓项目（仓库）关联组 */
  repoLinks?: CrossRepoProjectLink[];
  /** 手动跨仓 Change 关联组 */
  changeLinks: CrossRepoChangeLink[];
  /** 手动 Change-Branch/Commit Pin 记录 */
  branchPins: ChangeBranchPin[];
  /** 轻量灵感列表 */
  ideas: WorkspaceIdea[];
  /** 自定义拖拽排序状态 */
  customOrder?: WorkspaceCustomOrder;
  /** 创建时间 ISO */
  createdAt: string;
  /** 最近访问时间 ISO */
  lastOpenedAt: string;
}

/** 持久化至 ~/.openspecui/workspaces.json 的根结构 */
export interface RegistryStoreData {
  /** 数据格式版本号 */
  version: number;
  /** 当前激活的工作区 ID */
  activeWorkspaceId: string | null;
  /** 注册的工作区集合 */
  workspaces: Workspace[];
}

/** 单个任务条目（解析自 tasks.md） */
export interface TaskItem {
  /** 1-based 行号 */
  lineNumber: number;
  /** 所属分组标题（如 ## 1. Setup） */
  section: string;
  /** 任务描述文本 */
  text: string;
  /** 是否已完成 */
  checked: boolean;
  /** 该行原始文本，用于乐观锁上下文校验 */
  rawLine: string;
}

/** tasks.md 解析结果 */
export interface TasksDocument {
  /** 文件相对仓库根路径 */
  relativePath: string;
  /** 文件内容 SHA-256 摘要，用于乐观并发校验 */
  fileHash: string;
  /** 是否只读（remote 仓强制为 true） */
  readOnly: boolean;
  /** 任务列表 */
  items: TaskItem[];
  /** 已完成数量 */
  completedCount: number;
  /** 总数量 */
  totalCount: number;
  /** 原始 Markdown 内容 */
  rawContent: string;
}

/** 单条 Requirement 的结构化解析 */
export interface ParsedRequirement {
  /** Requirement 名称 */
  name: string;
  /** 原始 Markdown 文本 */
  rawMarkdown: string;
  /** Scenario 标题列表 */
  scenarios: string[];
}

/** Delta 操作类型 */
export type DeltaOperation = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

/** Delta Spec 中的单个变更项 */
export interface DeltaRequirementDiff {
  /** 操作类型 */
  operation: DeltaOperation;
  /** Requirement 名称（RENAMED 时为目标名称） */
  name: string;
  /** RENAMED 时原名称 */
  fromName?: string;
  /** 变更后的 Requirement Markdown（REMOVED 时为空或原因说明） */
  afterMarkdown: string;
  /** 主规范（openspec/specs）中的原有 Markdown（若存在） */
  beforeMarkdown?: string;
}

/** 单个能力规范的 Delta vs Main 对比结果 */
export interface CapabilityDeltaDiff {
  /** 能力相对路径，例如 workspace-registry */
  capabilityPath: string;
  /** Delta 文件相对路径 */
  deltaFilePath: string;
  /** 主规范文件是否存在 */
  hasMainSpec: boolean;
  /** 主规范原文（若存在） */
  mainSpecRaw?: string;
  /** Delta 文件原文 */
  deltaSpecRaw: string;
  /** 结构化差异条目 */
  items: DeltaRequirementDiff[];
}

/** Change 生命周期阶段（兼容 OpenSpec UI Kanban 模型） */
export type ChangeStage =
  | 'planning'
  | 'ready_to_apply'
  | 'in_progress'
  | 'complete'
  | 'archived';

/** 单个 Artifact 节点状态 */
export type ArtifactNodeStatus = 'done' | 'next' | 'blocked';

export interface ArtifactStateItem {
  id: 'proposal' | 'specs' | 'design' | 'tasks';
  label: string;
  status: ArtifactNodeStatus;
  blockedBy?: string[];
}

/** 单个物理仓库下的 Change 详情 */
export interface RepoChangeEntry {
  /** 仓库 ID */
  repoId: string;
  /** 仓库展示名 */
  repoName: string;
  /** 仓库角色标签 */
  repoRole: string;
  /** 仓库来源类型 */
  sourceType: RepoSourceType;
  /** Change 名称 */
  changeName: string;
  /** 规范来源路径（本地目录或外部 Store 路径） */
  specRootPath: string;
  /** 是否已归档 */
  archived: boolean;
  /** 归档目录名（如 2026-11-25-add-sso） */
  archiveFolderName?: string;
  /** 归档日期（YYYY-MM-DD） */
  archivedDate?: string;
  /** 归档时间戳（ISO 8601，取自归档目录与核心文件最近修改时间） */
  archivedAt?: string;
  /** 生命周期阶段 */
  stage: ChangeStage;
  /** 从 proposal 提取的简短摘要 */
  summary: string;
  /** 四个规划产物的依赖完成状态 */
  artifactStates: ArtifactStateItem[];
  /** 产物存在状态 */
  artifacts: {
    hasProposal: boolean;
    hasDesign: boolean;
    hasSpecs: boolean;
    hasTasks: boolean;
  };
  /** 进度统计 */
  progress: {
    completed: number;
    total: number;
  };
  /** 各产物文本或结构 */
  proposalContent?: string;
  designContent?: string;
  tasks?: TasksDocument;
  deltaDiffs: CapabilityDeltaDiff[];
}

/** 聚合后的跨仓逻辑 Change 组 */
export interface CrossRepoChangeGroup {
  /** 逻辑键（手动链接为 link:<id>，自动同名聚合为 slug:<changeName>） */
  key: string;
  /** 展示标题 */
  title: string;
  /** 是否来自手动关联 */
  isManualLink: boolean;
  /** 手动关联 ID（若为手动关联） */
  manualLinkId?: string;
  /** 聚合状态：all_active / all_archived / mixed */
  aggregateStatus: 'all_active' | 'all_archived' | 'mixed';
  /** 联合生命周期阶段 */
  stage: ChangeStage;
  /** 联合任务进度 */
  totalProgress: {
    completed: number;
    total: number;
  };
  /** 各个关联仓库下的 Change 条目 */
  entries: RepoChangeEntry[];
}

/** 主规范树节点 */
export interface MainSpecEntry {
  /** 所属仓库 ID */
  repoId: string;
  /** 仓库名称 */
  repoName: string;
  /** 仓库角色 */
  repoRole: string;
  /** 能力路径 */
  capabilityPath: string;
  /** 规范目的摘要 */
  purpose: string;
  /** 全文内容 */
  rawContent: string;
  /** Requirement 数量 */
  requirementCount: number;
}

/** 单个仓库的 Git 状态摘要 */
export interface GitRepoStatus {
  /** 仓库 ID */
  repoId: string;
  /** 仓库名称 */
  repoName: string;
  /** 仓库角色 */
  repoRole: string;
  /** 来源类型 */
  sourceType: RepoSourceType;
  /** 是否为合法 Git 仓库 */
  isGitRepo: boolean;
  /** 当前分支名（HEAD 游离时为 detached@sha） */
  branch: string;
  /** 上游跟踪分支 */
  upstream?: string;
  /** 领先提交数 */
  ahead: number;
  /** 落后提交数 */
  behind: number;
  /** 工作区未提交文件数（remote 仓通常为 0） */
  dirtyCount: number;
  /** 脏文件列表 */
  dirtyFiles: Array<{
    path: string;
    status: string;
  }>;
  /** 可用本地及远端分支列表 */
  branches: string[];
  /** 错误信息（如非 Git 目录或 Git 命令异常） */
  error?: string;
}

/** Git 提交记录条目 */
export interface GitCommitItem {
  /** Commit SHA */
  sha: string;
  /** 短 SHA */
  shortSha: string;
  /** 所属仓库 ID */
  repoId: string;
  /** 所属仓库名称 */
  repoName: string;
  /** 仓库角色标签 */
  repoRole: string;
  /** 来源分支或当前引用 */
  branchRef: string;
  /** 提交信息首行 */
  subject: string;
  /** 提交作者 */
  author: string;
  /** 提交时间 ISO 字符串 */
  committedAt: string;
  /** 变更文件数 */
  filesChanged: number;
}

/** 单个文件的 Diff 内容 */
export interface GitFileDiff {
  /** 文件相对路径 */
  path: string;
  /** 变更类型 */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
  /** Unified diff 文本 */
  patch: string;
  /** 是否因超大而被截断 */
  truncated: boolean;
}

/** Git Diff 查询结果 */
export interface GitDiffResult {
  /** 仓库 ID */
  repoId: string;
  /** 目标标识（working-tree 或 commit SHA） */
  target: string;
  /** 文件差异列表 */
  files: GitFileDiff[];
  /** 是否因文件数过多而截断 */
  truncated: boolean;
}

/** 本地目录扫描发现候选结果 */
export interface DiscoveredRepoCandidate {
  /** 规范化绝对路径 */
  path: string;
  /** 目录名 */
  name: string;
  /** 是否存在 openspec/ */
  hasOpenSpec: boolean;
  /** 是否存在 .git/ */
  hasGit: boolean;
  /** 外部声明 Store（若有） */
  declaredStoreId?: string;
}

/** 本机目录浏览子目录条目 */
export interface DirectoryBrowseEntry {
  /** 目录名称或盘符名称 */
  name: string;
  /** 规范化绝对路径 */
  path: string;
  /** 是否包含 openspec/ */
  hasOpenSpec: boolean;
  /** 是否包含 .git/ */
  hasGit: boolean;
}

/** 本机目录浏览响应 */
export interface DirectoryBrowseResult {
  /** 当前所在目录绝对路径（位于顶层盘符列表时为 null） */
  currentPath: string | null;
  /** 上级目录路径（位于磁盘根目录时为 null，前端可退回盘符列表） */
  parentPath: string | null;
  /** 本机可用根目录/盘符与用户主目录 */
  roots: string[];
  /** 当前层级的子目录列表 */
  entries: DirectoryBrowseEntry[];
}

/** OpenSpec 全局资源发现结果（stores 与 worksets） */
export interface OpenSpecEnvironmentInfo {
  /** 本机 openspec CLI 是否可用 */
  cliAvailable: boolean;
  /** CLI 版本号 */
  cliVersion?: string;
  /** 注册的独立 Store 列表 */
  stores: Array<{
    id: string;
    path: string;
    remote?: string;
  }>;
  /** 保存的 Workset 列表 */
  worksets: Array<{
    name: string;
    members: string[];
  }>;
}

/** WebSocket 服务端推送消息类型 */
export type WsServerMessage =
  | {
      type: 'workspace:refresh';
      workspaceId: string;
      reason:
        | 'fs-change'
        | 'remote-sync'
        | 'task-update'
        | 'workspace-switched'
        | 'git-branch-switched';
      repoId?: string;
      timestamp: string;
    }
  | {
      type: 'remote:sync-status';
      workspaceId: string;
      repoId: string;
      syncState: RemoteSyncState;
      lastSyncedAt?: string;
      error?: string;
    }
  | {
      type: 'server:hello';
      activeWorkspaceId: string | null;
      csrfToken: string;
    };
