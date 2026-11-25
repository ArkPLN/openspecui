/**
 * @file Fastify 本地工作台 HTTP 与 WebSocket 服务
 * @description 绑定 127.0.0.1，提供工作区管理、OpenSpec 聚合预览、tasks.md 安全回写、只读 Git API 及增量 WS 推送。
 * @author ypc
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  AddRepoInputSchema,
  CheckoutBranchInputSchema,
  CreateChangeLinkInputSchema,
  CreateIdeaInputSchema,
  CreateRepoLinkInputSchema,
  CreateWorkspaceInputSchema,
  ScanDirectoryInputSchema,
  SetBranchPinInputSchema,
  ToggleTaskInputSchema,
  UpdateIdeaInputSchema,
  UpdateWorkspaceInputSchema,
  UpdateWorkspaceOrderInputSchema,
  type OpenSpecEnvironmentInfo,
  type RepoBinding,
  type WsServerMessage,
} from '@openspecui/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getRepoDiff,
  getRepoGitStatus,
  getWorkspaceGitTimeline,
  matchChangeToGitAcrossWorkspace,
  switchRepoBranch,
} from './git-service.js';
import {
  aggregateWorkspaceChanges,
  applyTaskLineToggle,
  inspectOpenSpecEnvironment,
  parseRepoChanges,
  parseRepoMainSpecs,
} from './openspec-parser.js';
import {
  browseLocalDirectories,
  discoverLocalRepos,
  parseOpenSpecUiConfig,
  RegistryManager,
} from './registry.js';
import { RemoteRepoManager } from './remote-repo.js';
import { isAllowedLocalRequest, SecurityError } from './security.js';
import { pickLocalFolderDialog } from './system-dialog.js';
import { LazyWatcherManager } from './watcher.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  devMode?: boolean;
  appHomeDir?: string;
  staticDir?: string;
}

export interface WorkbenchServerInstance {
  app: FastifyInstance;
  port: number;
  host: string;
  readOnlyMode: boolean;
  lanUrls: string[];
  csrfToken: string;
  registry: RegistryManager;
  remoteManager: RemoteRepoManager;
  watcher: LazyWatcherManager;
  close: () => Promise<void>;
}

/** 收集本机可用 IPv4 局域网地址，用于 --host 0.0.0.0 手机访问展示 */
function collectLanUrls(port: number): string[] {
  const urls: string[] = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.family === 'IPv4' && !addr.internal) {
        urls.push(`http://${addr.address}:${port}`);
      }
    }
  }
  return urls;
}

const ImportWorksetSchema = z.object({
  name: z.string().trim().min(1),
  members: z.array(z.string().trim().min(1)).min(1),
});

const ActivateDirSchema = z.object({
  dirPath: z.string().trim().min(1),
});

/**
 * 构建并启动本地单实例工作台 Fastify 服务。
 */
