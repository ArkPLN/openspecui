/**
 * @file 远程 Git 仓库受控缓存与同步管理器
 * @description 将线上 Git URL 克隆至 ~/.openspecui/repos/<hash> 只读缓存目录，支持手动与定时 fetch 同步及安全清理。
 * @author ypc
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddRepoInput, RepoBinding } from '@openspecui/shared';
import { readDeclaredStoreId, RegistryManager } from './registry.js';
import {
  execSafeCommand,
  isStrictlyInsideDirectory,
  SecurityError,
  validateRemoteGitUrl,
} from './security.js';

/** 远程缓存同步事件回调 */
export type RemoteSyncNotifier = (event: {
  workspaceId: string;
  repoId: string;
  syncState: RepoBinding['syncState'];
  lastSyncedAt?: string;
  error?: string;
}) => void;

/**
 * 远程 Git 仓库受控缓存管理器。
 * 所有远程地址均强制经过白名单协议校验并禁用危险传输协议（file/ext）。
 */
export class RemoteRepoManager {
  private readonly registry: RegistryManager;
  private readonly notifier?: RemoteSyncNotifier;
  private readonly inFlightOps = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(registry: RegistryManager, notifier?: RemoteSyncNotifier) {
    this.registry = registry;
    this.notifier = notifier;
  }

