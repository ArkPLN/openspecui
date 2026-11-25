/**
 * @file 跨仓 Git 状态卡片与混合活动时间线组件
 * @description 独立展示每个仓库的分支、脏状态、远程只读缓存同步状态，并汇总跨仓倒序提交时间线与只读代码 Diff。
 * @author ypc
 */

import type { GitCommitItem, GitDiffResult, GitRepoStatus, Workspace } from '@openspecui/shared';
import { GitBranch, GitCommitHorizontal, Globe, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { DiffViewer } from './DiffViewer';

interface GitActivityViewProps {
  workspace: Workspace;
  gitStatuses: GitRepoStatus[];
  readOnlyMode?: boolean;
  onRefresh: () => void;
}

export function GitActivityView({
  workspace,
  gitStatuses,
  readOnlyMode = false,
  onRefresh,
}: GitActivityViewProps) {
  const [commits, setCommits] = useState<GitCommitItem[]>([]);
  const [syncingRepoId, setSyncingRepoId] = useState<string | null>(null);
  const [switchingRepoId, setSwitchingRepoId] = useState<string | null>(null);
  const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
  const [selectedDiff, setSelectedDiff] = useState<GitDiffResult | null>(null);
  const [diffTitle, setDiffTitle] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);

  const loadTimeline = async () => {
    try {
      const res = await api.getGitTimeline(workspace.id);
      setCommits(res.commits);
    } catch {
      setCommits([]);
    }
  };

  useEffect(() => {
    void loadTimeline();
    setSelectedDiff(null);
  }, [workspace.id, workspace.repos.length]);

  const handleSyncRemote = async (repoId: string) => {
    setSyncingRepoId(repoId);
    try {
      await api.syncRemoteRepo(workspace.id, repoId);
      await loadTimeline();
      onRefresh();
    } finally {
      setSyncingRepoId(null);
    }
  };

  const handleSwitchBranch = async (repoId: string, nextBranch: string, currentBranch: string) => {
    if (!nextBranch || nextBranch === currentBranch || readOnlyMode) return;
    setSwitchingRepoId(repoId);
    setBranchErrors((prev) => {
      const next = { ...prev };
      delete next[repoId];
      return next;
    });
    try {
      await api.checkoutBranch(repoId, nextBranch);
      await loadTimeline();
      onRefresh();
    } catch (err) {
      setBranchErrors((prev) => ({
        ...prev,
        [repoId]: (err as Error).message,
      }));
    } finally {
      setSwitchingRepoId(null);
    }
  };

  const handleRemoveRepo = async (repoId: string, isRemote: boolean) => {
    const cleanup = isRemote
      ? window.confirm('是否同时清理该远程缓存仓库占用的本地磁盘目录？\n点击“确定”清理缓存，点击“取消”仅解绑保留缓存。')
      : false;
    await api.removeRepo(workspace.id, repoId, cleanup);
    onRefresh();
  };

  const handleInspectDiff = async (repoId: string, target: string, title: string) => {
    setLoadingDiff(true);
    setDiffTitle(title);
    try {
      const diff = await api.getRepoDiff(repoId, target);
      setSelectedDiff(diff);
    } finally {
      setLoadingDiff(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* 仓库独立状态卡片网格 */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {workspace.repos.map((repo) => {
          const status = gitStatuses.find((s) => s.repoId === repo.id);
          const isRemote = repo.sourceType === 'remote';
          const isSyncing = syncingRepoId === repo.id || repo.syncState === 'cloning' || repo.syncState === 'syncing';

          return (
            <div key={repo.id} className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-xs">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                      {repo.role}
                    </span>
                    <span className="truncate text-sm font-semibold text-slate-100">{repo.name}</span>
                  </div>
                  {!readOnlyMode && (
                    <button
                      type="button"
                      title="从当前工作区解绑此仓库"
                      onClick={() => void handleRemoveRepo(repo.id, isRemote)}
                      className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {isRemote ? (
                    <span className="flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                      <Globe className="h-3 w-3" /> <Lock className="h-2.5 w-2.5" /> 线上只读缓存
                    </span>
                  ) : (
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">本地仓库</span>
                  )}
                  {repo.declaredStoreId && (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                      Store: {repo.declaredStoreId}
                    </span>
                  )}
                </div>

                <div className="truncate font-mono text-[11px] text-slate-500" title={repo.remoteUrl ?? repo.localPath}>
                  {repo.remoteUrl ?? repo.localPath}
                </div>

                {status?.isGitRepo ? (
                  <div className="space-y-2 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {!readOnlyMode && status.branches.length > 0 ? (
                        <div className="flex items-center gap-1.5">
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                          <select
                            disabled={switchingRepoId === repo.id || isSyncing}
                            value={status.branches.includes(status.branch) ? status.branch : '__detached__'}
                            onChange={(e) => void handleSwitchBranch(repo.id, e.target.value, status.branch)}
                            title="切换当前工作区分支"
                            className="max-w-[200px] rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-200 focus:border-sky-500 focus:outline-none disabled:opacity-60"
                          >
                            {!status.branches.includes(status.branch) && (
                              <option value="__detached__" disabled>
                                {status.branch}
                              </option>
                            )}
                            {status.branches.map((branchName) => (
                              <option key={branchName} value={branchName}>
                                {branchName}
                              </option>
                            ))}
                          </select>
                          {switchingRepoId === repo.id && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-sky-300">
                              <RefreshCw className="h-3 w-3 animate-spin" /> 切换中...
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="flex items-center gap-1 rounded bg-slate-950 px-2 py-1 font-mono text-slate-200">
                          <GitBranch className="h-3 w-3 text-sky-400" /> {status.branch}
                        </span>
                      )}
                      {(status.ahead > 0 || status.behind > 0) && (
                        <span className="text-[11px] text-slate-400">
                          ↑{status.ahead} ↓{status.behind}
                        </span>
                      )}
                      {status.dirtyCount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleInspectDiff(repo.id, 'working-tree', `[${repo.role}] ${repo.name} 未提交改动`)
                          }
                          className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-300 hover:bg-amber-500/30"
                        >
                          {status.dirtyCount} 个未提交改动
                        </button>
                      )}
                    </div>
                    {branchErrors[repo.id] && (
                      <div className="flex items-start justify-between gap-2 rounded border border-rose-500/40 bg-rose-950/30 p-2 text-[11px] text-rose-300">
                        <span className="break-all">{branchErrors[repo.id]}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setBranchErrors((prev) => {
                              const next = { ...prev };
                              delete next[repo.id];
                              return next;
                            })
                          }
                          className="shrink-0 text-rose-400 hover:text-rose-200"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-slate-500">{status?.error || '未初始化 Git'}</div>
                )}

                {repo.lastError && (
                  <div className="rounded border border-rose-500/30 bg-rose-950/30 p-2 text-[11px] text-rose-300">
                    {repo.lastError}
                  </div>
                )}
              </div>

              {isRemote && (
                <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-2 text-[11px] text-slate-400">
                  <span>
                    {repo.lastSyncedAt
                      ? `上次同步：${new Date(repo.lastSyncedAt).toLocaleTimeString()}`
                      : '尚未同步'}
                  </span>
                  {!readOnlyMode && (
                    <button
                      type="button"
                      disabled={isSyncing}
                      onClick={() => void handleSyncRemote(repo.id)}
                      className="flex items-center gap-1 rounded bg-sky-600/20 px-2 py-1 text-sky-300 hover:bg-sky-600/30 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${isSyncing ? 'animate-spin' : ''}`} />
                      {isSyncing ? '同步中...' : '立即同步'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 下半部：跨仓混合提交时间线 + 只读 Diff */}
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/70 p-4 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <h3 className="text-sm font-semibold text-slate-100">跨仓混合 Git 活动时间线</h3>
            <button
              type="button"
              onClick={() => void loadTimeline()}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              刷新
            </button>
          </div>

          {commits.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">暂无近期 Git 提交记录</div>
          ) : (
            <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
              {commits.map((c) => (
                <button
                  key={`${c.repoId}:${c.sha}`}
                  type="button"
                  onClick={() =>
                    void handleInspectDiff(c.repoId, c.sha, `[${c.repoRole}] ${c.shortSha} · ${c.subject}`)
                  }
                  className="flex w-full items-start gap-2 rounded-lg border border-transparent p-2 text-left text-xs hover:border-slate-800 hover:bg-slate-950"
                >
                  <GitCommitHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                        {c.repoRole}
                      </span>
                      <span className="truncate font-medium text-slate-200">{c.subject}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      <span className="font-mono">{c.shortSha}</span>
                      <span>{c.author}</span>
                      <span>{new Date(c.committedAt).toLocaleString()}</span>
                      <span>{c.filesChanged} 文件</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-3">
          <DiffViewer diff={selectedDiff} loading={loadingDiff} title={diffTitle} />
        </div>
      </div>
    </div>
  );
}
