/**
 * @file 工作区注册表与本地持久化管理器
 * @description 将多工作区、物理仓库绑定（含多 worktree 路径区分）、跨仓 Change 映射及分支 Pin 原子持久化至 ~/.openspecui/workspaces.json。
 * @author ypc
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AddRepoInput,
  ChangeBranchPin,
  CreateChangeLinkInput,
  CreateIdeaInput,
  CreateRepoLinkInput,
  CreateWorkspaceInput,
  CrossRepoChangeLink,
  CrossRepoProjectLink,
  DirectoryBrowseEntry,
  DirectoryBrowseResult,
  DiscoveredRepoCandidate,
  RegistryStoreData,
  RepoBinding,
  UpdateIdeaInput,
  UpdateWorkspaceOrderInput,
  Workspace,
  WorkspaceIdea,
} from '@openspecui/shared';
import yaml from 'yaml';
import { SecurityError } from './security.js';

/** 默认应用数据根目录（支持通过 OPENSPECUI_HOME 环境变量覆盖） */
export function getDefaultAppHomeDir(): string {
  return process.env.OPENSPECUI_HOME?.trim() || path.join(os.homedir(), '.openspecui');
}

/** 规范化绝对路径，统一处理软链接与大小写（用于去重主键比较） */
export function canonicalizeDirectoryPath(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    throw new SecurityError(`目录不存在: ${dirPath}`, 400, 'DIR_NOT_FOUND');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new SecurityError(`路径不是目录: ${dirPath}`, 400, 'NOT_A_DIRECTORY');
  }
  return fs.realpathSync(resolved);
}

/** 比较两个本地路径是否指向同一目录 */
export function isSameCanonicalPath(pathA: string, pathB: string): boolean {
  const normA = process.platform === 'win32' ? path.resolve(pathA).toLowerCase() : path.resolve(pathA);
  const normB = process.platform === 'win32' ? path.resolve(pathB).toLowerCase() : path.resolve(pathB);
  return normA === normB;
}

/**
 * 判断目录是否为可自动注册的合法 OpenSpec / Git 项目目录。
 * 显式排除用户主目录与磁盘根目录，防止误在 ~ 下启动时全盘挂载。
 */
export function isValidProjectDirectory(dirPath: string): boolean {
  try {
    const canonical = canonicalizeDirectoryPath(dirPath);
    const homeCanonical = fs.existsSync(os.homedir()) ? fs.realpathSync(os.homedir()) : os.homedir();
    if (isSameCanonicalPath(canonical, homeCanonical)) {
      return false;
    }
    if (path.parse(canonical).root === canonical) {
      return false;
    }
    return (
      fs.existsSync(path.join(canonical, 'openspec')) ||
      fs.existsSync(path.join(canonical, '.git'))
    );
  } catch {
    return false;
  }
}