  /** 根据规范化 URL 计算稳定缓存目录名，避免特殊字符路径问题 */
  public getCacheDirForUrl(normalizedUrl: string): string {
    const hash = crypto.createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 16);
    const slug = path
      .basename(normalizedUrl.replace(/\.git$/i, ''))
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 32) || 'repo';
    return path.join(this.registry.remoteCacheRootDir, `${slug}-${hash}`);
  }

  /**
   * 注册并触发克隆一个线上 Git 仓库。
   * 若全局已缓存相同 URL，则直接复用本地缓存目录而不重复克隆。
   */
  public async addRemoteRepoToWorkspace(workspaceId: string, input: AddRepoInput): Promise<RepoBinding> {
    const normalizedUrl = validateRemoteGitUrl(input.remoteUrl ?? '');
    const existingCached = this.registry.findExistingRemoteRepoByUrl(normalizedUrl);
    const cacheDir = existingCached?.localPath ?? this.getCacheDirForUrl(normalizedUrl);
    const inferredName =
      input.name?.trim() ||
      path.basename(normalizedUrl.replace(/\.git$/i, '')) ||
      'remote-repo';

    const alreadyCloned = fs.existsSync(path.join(cacheDir, '.git'));
    const repoBinding: RepoBinding = {
      id: crypto.randomUUID(),
      name: inferredName,
      role: input.role || 'CODE',
      kind: input.kind ?? 'hybrid',
      sourceType: 'remote',
      localPath: cacheDir,
      remoteUrl: normalizedUrl,
      declaredStoreId: alreadyCloned ? readDeclaredStoreId(cacheDir) : undefined,
      syncState: alreadyCloned ? 'idle' : 'cloning',
      lastSyncedAt: existingCached?.lastSyncedAt,
      autoSyncIntervalMinutes: input.autoSyncIntervalMinutes ?? 0,
    };

    await this.registry.addRepoToWorkspace(workspaceId, repoBinding);

    if (!alreadyCloned) {
      // 异步执行克隆，立即返回占位状态并通过 WS 通知前端刷新进度
      void this.performClone(workspaceId, repoBinding.id, normalizedUrl, cacheDir);
    } else {
      this.scheduleAutoSync(workspaceId, repoBinding);
    }

    return repoBinding;
  }

  /** 执行实际 git clone（优先部分过滤克隆，服务端不支持时自动降级标准克隆） */
  private async performClone(
    workspaceId: string,
    repoId: string,
    remoteUrl: string,
    cacheDir: string,
  ): Promise<void> {
    const opKey = `clone:${cacheDir}`;
    const existingOp = this.inFlightOps.get(opKey);
    if (existingOp) {
      return existingOp;
    }

    const task = (async () => {
      try {
        await this.updateSyncStatus(workspaceId, repoId, { syncState: 'cloning', lastError: undefined });
        if (fs.existsSync(cacheDir) && !fs.existsSync(path.join(cacheDir, '.git'))) {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        }

        if (!fs.existsSync(path.join(cacheDir, '.git'))) {
          const baseProtocolFlags = [
            '-c',
            'protocol.file.allow=never',
            '-c',
            'protocol.ext.allow=never',
          ];
          try {
            await execSafeCommand(
              'git',
              [...baseProtocolFlags, 'clone', '--filter=blob:none', '--', remoteUrl, cacheDir],
              { timeoutMs: 90_000 },
            );
          } catch (err) {
            const msg = formatExecError(err);
            // 仅当远端不支持 partial clone filter 时回退普通克隆；鉴权或网络错误直接抛出
            if (/filter|uploadpack\.allowFilter/i.test(msg)) {
              if (fs.existsSync(cacheDir)) {
                fs.rmSync(cacheDir, { recursive: true, force: true });
              }
              await execSafeCommand(
                'git',
                [...baseProtocolFlags, 'clone', '--', remoteUrl, cacheDir],
                { timeoutMs: 90_000 },
              );
            } else {
              throw err;
            }
          }
        }

        const now = new Date().toISOString();
        const declaredStoreId = readDeclaredStoreId(cacheDir);
        const updated = await this.registry.updateRepoInWorkspace(workspaceId, repoId, {
          syncState: 'idle',
          lastSyncedAt: now,
          lastError: undefined,
          declaredStoreId,
        });
        this.emitStatus(workspaceId, repoId, 'idle', now, undefined);
        if (updated) {
          this.scheduleAutoSync(workspaceId, updated);
        }
      } catch (err) {
        const message = formatExecError(err);
        await this.registry.updateRepoInWorkspace(workspaceId, repoId, {
          syncState: 'error',
          lastError: message,
        });
        this.emitStatus(workspaceId, repoId, 'error', undefined, message);
      } finally {
        this.inFlightOps.delete(opKey);
      }
    })();

    this.inFlightOps.set(opKey, task);
    return task;
  }

  /** 对指定远程缓存仓库执行非交互 git fetch 同步 */
  public async syncRemoteRepo(workspaceId: string, repoId: string): Promise<RepoBinding> {
    const ws = this.registry.getWorkspace(workspaceId);
    const repo = ws?.repos.find((r) => r.id === repoId);
    if (!repo) {
      throw new SecurityError(`仓库不存在: ${repoId}`, 404, 'REPO_NOT_FOUND');
    }
    if (repo.sourceType !== 'remote' || !repo.remoteUrl) {
      throw new SecurityError('仅远程缓存仓库支持 fetch 同步', 400, 'NOT_REMOTE_REPO');
    }

    // 校验 URL 与缓存目录合法性
    const normalizedUrl = validateRemoteGitUrl(repo.remoteUrl);
    if (!fs.existsSync(path.join(repo.localPath, '.git'))) {
      await this.performClone(workspaceId, repoId, normalizedUrl, repo.localPath);
      const refreshed = this.registry.getWorkspace(workspaceId)?.repos.find((r) => r.id === repoId);
      return refreshed ?? repo;
    }

    const opKey = `fetch:${repo.localPath}`;
    if (this.inFlightOps.has(opKey)) {
      await this.inFlightOps.get(opKey);
      const refreshed = this.registry.getWorkspace(workspaceId)?.repos.find((r) => r.id === repoId);
      return refreshed ?? repo;
    }

    const task = (async () => {
      try {
        await this.updateSyncStatus(workspaceId, repoId, { syncState: 'syncing', lastError: undefined });
        await execSafeCommand(
          'git',
          [
            '-c',
            'protocol.file.allow=never',
            '-c',
            'protocol.ext.allow=never',
            'fetch',
            '--prune',
            '--all',
          ],
          { cwd: repo.localPath, timeoutMs: 60_000 },
        );
        // 尽量快进同步本地默认跟踪分支以便本地 files 读取最新主分支内容
        try {
          await execSafeCommand('git', ['merge', '--ff-only', '@{u}'], {
            cwd: repo.localPath,
            timeoutMs: 15_000,
          });
        } catch {
          // 若当前为 detached HEAD 或无 upstream，不影响远端跟踪分支 origin/* 查看
        }

        const now = new Date().toISOString();
        const declaredStoreId = readDeclaredStoreId(repo.localPath);
        await this.registry.updateRepoInWorkspace(workspaceId, repoId, {
          syncState: 'idle',
          lastSyncedAt: now,
          lastError: undefined,
          declaredStoreId,
        });
        this.emitStatus(workspaceId, repoId, 'idle', now, undefined);
      } catch (err) {
        const message = formatExecError(err);
        await this.registry.updateRepoInWorkspace(workspaceId, repoId, {
          syncState: 'error',
          lastError: message,
        });
        this.emitStatus(workspaceId, repoId, 'error', undefined, message);
      } finally {
        this.inFlightOps.delete(opKey);
      }
    })();

    this.inFlightOps.set(opKey, task);
    await task;
    const updated = this.registry.getWorkspace(workspaceId)?.repos.find((r) => r.id === repoId);
    return updated ?? repo;
  }

  /** 安全删除未被引用的远程缓存目录 */
  public cleanupUnusedCache(localPath: string): boolean {
    if (!isStrictlyInsideDirectory(this.registry.remoteCacheRootDir, localPath)) {
      return false;
    }
    fs.rmSync(localPath, { recursive: true, force: true });
    return true;
  }

  /** 为工作区中的所有远程仓库刷新自动 fetch 定时器 */
  public refreshSchedulesForWorkspace(workspaceId: string): void {
    this.clearWorkspaceTimers(workspaceId);
    const ws = this.registry.getWorkspace(workspaceId);
    if (!ws) {
      return;
    }
    for (const repo of ws.repos) {
      if (repo.sourceType === 'remote') {
        this.scheduleAutoSync(workspaceId, repo);
      }
    }
  }

  /** 为单个远程仓库设置周期性 fetch 定时器 */
  private scheduleAutoSync(workspaceId: string, repo: RepoBinding): void {
    const key = `${workspaceId}:${repo.id}`;
    const prev = this.timers.get(key);
    if (prev) {
      clearInterval(prev);
      this.timers.delete(key);
    }

    const intervalMinutes = repo.autoSyncIntervalMinutes ?? 0;
    if (intervalMinutes <= 0) {
      return;
    }
    const timer = setInterval(() => {
      void this.syncRemoteRepo(workspaceId, repo.id);
    }, intervalMinutes * 60_000);
    // 不阻塞进程正常退出
    timer.unref();
    this.timers.set(key, timer);
  }

  /** 清理指定工作区的自动同步定时器 */
  public clearWorkspaceTimers(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const [key, timer] of this.timers.entries()) {
      if (key.startsWith(prefix)) {
        clearInterval(timer);
        this.timers.delete(key);
      }
    }
  }

  /** 停止全部定时器（服务关闭时调用） */
  public dispose(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private async updateSyncStatus(
    workspaceId: string,
    repoId: string,
    patch: Partial<RepoBinding>,
  ): Promise<void> {
    await this.registry.updateRepoInWorkspace(workspaceId, repoId, patch);
    this.emitStatus(workspaceId, repoId, patch.syncState, patch.lastSyncedAt, patch.lastError);
  }

  private emitStatus(
    workspaceId: string,
    repoId: string,
    syncState: RepoBinding['syncState'],
    lastSyncedAt?: string,
    error?: string,
  ): void {
    this.notifier?.({ workspaceId, repoId, syncState, lastSyncedAt, error });
  }
}

/** 格式化子进程错误，屏蔽敏感细节并提取可读提示 */
function formatExecError(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as { stderr?: string; message?: string; killed?: boolean };
    if (anyErr.killed) {
      return '远程 Git 操作超时，请检查网络连接或仓库大小';
    }
    const stderr = (anyErr.stderr ?? '').trim();
    if (/Authentication failed|Permission denied|could not read Username/i.test(stderr)) {
      return '远程仓库鉴权失败：请确认本机已配置有效的 SSH Key 或 Git 凭证';
    }
    if (stderr) {
      return stderr.split(/\r?\n/).slice(-3).join(' | ');
    }
    if (anyErr.message) {
      return anyErr.message;
    }
  }
  return '远程 Git 同步失败';
}
