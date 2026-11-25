/**
 * @file OpenSpecUI 主应用工作台组件
 * @description 管理全局工作区切换、主题切换、手机局域网访问引导、WebSocket 实时刷新及看板/Git 视图。
 * @author ypc
 */

import type { OpenSpecEnvironmentInfo, RegistryStoreData, WorkspaceIdea } from '@openspecui/shared';
import {
  FolderPlus,
  GitBranch,
  Layers,
  Lock,
  Moon,
  Plus,
  RefreshCw,
  Smartphone,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, connectWorkbenchSocket, type WorkspaceOverviewResponse } from './api';
import { ChangeBoard } from './components/ChangeBoard';
import { ChangeDetailView } from './components/ChangeDetailView';
import { GitActivityView } from './components/GitActivityView';
import { IdeaModal } from './components/IdeaModal';
import { WorkspaceModal } from './components/WorkspaceModal';
import { useEscapeKey } from './hooks/useEscapeKey';

export function App() {
  const [registry, setRegistry] = useState<RegistryStoreData | null>(null);
  const [env, setEnv] = useState<OpenSpecEnvironmentInfo>({
    cliAvailable: false,
    stores: [],
    worksets: [],
  });
  const [readOnlyMode, setReadOnlyMode] = useState(false);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [overview, setOverview] = useState<WorkspaceOverviewResponse | null>(null);
  const [detailTarget, setDetailTarget] = useState<{ groupKey: string; focusRepoId?: string } | null>(null);
  const [ideaTarget, setIdeaTarget] = useState<WorkspaceIdea | null | undefined>(undefined);
  const [showMobileModal, setShowMobileModal] = useState(false);
  const [mainView, setMainView] = useState<'openspec' | 'git'>('openspec');
  const [modalMode, setModalMode] = useState<'create-workspace' | 'add-repo' | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    window.localStorage.getItem('openspecui-theme') === 'light' ? 'light' : 'dark',
  );
  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEscapeKey(() => setShowMobileModal(false), showMobileModal);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('theme-light');
    } else {
      root.classList.remove('theme-light');
    }
    window.localStorage.setItem('openspecui-theme', theme);
  }, [theme]);

  const loadWorkspaceData = useCallback(async (targetWorkspaceId?: string | null) => {
    try {
      const reg = await api.listWorkspaces();
      setRegistry(reg);
      const activeId = targetWorkspaceId ?? reg.activeWorkspaceId ?? reg.workspaces[0]?.id ?? null;
      if (activeId) {
        const data = await api.getOverview(activeId);
        setOverview(data);
      } else {
        setOverview(null);
      }
      setErrorBanner(null);
    } catch (err) {
      setErrorBanner((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cleanupWs: (() => void) | undefined;

    void (async () => {
      try {
        const session = await api.initSession();
        setReadOnlyMode(session.readOnlyMode);
        setLanUrls(session.lanUrls);

        void api
          .getEnv()
          .then((res) => setEnv(res.env))
          .catch(() => {});

        await loadWorkspaceData(session.activeWorkspaceId);

        cleanupWs = connectWorkbenchSocket((msg) => {
          if (msg.type === 'workspace:refresh' || msg.type === 'remote:sync-status') {
            void loadWorkspaceData();
          }
        });
      } catch (err) {
        setErrorBanner((err as Error).message);
        setLoading(false);
      }
    })();

    return () => {
      cleanupWs?.();
    };
  }, [loadWorkspaceData]);

  const handleSwitchWorkspace = async (workspaceId: string) => {
    if (readOnlyMode) {
      await loadWorkspaceData(workspaceId);
      return;
    }
    await api.activateWorkspace(workspaceId);
    await loadWorkspaceData(workspaceId);
  };

  const handleDeleteCurrentWorkspace = async () => {
    if (!overview || readOnlyMode) return;
    const hasRemote = overview.workspace.repos.some((r) => r.sourceType === 'remote');
    const ok = window.confirm(`确认移除工作区「${overview.workspace.name}」？（本地代码文件不会被删除）`);
    if (!ok) return;
    const cleanupCache = hasRemote
      ? window.confirm('工作区包含远程缓存仓，是否一并清理未被其他工作区引用的本地缓存？')
      : false;
    const res = await api.deleteWorkspace(overview.workspace.id, cleanupCache);
    await loadWorkspaceData(res.activeWorkspaceId);
  };

  const activeGroup = detailTarget
    ? overview?.changeGroups.find((g) => g.key === detailTarget.groupKey) ?? null
    : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {readOnlyMode && (
        <div className="border-b border-amber-500/30 bg-amber-500/15 px-4 py-1.5 text-center text-xs text-amber-200">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" /> 当前通过局域网（--host 0.0.0.0）以只读模式运行：所有写入、回写与本机目录控制接口已安全锁定
          </span>
        </div>
      )}

      {/* 顶部全局工作区切换导航栏（全屏铺满） */}
      <header className="sticky top-0 z-30 w-full border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2 font-semibold text-sky-400">
              <Layers className="h-5 w-5" />
              <span>OpenSpecUI</span>
            </div>

            <select
              value={overview?.workspace.id ?? ''}
              onChange={(e) => e.target.value && void handleSwitchWorkspace(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-100"
            >
              {!registry?.workspaces.length && <option value="">暂无工作区</option>}
              {registry?.workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.repos.length} 仓)
                </option>
              ))}
            </select>

            {!readOnlyMode && (
              <>
                <button
                  type="button"
                  onClick={() => setModalMode('create-workspace')}
                  className="flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
                >
                  <Plus className="h-3.5 w-3.5" /> 新建工作区
                </button>

                {overview && (
                  <>
                    <button
                      type="button"
                      onClick={() => setModalMode('add-repo')}
                      className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      <FolderPlus className="h-3.5 w-3.5 text-sky-400" /> 绑定仓库 / 线上 Git
                    </button>
                    <button
                      type="button"
                      title="删除当前工作区"
                      onClick={() => void handleDeleteCurrentWorkspace()}
                      className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:border-rose-500/40 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          {/* 顶部多仓 Git 状态 + 手机访问 + 主题切换 */}
          <div className="flex flex-wrap items-center gap-2">
            {overview?.gitStatuses.map((st) => (
              <div
                key={st.repoId}
                className="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-[11px]"
              >
                <span className="font-semibold text-sky-400">[{st.repoRole}]</span>
                <GitBranch className="h-3 w-3 text-slate-400" />
                <span className="font-mono text-slate-200">{st.branch}</span>
                {st.dirtyCount > 0 && (
                  <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-300">
                    *{st.dirtyCount}
                  </span>
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={() => setShowMobileModal(true)}
              className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-200"
              title="在手机/局域网打开"
            >
              <Smartphone className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-200"
              title={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>

            <button
              type="button"
              onClick={() => void loadWorkspaceData()}
              className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-200"
              title="刷新工作区"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {overview && (
          <div className="flex w-full items-center justify-between border-t border-slate-900 px-4 py-2 text-xs md:px-6">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMainView('openspec')}
                className={`rounded-md px-3 py-1 font-medium ${
                  mainView === 'openspec' ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                OpenSpec 看板与规范
              </button>
              <button
                type="button"
                onClick={() => setMainView('git')}
                className={`rounded-md px-3 py-1 font-medium ${
                  mainView === 'git' ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                多仓 Git 状态与活动流 ({overview.workspace.repos.length})
              </button>
            </div>
            <div className="text-[11px] text-slate-500">
              {env.cliAvailable ? `OpenSpec CLI ${env.cliVersion}` : 'OpenSpec CLI 未检测到（文件直读模式）'}
            </div>
          </div>
        )}
      </header>

      <main className="w-full flex-1 space-y-5 px-4 py-4 md:px-6">
        {errorBanner && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-2.5 text-xs text-rose-300">
            <span>{errorBanner}</span>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void loadWorkspaceData();
              }}
              className="shrink-0 rounded bg-rose-500/20 px-2.5 py-1 text-rose-100 hover:bg-rose-500/30"
            >
              重试
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center text-sm text-slate-300">
            <RefreshCw className="h-5 w-5 animate-spin text-sky-400" />
            <span>正在连接本地工作台并加载工作区...</span>
          </div>
        ) : !overview ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-12 text-center">
            <h2 className="text-base font-semibold text-slate-200">欢迎使用 OpenSpecUI</h2>
            <p className="mt-2 text-xs text-slate-400">
              创建一个逻辑工作区，绑定本地仓库、前后端分仓或线上 Git URL，立即统一预览 Specs 与 Git 变更。
            </p>
            {!readOnlyMode && (
              <button
                type="button"
                onClick={() => setModalMode('create-workspace')}
                className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500"
              >
                创建第一个工作区
              </button>
            )}
          </div>
        ) : mainView === 'openspec' ? (
          <ChangeBoard
            workspace={overview.workspace}
            changeGroups={overview.changeGroups}
            mainSpecs={overview.mainSpecs}
            readOnlyMode={readOnlyMode}
            onOpenDetail={(groupKey, focusRepoId) => setDetailTarget({ groupKey, focusRepoId })}
            onOpenIdeaModal={(idea) => setIdeaTarget(idea)}
            onRefresh={() => void loadWorkspaceData()}
          />
        ) : (
          <GitActivityView
            workspace={overview.workspace}
            gitStatuses={overview.gitStatuses}
            readOnlyMode={readOnlyMode}
            onRefresh={() => void loadWorkspaceData()}
          />
        )}
      </main>

      {activeGroup && overview && (
        <ChangeDetailView
          workspaceId={overview.workspace.id}
          group={activeGroup}
          repoLinks={overview.workspace.repoLinks}
          initialRepoId={detailTarget?.focusRepoId}
          readOnlyMode={readOnlyMode}
          onClose={() => setDetailTarget(null)}
          onRefresh={() => void loadWorkspaceData()}
        />
      )}

      {ideaTarget !== undefined && overview && (
        <IdeaModal
          workspaceId={overview.workspace.id}
          repos={overview.workspace.repos}
          idea={ideaTarget}
          readOnly={readOnlyMode}
          onClose={() => setIdeaTarget(undefined)}
          onSaved={() => void loadWorkspaceData()}
        />
      )}

      {modalMode && !readOnlyMode && (
        <WorkspaceModal
          mode={modalMode}
          workspaceId={overview?.workspace.id}
          env={env}
          onClose={() => setModalMode(null)}
          onCompleted={(id) => void loadWorkspaceData(id)}
        />
      )}

      {showMobileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Smartphone className="h-4 w-4 text-sky-400" />
                <span>在手机 / 局域网打开看板</span>
              </div>
              <button
                type="button"
                onClick={() => setShowMobileModal(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs text-slate-300">
              {readOnlyMode && lanUrls.length > 0 ? (
                <>
                  <p>当前服务已在局域网只读模式运行，同 Wi-Fi 下手机浏览器可访问：</p>
                  <div className="space-y-1.5">
                    {lanUrls.map((url) => (
                      <div key={url} className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sky-300">
                        {url}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <p>
                    默认启动仅监听本机 <code className="rounded bg-slate-800 px-1">127.0.0.1</code> 以保护本地写权限。如需手机同局域网查看，请使用以下命令启动（自动锁定为只读模式）：
                  </p>
                  <pre className="rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-sky-300">
                    openspecui --host 0.0.0.0
                  </pre>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;