export async function createWorkbenchServer(
  options: ServerOptions = {},
): Promise<WorkbenchServerInstance> {
  const devMode = options.devMode ?? false;
  const host = options.host?.trim() || '127.0.0.1';
  const readOnlyMode = host !== '127.0.0.1' && host !== 'localhost';
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const registry = new RegistryManager(options.appHomeDir);

  const wsClients = new Set<{ readyState: number; send: (data: string) => void }>();
  const broadcast = (message: WsServerMessage) => {
    const payload = JSON.stringify(message);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  };

  const remoteManager = new RemoteRepoManager(registry, (event) => {
    broadcast({
      type: 'remote:sync-status',
      workspaceId: event.workspaceId,
      repoId: event.repoId,
      syncState: event.syncState ?? 'idle',
      lastSyncedAt: event.lastSyncedAt,
      error: event.error,
    });
    if (event.syncState === 'idle') {
      broadcast({
        type: 'workspace:refresh',
        workspaceId: event.workspaceId,
        reason: 'remote-sync',
        repoId: event.repoId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  const watcher = new LazyWatcherManager((event) => {
    broadcast({
      type: 'workspace:refresh',
      workspaceId: event.workspaceId,
      reason: 'fs-change',
      repoId: event.repoId,
      timestamp: new Date().toISOString(),
    });
  });

  // 缓存 CLI 环境探测，避免高频请求重复起子进程，启动时在后台非阻塞预热
  let cachedEnvInfo: OpenSpecEnvironmentInfo | null = null;
  let envInFlight: Promise<OpenSpecEnvironmentInfo> | null = null;
  const getEnvInfo = async (force = false): Promise<OpenSpecEnvironmentInfo> => {
    if (cachedEnvInfo && !force) {
      return cachedEnvInfo;
    }
    if (!envInFlight || force) {
      envInFlight = inspectOpenSpecEnvironment()
        .then((res) => {
          cachedEnvInfo = res;
          return res;
        })
        .finally(() => {
          envInFlight = null;
        });
    }
    return envInFlight;
  };
  void getEnvInfo();

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  let boundPort = options.port ?? 3456;

  // 统一安全守卫：校验 Host/Origin 白名单；非本机回环绑定强制开启只读保护；本机写接口强制校验 CSRF Token
  app.addHook('onRequest', async (request, reply) => {
    const urlPath = request.url.split('?')[0];
    if (!urlPath.startsWith('/api/') && urlPath !== '/ws') {
      return;
    }

    const hostHeader = request.headers.host;
    const originHeader = request.headers.origin;
    if (!isAllowedLocalRequest(hostHeader, originHeader, boundPort, devMode, readOnlyMode)) {
      return reply.code(403).send({ error: 'FORBIDDEN_ORIGIN', message: '拒绝非本地来源的跨域请求' });
    }

    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (readOnlyMode) {
      // 局域网模式（如 --host 0.0.0.0）下严禁任何写接口与宿主机目录遍历接口
      if (isMutating || urlPath === '/api/system/browse-dirs') {
        return reply.code(403).send({
          error: 'READ_ONLY_LAN_MODE',
          message: '当前处于局域网只读查看模式，写操作与本机目录控制已禁用',
        });
      }
      return;
    }

    if (isMutating) {
      const tokenHeader = request.headers['x-openspecui-token'];
      if (tokenHeader !== csrfToken) {
        return reply.code(403).send({ error: 'INVALID_CSRF_TOKEN', message: '缺少或无效的安全校验令牌' });
      }
    }
  });

  // 统一错误映射
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof SecurityError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({
      error: 'INTERNAL_ERROR',
      message: (err as Error).message || '服务器内部错误',
    });
  });

  // WebSocket 实时通道
  app.get('/ws', { websocket: true }, (socket) => {
    wsClients.add(socket);
    socket.send(
      JSON.stringify({
        type: 'server:hello',
        activeWorkspaceId: registry.getState().activeWorkspaceId,
        csrfToken,
      } satisfies WsServerMessage),
    );
    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  // 健康检查与单实例探测接口
  app.get('/api/health', async () => ({
    app: 'openspecui',
    version: '0.1.0',
    pid: process.pid,
    port: boundPort,
  }));

  // 会话初始化信息（立即返回 csrfToken 与 activeWorkspaceId，不阻塞等待外部 CLI 子进程）
  app.get('/api/session', async () => ({
    csrfToken: readOnlyMode ? '' : csrfToken,
    activeWorkspaceId: registry.getState().activeWorkspaceId,
    readOnlyMode,
    lanUrls: readOnlyMode ? collectLanUrls(boundPort) : [],
  }));

  // 独立环境探测接口（异步获取 openspec CLI / Store / Workset）
  app.get('/api/env', async (request) => {
    const force = (request.query as { refreshEnv?: string }).refreshEnv === '1';
    const env = await getEnvInfo(force);
    return { env };
  });

  // 列出所有工作区
  app.get('/api/workspaces', async () => registry.getState());

  // 创建工作区（支持同时绑定本地目录与线上 Git URL）
  app.post('/api/workspaces', async (request) => {
    const input = CreateWorkspaceInputSchema.parse(request.body);
    const localInputs = input.repos.filter((r) => r.sourceType === 'local');
    const remoteInputs = input.repos.filter((r) => r.sourceType === 'remote');

    const localBindings: RepoBinding[] = localInputs.map((item) =>
      registry.buildLocalRepoBinding(item),
    );
    const workspace = await registry.createWorkspace(input, localBindings);

    for (const remoteItem of remoteInputs) {
      await remoteManager.addRemoteRepoToWorkspace(workspace.id, remoteItem);
    }

    const active = await registry.setActiveWorkspace(workspace.id);
    await watcher.switchWorkspace(active);
    remoteManager.refreshSchedulesForWorkspace(active.id);
    return active;
  });

  // 重命名工作区
  app.patch('/api/workspaces/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = UpdateWorkspaceInputSchema.parse(request.body);
    if (!input.name) {
      const existing = registry.getWorkspace(id);
      if (!existing) {
        throw new SecurityError('工作区不存在', 404, 'WORKSPACE_NOT_FOUND');
      }
      return existing;
    }
    return registry.updateWorkspace(id, input.name);
  });

  // 删除工作区
  app.delete('/api/workspaces/:id', async (request) => {
    const { id } = request.params as { id: string };
    const cleanupCache = (request.query as { cleanupCache?: string }).cleanupCache === 'true';
    remoteManager.clearWorkspaceTimers(id);
    const removed = await registry.deleteWorkspace(id);
    if (!removed) {
      throw new SecurityError('工作区不存在', 404, 'WORKSPACE_NOT_FOUND');
    }
    if (cleanupCache) {
      const allNow = registry.getState().workspaces;
      for (const repo of removed.repos) {
        if (repo.sourceType === 'remote') {
          const stillUsed = allNow.some((w) => w.repos.some((r) => r.localPath === repo.localPath));
          if (!stillUsed) {
            remoteManager.cleanupUnusedCache(repo.localPath);
          }
        }
      }
    }
    const nextActive = registry.getActiveWorkspace();
    await watcher.switchWorkspace(nextActive);
    if (nextActive) {
      remoteManager.refreshSchedulesForWorkspace(nextActive.id);
    }
    return { ok: true, activeWorkspaceId: nextActive?.id ?? null };
  });

  // 切换激活工作区
  app.post('/api/workspaces/:id/activate', async (request) => {
    const { id } = request.params as { id: string };
    const active = await registry.setActiveWorkspace(id);
    await watcher.switchWorkspace(active);
    remoteManager.refreshSchedulesForWorkspace(active.id);
    broadcast({
      type: 'workspace:refresh',
      workspaceId: active.id,
      reason: 'workspace-switched',
      timestamp: new Date().toISOString(),
    });
    return active;
  });

  // 向工作区绑定本地或线上 Git 仓库
  app.post('/api/workspaces/:id/repos', async (request) => {
    const { id } = request.params as { id: string };
    const input = AddRepoInputSchema.parse(request.body);

    let added: RepoBinding;
    if (input.sourceType === 'remote') {
      added = await remoteManager.addRemoteRepoToWorkspace(id, input);
    } else {
      const binding = registry.buildLocalRepoBinding(input);
      await registry.addRepoToWorkspace(id, binding);
      added = binding;
    }

    if (registry.getState().activeWorkspaceId === id) {
      await watcher.switchWorkspace(registry.getActiveWorkspace());
    }
    return { repo: added, workspace: registry.getWorkspace(id) };
  });

  // 从工作区解绑仓库
  app.delete('/api/workspaces/:id/repos/:repoId', async (request) => {
    const { id, repoId } = request.params as { id: string; repoId: string };
    const cleanupCache = (request.query as { cleanupCache?: string }).cleanupCache === 'true';
    const { removed, stillReferencedElsewhere } = await registry.removeRepoFromWorkspace(id, repoId);
    if (!removed) {
      throw new SecurityError('仓库绑定不存在', 404, 'REPO_NOT_FOUND');
    }
    if (cleanupCache && removed.sourceType === 'remote' && !stillReferencedElsewhere) {
      remoteManager.cleanupUnusedCache(removed.localPath);
    }
    if (registry.getState().activeWorkspaceId === id) {
      await watcher.switchWorkspace(registry.getActiveWorkspace());
      remoteManager.refreshSchedulesForWorkspace(id);
    }
    return { ok: true, workspace: registry.getWorkspace(id) };
  });

  // 手动同步线上缓存仓库（git fetch）
  app.post('/api/workspaces/:id/repos/:repoId/sync', async (request) => {
    const { id, repoId } = request.params as { id: string; repoId: string };
    const updated = await remoteManager.syncRemoteRepo(id, repoId);
    return { repo: updated };
  });

  // 扫描本地目录发现候选仓库（默认仅返回含 openspec/ 的项目）
  app.post('/api/workspaces/discover', async (request) => {
    const input = ScanDirectoryInputSchema.parse(request.body);
    const candidates = discoverLocalRepos(input.rootPath, input.maxDepth, input.onlyOpenSpec);
    return { candidates };
  });

  // 只读浏览本机磁盘盘符与子目录结构
  app.get('/api/system/browse-dirs', async (request) => {
    const query = request.query as { path?: string };
    return browseLocalDirectories(query.path);
  });

  // 调起宿主机系统原生文件夹选择器（受 CSRF Token 保护）
  app.post('/api/system/pick-folder', async (request) => {
    const body = (request.body ?? {}) as { initialPath?: string };
    return pickLocalFolderDialog(typeof body.initialPath === 'string' ? body.initialPath : undefined);
  });

  // 从 OpenSpec Workset 导入为工作区
  app.post('/api/workspaces/import-workset', async (request) => {
    const input = ImportWorksetSchema.parse(request.body);
    const bindings: RepoBinding[] = [];
    for (const memberPath of input.members) {
      if (fs.existsSync(memberPath)) {
        bindings.push(
          registry.buildLocalRepoBinding({
            localPath: memberPath,
            role: path.basename(memberPath).toUpperCase().slice(0, 12),
            kind: 'hybrid',
            sourceType: 'local',
          }),
        );
      }
    }
    const workspace = await registry.createWorkspace({ name: input.name, repos: [] }, bindings);
    const active = await registry.setActiveWorkspace(workspace.id);
    await watcher.switchWorkspace(active);
    return active;
  });

  // 导入 openspec-ui.json 所在目录为工作区
  app.post('/api/workspaces/import-openspec-ui-json', async (request) => {
    const { dirPath } = ActivateDirSchema.parse(request.body);
    const sources = parseOpenSpecUiConfig(dirPath);
    if (sources.length === 0) {
      throw new SecurityError('目标目录下未找到有效的 openspec-ui.json 配置', 404, 'CONFIG_NOT_FOUND');
    }
    const bindings = sources.map((s) => registry.buildLocalRepoBinding(s));
    const workspace = await registry.createWorkspace(
      { name: path.basename(dirPath), repos: [] },
      bindings,
    );
    const active = await registry.setActiveWorkspace(workspace.id);
    await watcher.switchWorkspace(active);
    return active;
  });

  // 工作区 Ideas 增删改
  app.post('/api/workspaces/:id/ideas', async (request) => {
    const { id } = request.params as { id: string };
    const input = CreateIdeaInputSchema.parse(request.body);
    return registry.addIdea(id, input);
  });

  app.patch('/api/workspaces/:id/ideas/:ideaId', async (request) => {
    const { id, ideaId } = request.params as { id: string; ideaId: string };
    const input = UpdateIdeaInputSchema.parse(request.body);
    return registry.updateIdea(id, ideaId, input);
  });

  app.delete('/api/workspaces/:id/ideas/:ideaId', async (request) => {
    const { id, ideaId } = request.params as { id: string; ideaId: string };
    const ok = await registry.deleteIdea(id, ideaId);
    if (!ok) {
      throw new SecurityError('Idea 不存在', 404, 'IDEA_NOT_FOUND');
    }
    return { ok: true };
  });

  // 持久化工作区仓库、Change 与 Ideas 的自定义拖拽排序
  app.put('/api/workspaces/:id/order', async (request) => {
    const { id } = request.params as { id: string };
    const input = UpdateWorkspaceOrderInputSchema.parse(request.body);
    return registry.updateWorkspaceOrder(id, input);
  });

  // 创建/删除跨仓项目（仓库）关联组
  app.post('/api/workspaces/:id/repo-links', async (request) => {
    const { id } = request.params as { id: string };
    const input = CreateRepoLinkInputSchema.parse(request.body);
    return registry.addRepoLink(id, input);
  });

  app.delete('/api/workspaces/:id/repo-links/:linkId', async (request) => {
    const { id, linkId } = request.params as { id: string; linkId: string };
    const removed = await registry.removeRepoLink(id, linkId);
    if (!removed) {
      throw new SecurityError('项目关联组不存在', 404, 'REPO_LINK_NOT_FOUND');
    }
    return { ok: true };
  });

  // 创建/删除跨仓 Change 手动关联组
  app.post('/api/workspaces/:id/change-links', async (request) => {
    const { id } = request.params as { id: string };
    const input = CreateChangeLinkInputSchema.parse(request.body);
    return registry.addChangeLink(id, input);
  });

  app.delete('/api/workspaces/:id/change-links/:linkId', async (request) => {
    const { id, linkId } = request.params as { id: string; linkId: string };
    const removed = await registry.removeChangeLink(id, linkId);
    if (!removed) {
      throw new SecurityError('关联组不存在', 404, 'LINK_NOT_FOUND');
    }
    return { ok: true };
  });

  // 手动绑定 Change 与仓库分支/Commit
  app.put('/api/workspaces/:id/branch-pins', async (request) => {
    const { id } = request.params as { id: string };
    const input = SetBranchPinInputSchema.parse(request.body);
    return registry.setBranchPin(id, input);
  });

  // 获取工作区聚合全景视图（Changes、Main Specs、Git 各仓状态）
  app.get('/api/workspaces/:id/overview', async (request) => {
    const { id } = request.params as { id: string };
    const workspace = registry.getWorkspace(id);
    if (!workspace) {
      throw new SecurityError('工作区不存在', 404, 'WORKSPACE_NOT_FOUND');
    }
    // 仅当存在声明外部 store 的仓库且尚未预热完成时才等待 env，否则立即使用缓存
    const needsStoreResolve = workspace.repos.some((r) => Boolean(r.declaredStoreId));
    const env: OpenSpecEnvironmentInfo = needsStoreResolve
      ? await getEnvInfo()
      : cachedEnvInfo ?? { cliAvailable: false, stores: [], worksets: [] };

    const [repoEntriesNested, mainSpecsNested, gitStatuses] = await Promise.all([
      Promise.all(workspace.repos.map((repo) => parseRepoChanges(repo, env))),
      Promise.all(workspace.repos.map((repo) => parseRepoMainSpecs(repo, env))),
      Promise.all(workspace.repos.map((repo) => getRepoGitStatus(repo))),
    ]);

    const changeGroups = aggregateWorkspaceChanges(workspace, repoEntriesNested.flat());
    const mainSpecs = mainSpecsNested.flat();

    return {
      workspace,
      changeGroups,
      mainSpecs,
      gitStatuses,
      env,
    };
  });

  // 乐观锁勾选回写 tasks.md（严格拒绝 remote 仓库）
  app.patch('/api/workspaces/:id/tasks', async (request) => {
    const { id } = request.params as { id: string };
    const input = ToggleTaskInputSchema.parse(request.body);
    const workspace = registry.getWorkspace(id);
    if (!workspace) {
      throw new SecurityError('工作区不存在', 404, 'WORKSPACE_NOT_FOUND');
    }
    const repo = workspace.repos.find((r) => r.id === input.repoId);
    if (!repo) {
      throw new SecurityError('仓库不属于当前工作区', 404, 'REPO_NOT_FOUND');
    }
    const updatedTasks = applyTaskLineToggle(repo, input);
    broadcast({
      type: 'workspace:refresh',
      workspaceId: id,
      reason: 'task-update',
      repoId: repo.id,
      timestamp: new Date().toISOString(),
    });
    return updatedTasks;
  });

  // 工作区跨仓混合 Git 活动时间线
  app.get('/api/workspaces/:id/git/timeline', async (request) => {
    const { id } = request.params as { id: string };
    const workspace = registry.getWorkspace(id);
    if (!workspace) {
      throw new SecurityError('工作区不存在', 404, 'WORKSPACE_NOT_FOUND');
    }
    const commits = await getWorkspaceGitTimeline(workspace);
    return { commits };
  });

  // 为选中的逻辑 Change 匹配工作区内相关仓库的分支与 Commit
  app.get('/api/workspaces/:id/git/match', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { changeKey?: string; names?: string; ownerRepoIds?: string };
    const workspace = registry.getWorkspace(id);
    if (!workspace) {
      throw new SecurityError('工作区不存在', 404, 'WORKSPACE_NOT_FOUND');
    }
    const changeKey = query.changeKey ?? '';
    const candidateNames = (query.names ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ownerRepoIds = (query.ownerRepoIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const matches = await matchChangeToGitAcrossWorkspace(
      workspace,
      changeKey,
      candidateNames,
      ownerRepoIds,
    );
    return { matches };
  });

  // 只读代码 Diff 查看（工作区未提交变动或指定 Commit SHA）
  app.get('/api/repos/:repoId/git/diff', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const query = request.query as { target?: string };
    const found = registry.findRepoById(repoId);
    if (!found) {
      throw new SecurityError('仓库不存在', 404, 'REPO_NOT_FOUND');
    }
    const target = query.target?.trim() || 'working-tree';
    return getRepoDiff(found.repo, target);
  });

  // 安全切换仓库当前工作区分支（受 CSRF 与 readOnlyMode 保护，禁止 -f 丢弃未提交改动）
  app.post('/api/repos/:repoId/git/checkout', async (request) => {
    const { repoId } = request.params as { repoId: string };
    const input = CheckoutBranchInputSchema.parse(request.body);
    const found = registry.findRepoById(repoId);
    if (!found) {
      throw new SecurityError('仓库不存在', 404, 'REPO_NOT_FOUND');
    }
    const status = await switchRepoBranch(found.repo, input.branch);
    broadcast({
      type: 'workspace:refresh',
      workspaceId: found.workspace.id,
      reason: 'git-branch-switched',
      timestamp: new Date().toISOString(),
    });
    return { status };
  });

  // CLI 单实例复用激活目录接口
  app.post('/api/cli/activate-dir', async (request) => {
    const input = ActivateDirSchema.parse(request.body);
    const active = await registry.ensureDirectoryActivated(input.dirPath);
    if (active) {
      await watcher.switchWorkspace(active);
      remoteManager.refreshSchedulesForWorkspace(active.id);
      broadcast({
        type: 'workspace:refresh',
        workspaceId: active.id,
        reason: 'workspace-switched',
        timestamp: new Date().toISOString(),
      });
    }
    return active ?? { ok: true, skippedNonProjectDir: true };
  });

  // 生产模式托管 packages/web 构建产物
  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  const resolvedStaticDir =
    options.staticDir ??
    [
      path.resolve(currentFileDir, 'public'),
      path.resolve(currentFileDir, '../../web/dist'),
    ].find((dir) => fs.existsSync(path.join(dir, 'index.html')));

  if (resolvedStaticDir && fs.existsSync(resolvedStaticDir)) {
    await app.register(fastifyStatic, {
      root: resolvedStaticDir,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/ws') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'API 路由不存在' });
      }
      return reply.sendFile('index.html');
    });
  }

  // 启动时为默认激活工作区开启监听与远程定时同步
  const initialActive = registry.getActiveWorkspace();
  if (initialActive) {
    await watcher.switchWorkspace(initialActive);
    remoteManager.refreshSchedulesForWorkspace(initialActive.id);
  }

  const address = await app.listen({ port: options.port ?? 3456, host });
  const parsedAddr = app.server.address();
  if (parsedAddr && typeof parsedAddr === 'object') {
    boundPort = parsedAddr.port;
  } else {
    const urlPort = Number(new URL(address).port);
    if (!Number.isNaN(urlPort) && urlPort > 0) {
      boundPort = urlPort;
    }
  }

  return {
    app,
    port: boundPort,
    host,
    readOnlyMode,
    lanUrls: readOnlyMode ? collectLanUrls(boundPort) : [],
    csrfToken,
    registry,
    remoteManager,
    watcher,
    close: async () => {
      remoteManager.dispose();
      await watcher.closeAll();
      await app.close();
    },
  };
}