/** 读取仓库 openspec/config.yaml 中声明的外部 store id（若存在） */
export function readDeclaredStoreId(repoPath: string): string | undefined {
  const candidates = [
    path.join(repoPath, 'openspec', 'config.yaml'),
    path.join(repoPath, 'openspec', 'config.yml'),
  ];
  for (const configPath of candidates) {
    if (!fs.existsSync(configPath)) {
      continue;
    }
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.parse(content);
      if (parsed && typeof parsed === 'object' && typeof parsed.store === 'string' && parsed.store.trim()) {
        return parsed.store.trim();
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 解析目录下的 openspec-ui.json 配置文件（兼容 ToruAI/openspec-ui 配置格式）。
 * 支持 `{ sources: [{ name?, path }] }`。
 */
export function parseOpenSpecUiConfig(dirPath: string): AddRepoInput[] {
  const configPath = path.join(dirPath, 'openspec-ui.json');
  if (!fs.existsSync(configPath)) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      sources?: Array<{ name?: string; path?: string }>;
    };
    if (!raw || !Array.isArray(raw.sources)) {
      return [];
    }
    const items: AddRepoInput[] = [];
    for (const src of raw.sources) {
      if (!src || typeof src.path !== 'string' || !src.path.trim()) {
        continue;
      }
      const resolved = path.resolve(dirPath, src.path.trim());
      if (!fs.existsSync(resolved)) {
        continue;
      }
      const name = src.name?.trim() || path.basename(resolved);
      items.push({
        sourceType: 'local',
        localPath: resolved,
        name,
        role: name.toUpperCase().slice(0, 12),
        kind: 'hybrid',
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * 扫描父级目录下包含 openspec/（或可选包含纯 .git）的子目录（只读操作）。
 *
 * @param rootPath 待扫描的根目录
 * @param maxDepth 最大递归深度（1-4）
 * @param onlyOpenSpec 默认 true，仅返回包含 openspec/ 的项目
 */
export function discoverLocalRepos(
  rootPath: string,
  maxDepth = 2,
  onlyOpenSpec = true,
): DiscoveredRepoCandidate[] {
  const canonicalRoot = canonicalizeDirectoryPath(rootPath);
  const results: DiscoveredRepoCandidate[] = [];
  const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target']);

  const shouldInclude = (hasOpenSpec: boolean, hasGit: boolean) =>
    onlyOpenSpec ? hasOpenSpec : hasOpenSpec || hasGit;

  function walk(currentDir: string, depth: number): void {
    const hasOpenSpec = fs.existsSync(path.join(currentDir, 'openspec'));
    const hasGit = fs.existsSync(path.join(currentDir, '.git'));

    if ((hasOpenSpec || hasGit) && depth > 0) {
      if (shouldInclude(hasOpenSpec, hasGit)) {
        results.push({
          path: currentDir,
          name: path.basename(currentDir),
          hasOpenSpec,
          hasGit,
          declaredStoreId: hasOpenSpec ? readDeclaredStoreId(currentDir) : undefined,
        });
      }
      // 已识别为仓库根目录后不再继续往业务子目录深入
      return;
    }

    if (depth >= maxDepth) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (ignoredDirs.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      walk(path.join(currentDir, entry.name), depth + 1);
    }
  }

  // 若根目录本身就是一个仓库，也按过滤规则检查
  const rootHasOpenSpec = fs.existsSync(path.join(canonicalRoot, 'openspec'));
  const rootHasGit = fs.existsSync(path.join(canonicalRoot, '.git'));
  if (shouldInclude(rootHasOpenSpec, rootHasGit)) {
    results.push({
      path: canonicalRoot,
      name: path.basename(canonicalRoot),
      hasOpenSpec: rootHasOpenSpec,
      hasGit: rootHasGit,
      declaredStoreId: rootHasOpenSpec ? readDeclaredStoreId(canonicalRoot) : undefined,
    });
  }
  walk(canonicalRoot, 0);

  return results;
}

/** 枚举本机可用磁盘根目录与用户主目录 */
export function listLocalDriveRoots(): string[] {
  if (process.platform === 'win32') {
    const drives: string[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        if (fs.existsSync(drive)) {
          drives.push(drive);
        }
      } catch {
        // 忽略未就绪光驱或权限错误
      }
    }
    return drives;
  }
  return ['/'];
}

/**
 * 只读浏览本机指定目录下的直接子目录（仅返回目录结构及 OpenSpec/Git 标记，不读取任何文件内容）。
 *
 * @param targetPath 目标路径；传入 '__ROOTS__' 时返回盘符列表，未传时默认用户主目录
 */
export function browseLocalDirectories(targetPath?: string): DirectoryBrowseResult {
  const roots = listLocalDriveRoots();

  if (targetPath === '__ROOTS__') {
    const entries: DirectoryBrowseEntry[] = roots.map((rootDir) => ({
      name: rootDir,
      path: rootDir,
      hasOpenSpec: fs.existsSync(path.join(rootDir, 'openspec')),
      hasGit: fs.existsSync(path.join(rootDir, '.git')),
    }));
    return {
      currentPath: null,
      parentPath: null,
      roots,
      entries,
    };
  }

  const resolvedTarget = targetPath?.trim() || os.homedir();
  const canonical = canonicalizeDirectoryPath(resolvedTarget);
  const dirname = path.dirname(canonical);
  const parentPath = dirname === canonical ? '__ROOTS__' : dirname;

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(canonical, { withFileTypes: true });
  } catch {
    throw new SecurityError(`无权限读取目录: ${canonical}`, 403, 'DIR_ACCESS_DENIED');
  }

  const entries: DirectoryBrowseEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.')) {
      continue;
    }
    if (d.name === '$Recycle.Bin' || d.name === 'System Volume Information') {
      continue;
    }
    const fullPath = path.join(canonical, d.name);
    entries.push({
      name: d.name,
      path: fullPath,
      hasOpenSpec: fs.existsSync(path.join(fullPath, 'openspec')),
      hasGit: fs.existsSync(path.join(fullPath, '.git')),
    });
  }

  // OpenSpec 项目优先排序，其次按名称排序
  entries.sort((a, b) => {
    if (a.hasOpenSpec !== b.hasOpenSpec) {
      return a.hasOpenSpec ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    currentPath: canonical,
    parentPath,
    roots,
    entries,
  };
}

/**
 * 本地工作区注册表管理器。
 * 所有写操作通过内存串行队列 + 临时文件原子 rename 落盘，防止并发写破坏 JSON。
 */
export class RegistryManager {
  public readonly appHomeDir: string;
  public readonly storeFilePath: string;
  public readonly remoteCacheRootDir: string;
  private data: RegistryStoreData;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(appHomeDir = getDefaultAppHomeDir()) {
    this.appHomeDir = appHomeDir;
    this.storeFilePath = path.join(appHomeDir, 'workspaces.json');
    this.remoteCacheRootDir = path.join(appHomeDir, 'repos');
    fs.mkdirSync(this.appHomeDir, { recursive: true });
    fs.mkdirSync(this.remoteCacheRootDir, { recursive: true });
    this.data = this.loadFromDisk();
  }

  /** 从磁盘读取注册表，不存在或损坏时初始化默认空结构 */
  private loadFromDisk(): RegistryStoreData {
    if (!fs.existsSync(this.storeFilePath)) {
      return {
        version: 1,
        activeWorkspaceId: null,
        workspaces: [],
      };
    }
    try {
      const raw = fs.readFileSync(this.storeFilePath, 'utf8');
      const parsed = JSON.parse(raw) as RegistryStoreData;
      if (!parsed || !Array.isArray(parsed.workspaces)) {
        throw new Error('Invalid registry schema');
      }
      for (const ws of parsed.workspaces) {
        if (!Array.isArray(ws.ideas)) {
          ws.ideas = [];
        }
        if (!Array.isArray(ws.repoLinks)) {
          ws.repoLinks = [];
        }
        if (!Array.isArray(ws.changeLinks)) {
          ws.changeLinks = [];
        }
        if (!Array.isArray(ws.branchPins)) {
          ws.branchPins = [];
        }
        if (!ws.customOrder) {
          ws.customOrder = { changeOrder: [], ideaOrder: [] };
        }
      }
      return parsed;
    } catch {
      // 保留损坏文件备份以防数据丢失
      const backupPath = `${this.storeFilePath}.corrupt.${Date.now()}`;
      fs.copyFileSync(this.storeFilePath, backupPath);
      return {
        version: 1,
        activeWorkspaceId: null,
        workspaces: [],
      };
    }
  }

  /** 串行原子落盘：先写 .tmp 再 rename 替换目标文件 */
  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const tmpPath = `${this.storeFilePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmpPath, snapshot, 'utf8');
      await fs.promises.rename(tmpPath, this.storeFilePath);
    });
    return this.writeQueue;
  }

  /** 获取完整注册表状态副本 */
  public getState(): RegistryStoreData {
    return structuredClone(this.data);
  }

  /** 获取指定工作区 */
  public getWorkspace(workspaceId: string): Workspace | undefined {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    return ws ? structuredClone(ws) : undefined;
  }

  /** 获取当前激活的工作区 */
  public getActiveWorkspace(): Workspace | undefined {
    if (!this.data.activeWorkspaceId) {
      return undefined;
    }
    return this.getWorkspace(this.data.activeWorkspaceId);
  }

  /** 切换当前激活的工作区 */
  public async setActiveWorkspace(workspaceId: string): Promise<Workspace> {
    const target = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!target) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    this.data.activeWorkspaceId = workspaceId;
    target.lastOpenedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(target);
  }

  /** 创建新工作区 */
  public async createWorkspace(
    input: CreateWorkspaceInput,
    resolvedRepos: RepoBinding[] = [],
  ): Promise<Workspace> {
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      repos: resolvedRepos,
      repoLinks: [],
      changeLinks: [],
      branchPins: [],
      ideas: [],
      customOrder: { changeOrder: [], ideaOrder: [] },
      createdAt: now,
      lastOpenedAt: now,
    };
    this.data.workspaces.push(workspace);
    if (!this.data.activeWorkspaceId) {
      this.data.activeWorkspaceId = workspace.id;
    }
    await this.persist();
    return structuredClone(workspace);
  }

  /** 更新工作区名称 */
  public async updateWorkspace(workspaceId: string, name: string): Promise<Workspace> {
    const target = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!target) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    target.name = name.trim();
    await this.persist();
    return structuredClone(target);
  }

  /** 删除工作区 */
  public async deleteWorkspace(workspaceId: string): Promise<Workspace | undefined> {
    const idx = this.data.workspaces.findIndex((w) => w.id === workspaceId);
    if (idx === -1) {
      return undefined;
    }
    const [removed] = this.data.workspaces.splice(idx, 1);
    if (this.data.activeWorkspaceId === workspaceId) {
      this.data.activeWorkspaceId = this.data.workspaces[0]?.id ?? null;
    }
    await this.persist();
    return removed;
  }

  /** 将本地仓库目录构建为 RepoBinding（按规范化路径区分多 worktree） */
  public buildLocalRepoBinding(input: AddRepoInput): RepoBinding {
    if (!input.localPath) {
      throw new SecurityError('缺少本地仓库路径', 400, 'MISSING_PATH');
    }
    const canonicalPath = canonicalizeDirectoryPath(input.localPath);
    return {
      id: crypto.randomUUID(),
      name: input.name?.trim() || path.basename(canonicalPath),
      role: input.role || 'CODE',
      kind: input.kind ?? 'hybrid',
      sourceType: 'local',
      localPath: canonicalPath,
      declaredStoreId: readDeclaredStoreId(canonicalPath),
    };
  }

  /** 向工作区追加仓库绑定（若同一工作区内存在相同规范化路径则拒绝重复） */
  public async addRepoToWorkspace(workspaceId: string, repo: RepoBinding): Promise<Workspace> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    const exists = ws.repos.some((r) => isSameCanonicalPath(r.localPath, repo.localPath));
    if (exists) {
      throw new SecurityError(`该仓库路径已在工作区中绑定: ${repo.localPath}`, 409, 'DUPLICATE_REPO');
    }
    ws.repos.push(repo);
    await this.persist();
    return structuredClone(ws);
  }

  /** 更新工作区中的指定仓库状态（如同步时间、错误信息等） */
  public async updateRepoInWorkspace(
    workspaceId: string,
    repoId: string,
    patch: Partial<RepoBinding>,
  ): Promise<RepoBinding | undefined> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      return undefined;
    }
    const repo = ws.repos.find((r) => r.id === repoId);
    if (!repo) {
      return undefined;
    }
    Object.assign(repo, patch);
    await this.persist();
    return structuredClone(repo);
  }

  /** 从工作区解绑仓库，并返回被移除的 RepoBinding 及是否仍有其他工作区引用同一缓存路径 */
  public async removeRepoFromWorkspace(
    workspaceId: string,
    repoId: string,
  ): Promise<{ removed?: RepoBinding; stillReferencedElsewhere: boolean }> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    const idx = ws.repos.findIndex((r) => r.id === repoId);
    if (idx === -1) {
      return { stillReferencedElsewhere: false };
    }
    const [removed] = ws.repos.splice(idx, 1);
    // 清理该仓库相关的跨仓项目组、Change 映射成员与分支 Pin
    ws.repoLinks = (ws.repoLinks ?? [])
      .map((link) => ({
        ...link,
        repoIds: link.repoIds.filter((id) => id !== repoId),
      }))
      .filter((link) => link.repoIds.length >= 2);
    ws.changeLinks = ws.changeLinks
      .map((link) => ({
        ...link,
        members: link.members.filter((m) => m.repoId !== repoId),
      }))
      .filter((link) => link.members.length >= 2);
    ws.branchPins = ws.branchPins.filter((pin) => pin.repoId !== repoId);

    const stillReferencedElsewhere = this.data.workspaces.some((other) =>
      other.repos.some((r) => isSameCanonicalPath(r.localPath, removed.localPath)),
    );

    await this.persist();
    return { removed, stillReferencedElsewhere };
  }

  /** 在所有工作区中查找已存在相同远程 URL 的缓存仓库路径，用于去重复用 */
  public findExistingRemoteRepoByUrl(normalizedUrl: string): RepoBinding | undefined {
    for (const ws of this.data.workspaces) {
      const found = ws.repos.find(
        (r) => r.sourceType === 'remote' && r.remoteUrl === normalizedUrl && fs.existsSync(r.localPath),
      );
      if (found) {
        return structuredClone(found);
      }
    }
    return undefined;
  }

  /** 根据 repoId 在全局所有工作区中定位所属工作区与仓库 */
  public findRepoById(repoId: string): { workspace: Workspace; repo: RepoBinding } | undefined {
    for (const ws of this.data.workspaces) {
      const repo = ws.repos.find((r) => r.id === repoId);
      if (repo) {
        return { workspace: structuredClone(ws), repo: structuredClone(repo) };
      }
    }
    return undefined;
  }

  /** 新增跨仓项目（仓库）关联组 */
  public async addRepoLink(workspaceId: string, input: CreateRepoLinkInput): Promise<CrossRepoProjectLink> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    const validRepoIds = new Set(ws.repos.map((r) => r.id));
    const uniqueRepoIds = Array.from(new Set(input.repoIds)).filter((id) => validRepoIds.has(id));
    if (uniqueRepoIds.length < 2) {
      throw new SecurityError('至少需要选择 2 个属于当前工作区的仓库', 400, 'INVALID_REPO_LINK');
    }
    const link: CrossRepoProjectLink = {
      id: crypto.randomUUID(),
      title: input.title.trim(),
      repoIds: uniqueRepoIds,
      createdAt: new Date().toISOString(),
    };
    if (!Array.isArray(ws.repoLinks)) {
      ws.repoLinks = [];
    }
    ws.repoLinks.push(link);
    await this.persist();
    return structuredClone(link);
  }

  /** 删除跨仓项目（仓库）关联组 */
  public async removeRepoLink(workspaceId: string, linkId: string): Promise<boolean> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws || !Array.isArray(ws.repoLinks)) {
      return false;
    }
    const before = ws.repoLinks.length;
    ws.repoLinks = ws.repoLinks.filter((l) => l.id !== linkId);
    if (ws.repoLinks.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  /** 新增或更新跨仓 Change 手动关联组 */
  public async addChangeLink(workspaceId: string, input: CreateChangeLinkInput): Promise<CrossRepoChangeLink> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    const link: CrossRepoChangeLink = {
      id: crypto.randomUUID(),
      title: input.title.trim(),
      members: input.members,
    };
    ws.changeLinks.push(link);
    await this.persist();
    return structuredClone(link);
  }

  /** 删除跨仓 Change 手动关联组 */
  public async removeChangeLink(workspaceId: string, linkId: string): Promise<boolean> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      return false;
    }
    const before = ws.changeLinks.length;
    ws.changeLinks = ws.changeLinks.filter((l) => l.id !== linkId);
    if (ws.changeLinks.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  /** 设置或清除 Change-Branch/Commit 手动 Pin */
  public async setBranchPin(workspaceId: string, pin: ChangeBranchPin): Promise<ChangeBranchPin> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    ws.branchPins = ws.branchPins.filter(
      (p) => !(p.changeKey === pin.changeKey && p.repoId === pin.repoId),
    );
    if (pin.branch || pin.commitSha) {
      ws.branchPins.push(pin);
    }
    await this.persist();
    return structuredClone(pin);
  }

  /** 新增工作区轻量 Idea */
  public async addIdea(workspaceId: string, input: CreateIdeaInput): Promise<WorkspaceIdea> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    const now = new Date().toISOString();
    const idea: WorkspaceIdea = {
      id: crypto.randomUUID(),
      repoId: input.repoId,
      title: input.title.trim(),
      description: input.description.trim(),
      createdAt: now,
      updatedAt: now,
    };
    ws.ideas.unshift(idea);
    await this.persist();
    return structuredClone(idea);
  }

  /** 更新工作区轻量 Idea */
  public async updateIdea(
    workspaceId: string,
    ideaId: string,
    input: UpdateIdeaInput,
  ): Promise<WorkspaceIdea> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }
    const idea = ws.ideas.find((i) => i.id === ideaId);
    if (!idea) {
      throw new SecurityError(`Idea 不存在: ${ideaId}`, 404, 'IDEA_NOT_FOUND');
    }
    if (input.title !== undefined) idea.title = input.title.trim();
    if (input.description !== undefined) idea.description = input.description.trim();
    if (input.repoId !== undefined) idea.repoId = input.repoId ?? undefined;
    idea.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(idea);
  }

  /** 删除工作区轻量 Idea */
  public async deleteIdea(workspaceId: string, ideaId: string): Promise<boolean> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      return false;
    }
    const before = ws.ideas.length;
    ws.ideas = ws.ideas.filter((i) => i.id !== ideaId);
    if (ws.ideas.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  /** 更新工作区仓库、Change 与 Ideas 的自定义拖拽排序并持久化 */
  public async updateWorkspaceOrder(
    workspaceId: string,
    input: UpdateWorkspaceOrderInput,
  ): Promise<Workspace> {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) {
      throw new SecurityError(`工作区不存在: ${workspaceId}`, 404, 'WORKSPACE_NOT_FOUND');
    }

    if (input.repoIds && input.repoIds.length > 0) {
      const rank = new Map(input.repoIds.map((id, idx) => [id, idx]));
      ws.repos.sort((a, b) => {
        const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb;
      });
    }

    ws.customOrder = ws.customOrder ?? { changeOrder: [], ideaOrder: [] };
    if (input.changeOrder !== undefined) {
      ws.customOrder.changeOrder = input.changeOrder;
    }
    if (input.ideaOrder !== undefined) {
      ws.customOrder.ideaOrder = input.ideaOrder;
      const rank = new Map(input.ideaOrder.map((id, idx) => [id, idx]));
      ws.ideas.sort((a, b) => {
        const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb;
      });
    }

    await this.persist();
    return structuredClone(ws);
  }

  /**
   * 当通过 CLI 在某个目录启动时：
   * 1. 若匹配已有工作区仓库则直接激活；
   * 2. 若含 openspec-ui.json 则导入为工作区；
   * 3. 若本身是合法 OpenSpec/Git 项目则创建单仓工作区；
   * 4. 若是非用户主目录/根目录的父文件夹且子目录含 OpenSpec 项目，则批量导入为工作区。
   */
  public async ensureDirectoryActivated(dirPath: string): Promise<Workspace | undefined> {
    let canonical: string;
    try {
      canonical = canonicalizeDirectoryPath(dirPath);
    } catch {
      return this.getActiveWorkspace();
    }

    const existing = this.data.workspaces.find((ws) =>
      ws.repos.some((r) => isSameCanonicalPath(r.localPath, canonical)),
    );
    if (existing) {
      return this.setActiveWorkspace(existing.id);
    }

    const configSources = parseOpenSpecUiConfig(canonical);
    if (configSources.length > 0) {
      const bindings = configSources.map((s) => this.buildLocalRepoBinding(s));
      const created = await this.createWorkspace(
        { name: path.basename(canonical), repos: [] },
        bindings,
      );
      return this.setActiveWorkspace(created.id);
    }

    if (isValidProjectDirectory(canonical)) {
      const repo = this.buildLocalRepoBinding({
        localPath: canonical,
        role: 'MAIN',
        kind: 'hybrid',
        sourceType: 'local',
      });
      const created = await this.createWorkspace(
        { name: path.basename(canonical), repos: [] },
        [repo],
      );
      return this.setActiveWorkspace(created.id);
    }

    // 检查是否为用户显式传入的多项目父级目录（排除用户主目录与盘符根）
    const homeCanonical = fs.existsSync(os.homedir()) ? fs.realpathSync(os.homedir()) : os.homedir();
    if (!isSameCanonicalPath(canonical, homeCanonical) && path.parse(canonical).root !== canonical) {
      const childOpenSpecs = discoverLocalRepos(canonical, 2, true);
      if (childOpenSpecs.length > 0) {
        const bindings = childOpenSpecs.map((c) =>
          this.buildLocalRepoBinding({
            localPath: c.path,
            name: c.name,
            role: c.name.toUpperCase().slice(0, 12),
            kind: 'hybrid',
            sourceType: 'local',
          }),
        );
        const created = await this.createWorkspace(
          { name: path.basename(canonical), repos: [] },
          bindings,
        );
        return this.setActiveWorkspace(created.id);
      }
    }

    return this.getActiveWorkspace();
  }
}
