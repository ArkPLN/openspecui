/**
 * @file 按需实时文件监听管理器
 * @description 仅监听当前激活工作区下的本地仓库目录，忽略高频噪音目录并防抖推送 WebSocket 增量刷新通知。
 * @author ypc
 */

import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Workspace } from '@openspecui/shared';

export type WatcherChangeCallback = (event: {
  workspaceId: string;
  repoId: string;
}) => void;

/**
 * 按需懒监听管理器：切换工作区时立即卸载旧监听，避免多项目下的文件句柄耗尽。
 */
export class LazyWatcherManager {
  private activeWorkspaceId: string | null = null;
  private watchers: FSWatcher[] = [];
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly onChange: WatcherChangeCallback;

  constructor(onChange: WatcherChangeCallback) {
    this.onChange = onChange;
  }

  /**
   * 切换监听目标到指定工作区（先关闭旧监听，再挂载新监听）。
   */
  public async switchWorkspace(workspace: Workspace | undefined): Promise<void> {
    await this.closeAll();
    if (!workspace) {
      this.activeWorkspaceId = null;
      return;
    }

    this.activeWorkspaceId = workspace.id;
    for (const repo of workspace.repos) {
      // 仅对本地可编辑仓库挂载实时监听；远程缓存仓通过 fetch 同步事件触发刷新
      if (repo.sourceType !== 'local' || !fs.existsSync(repo.localPath)) {
        continue;
      }

      const watchTargets: string[] = [];
      const openSpecDir = path.join(repo.localPath, 'openspec');
      if (fs.existsSync(openSpecDir)) {
        watchTargets.push(openSpecDir);
      }
      const gitHead = path.join(repo.localPath, '.git', 'HEAD');
      const gitRefs = path.join(repo.localPath, '.git', 'refs');
      const gitIndex = path.join(repo.localPath, '.git', 'index');
      if (fs.existsSync(gitHead)) watchTargets.push(gitHead);
      if (fs.existsSync(gitRefs)) watchTargets.push(gitRefs);
      if (fs.existsSync(gitIndex)) watchTargets.push(gitIndex);

      // 若既无 openspec/ 也无 .git/，严禁回退为全目录递归监听（防止误扫描用户主目录或大目录）
      if (watchTargets.length === 0) {
        continue;
      }

      const watcher = chokidar.watch(watchTargets, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        depth: 6,
        awaitWriteFinish: {
          stabilityThreshold: 120,
          pollInterval: 50,
        },
        ignored: [
          '**/node_modules/**',
          '**/dist/**',
          '**/.git/objects/**',
          '**/.git/logs/**',
          '**/*.lock',
          '**/*.tmp',
        ],
      });

      const trigger = () => {
        if (this.activeWorkspaceId !== workspace.id) {
          return;
        }
        const key = `${workspace.id}:${repo.id}`;
        const existing = this.debounceTimers.get(key);
        if (existing) {
          clearTimeout(existing);
        }
        const timer = setTimeout(() => {
          this.debounceTimers.delete(key);
          this.onChange({ workspaceId: workspace.id, repoId: repo.id });
        }, 300);
        this.debounceTimers.set(key, timer);
      };

      watcher.on('add', trigger);
      watcher.on('change', trigger);
      watcher.on('unlink', trigger);
      watcher.on('error', () => {
        // 忽略短暂文件锁或权限抖动错误，保持服务稳定
      });

      this.watchers.push(watcher);
    }
  }

  /** 获取当前正在监听的 Watcher 数量（用于验证切换释放） */
  public getActiveWatcherCount(): number {
    return this.watchers.length;
  }

  /** 关闭并释放所有当前挂载的文件监听器 */
  public async closeAll(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    const toClose = this.watchers;
    this.watchers = [];
    await Promise.all(toClose.map((w) => w.close()));
  }
}
