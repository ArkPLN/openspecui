/**
 * @file 工作区创建、目录扫描与线上 Git URL 导入弹窗
 * @description 支持新建逻辑工作区、扫描本地目录发现仓库、导入原生 OpenSpec Workset/Store 以及添加线上 HTTPS/SSH Git 仓库。
 * @author ypc
 */

import type {
  AddRepoInput,
  DiscoveredRepoCandidate,
  OpenSpecEnvironmentInfo,
  RepoKind,
} from '@openspecui/shared';
import { FolderOpen, FolderSearch, Globe, Layers, MonitorUp, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { LocalFolderPickerModal } from './LocalFolderPickerModal';

interface WorkspaceModalProps {
  mode: 'create-workspace' | 'add-repo';
  workspaceId?: string;
  env: OpenSpecEnvironmentInfo;
  onClose: () => void;
  onCompleted: (workspaceId?: string) => void;
}

export function WorkspaceModal({
  mode,
  workspaceId,
  env,
  onClose,
  onCompleted,
}: WorkspaceModalProps) {
  const [workspaceName, setWorkspaceName] = useState('');
  const [sourceTab, setSourceTab] = useState<'local' | 'remote' | 'scan' | 'workset'>('local');

  // 本地或远程表单字段
  const [localPath, setLocalPath] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [role, setRole] = useState('FE');
  const [kind, setKind] = useState<RepoKind>('hybrid');
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(0);

  // 待提交仓库草稿（创建工作区模式下可一次加多个仓，如前后端双仓）
  const [draftRepos, setDraftRepos] = useState<AddRepoInput[]>([]);

  // 扫描目录状态（默认仅扫描 OpenSpec 项目，且默认不自动全选）
  const [scanRoot, setScanRoot] = useState('');
  const [onlyOpenSpec, setOnlyOpenSpec] = useState(true);
  const [candidates, setCandidates] = useState<DiscoveredRepoCandidate[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [hasScanned, setHasScanned] = useState(false);

  // 本机目录浏览 / 系统原生文件夹弹窗状态
  const [folderPickerTarget, setFolderPickerTarget] = useState<'localPath' | 'scanRoot' | null>(null);
  const [pickingNative, setPickingNative] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 当打开子级目录浏览器弹窗时，外层弹窗暂停响应 Esc，保证只关闭最上层弹窗
  useEscapeKey(onClose, !folderPickerTarget);

  const runScan = async (targetRoot: string, filterOpenSpec: boolean) => {
    if (!targetRoot.trim()) {
      setErrorMsg('请先输入或选择要扫描的父级目录');
      return;
    }
    setErrorMsg(null);
    try {
      const res = await api.discoverRepos(targetRoot.trim(), 2, filterOpenSpec);
      setCandidates(res.candidates);
      // 默认不自动全部勾选，由用户显式挑选
      setSelectedPaths(new Set());
      setHasScanned(true);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  const handleScan = async () => {
    await runScan(scanRoot, onlyOpenSpec);
  };

  const handleNativeFolderPick = async (target: 'localPath' | 'scanRoot') => {
    setErrorMsg(null);
    setPickingNative(true);
    try {
      const current = target === 'localPath' ? localPath : scanRoot;
      const res = await api.pickFolder(current.trim() || undefined);
      if (!res.cancelled && res.path) {
        if (target === 'localPath') {
          setLocalPath(res.path);
        } else {
          setScanRoot(res.path);
          await runScan(res.path, onlyOpenSpec);
        }
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setPickingNative(false);
    }
  };

  const handleAddDraftFromForm = () => {
    setErrorMsg(null);
    if (sourceTab === 'local') {
      if (!localPath.trim()) {
        setErrorMsg('请输入本地仓库绝对路径');
        return;
      }
      setDraftRepos((prev) => [
        ...prev,
        {
          sourceType: 'local',
          localPath: localPath.trim(),
          name: repoName.trim() || undefined,
          role: role.trim() || 'CODE',
          kind,
        },
      ]);
      setLocalPath('');
      setRepoName('');
    } else if (sourceTab === 'remote') {
      if (!remoteUrl.trim()) {
        setErrorMsg('请输入 HTTPS 或 SSH Git 地址');
        return;
      }
      setDraftRepos((prev) => [
        ...prev,
        {
          sourceType: 'remote',
          remoteUrl: remoteUrl.trim(),
          name: repoName.trim() || undefined,
          role: role.trim() || 'REMOTE',
          kind,
          autoSyncIntervalMinutes: autoSyncMinutes,
        },
      ]);
      setRemoteUrl('');
      setRepoName('');
    } else if (sourceTab === 'scan') {
      const picked = candidates.filter((c) => selectedPaths.has(c.path));
      if (picked.length === 0) {
        setErrorMsg('请至少勾选一个扫描到的仓库');
        return;
      }
      setDraftRepos((prev) => [
        ...prev,
        ...picked.map((c) => ({
          sourceType: 'local' as const,
          localPath: c.path,
          name: c.name,
          role: c.name.toUpperCase().slice(0, 12),
          kind: 'hybrid' as const,
        })),
      ]);
      setCandidates([]);
    }
  };

  const handleSubmit = async () => {
    setErrorMsg(null);
    setSubmitting(true);
    try {
      if (mode === 'create-workspace') {
        if (!workspaceName.trim()) {
          throw new Error('请输入逻辑工作区名称');
        }
        let reposToCreate = [...draftRepos];
        // 若用户没先点“加入列表”直接提交单仓表单，自动补入
        if (reposToCreate.length === 0) {
          if (sourceTab === 'local' && localPath.trim()) {
            reposToCreate = [
              {
                sourceType: 'local',
                localPath: localPath.trim(),
                name: repoName.trim() || undefined,
                role: role.trim() || 'MAIN',
                kind,
              },
            ];
          } else if (sourceTab === 'remote' && remoteUrl.trim()) {
            reposToCreate = [
              {
                sourceType: 'remote',
                remoteUrl: remoteUrl.trim(),
                name: repoName.trim() || undefined,
                role: role.trim() || 'REMOTE',
                kind,
                autoSyncIntervalMinutes: autoSyncMinutes,
              },
            ];
          } else if (sourceTab === 'scan' && selectedPaths.size > 0) {
            reposToCreate = candidates
              .filter((c) => selectedPaths.has(c.path))
              .map((c) => ({
                sourceType: 'local' as const,
                localPath: c.path,
                name: c.name,
                role: c.name.toUpperCase().slice(0, 12),
                kind: 'hybrid' as const,
              }));
          }
        }
        const created = await api.createWorkspace({
          name: workspaceName.trim(),
          repos: reposToCreate,
        });
        onCompleted(created.id);
      } else if (workspaceId) {
        if (sourceTab === 'local') {
          await api.addRepo(workspaceId, {
            sourceType: 'local',
            localPath: localPath.trim(),
            name: repoName.trim() || undefined,
            role: role.trim() || 'CODE',
            kind,
          });
        } else if (sourceTab === 'remote') {
          await api.addRepo(workspaceId, {
            sourceType: 'remote',
            remoteUrl: remoteUrl.trim(),
            name: repoName.trim() || undefined,
            role: role.trim() || 'REMOTE',
            kind,
            autoSyncIntervalMinutes: autoSyncMinutes,
          });
        } else if (sourceTab === 'scan') {
          for (const c of candidates.filter((item) => selectedPaths.has(item.path))) {
            await api.addRepo(workspaceId, {
              sourceType: 'local',
              localPath: c.path,
              name: c.name,
              role: c.name.toUpperCase().slice(0, 12),
              kind: 'hybrid',
            });
          }
        }
        onCompleted(workspaceId);
      }
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const [configDirPath, setConfigDirPath] = useState('');

  const handleImportOpenSpecUiJson = async () => {
    if (!configDirPath.trim()) {
      setErrorMsg('请输入包含 openspec-ui.json 的目录路径');
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const ws = await api.importOpenSpecUiJson(configDirPath.trim());
      onCompleted(ws.id);
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleImportWorkset = async (name: string, members: string[]) => {
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const ws = await api.importWorkset(name, members);
      onCompleted(ws.id);
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <h2 className="text-base font-semibold text-slate-100">
            {mode === 'create-workspace' ? '新建逻辑工作区（支持单仓 / 前后端多仓 / 线上 Git）' : '向当前工作区绑定仓库'}
          </h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[75vh] space-y-4 overflow-y-auto p-5 text-sm">
          {mode === 'create-workspace' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">逻辑工作区名称</label>
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="例如：电商系统（前后端联合）"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
          )}

          {/* 来源切换 */}
          <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2">
            {[
              { id: 'local', label: '本地目录路径', icon: Plus },
              { id: 'remote', label: '线上 Git 地址（只读缓存）', icon: Globe },
              { id: 'scan', label: '扫描本地目录', icon: FolderSearch },
              ...(mode === 'create-workspace'
                ? [{ id: 'workset', label: `OpenSpec Workset/Store (${env.worksets.length + env.stores.length})`, icon: Layers }]
                : []),
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSourceTab(tab.id as typeof sourceTab)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${
                    sourceTab === tab.id
                      ? 'bg-sky-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {sourceTab === 'local' && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">本地仓库 / Worktree 绝对路径</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder="例如：D:\code\shop-web"
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={() => setFolderPickerTarget('localPath')}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                    title="在网页内浏览本机盘符与目录树"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-sky-400" /> 浏览目录
                  </button>
                  <button
                    type="button"
                    disabled={pickingNative}
                    onClick={() => void handleNativeFolderPick('localPath')}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                    title="调用操作系统文件夹选择弹窗"
                  >
                    <MonitorUp className="h-3.5 w-3.5 text-emerald-400" /> {pickingNative ? '等待选择...' : '系统弹窗'}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">显示名（可选）</label>
                  <input
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="自动取目录名"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">角色标签</label>
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="FE / BE / STORE"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">仓库类型</label>
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as RepoKind)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs"
                  >
                    <option value="hybrid">代码 + OpenSpec</option>
                    <option value="code">纯代码仓</option>
                    <option value="store">独立 Store 仓</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {sourceTab === 'remote' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-sky-500/30 bg-sky-950/30 px-3 py-2 text-xs text-sky-200">
                仅放行 https://、http://、ssh://、git@host:repo 格式；克隆至本地受控缓存目录并保持只读，复用本机 SSH Key / Git 凭证。
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">线上 Git 地址</label>
                <input
                  type="text"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git 或 git@gitlab.com:org/repo.git"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100"
                />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">显示名（可选）</label>
                  <input
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">角色标签</label>
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">仓库类型</label>
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as RepoKind)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs"
                  >
                    <option value="hybrid">代码 + OpenSpec</option>
                    <option value="store">远程 Store 仓</option>
                    <option value="code">纯代码仓</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">自动同步(分钟)</label>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    value={autoSyncMinutes}
                    onChange={(e) => setAutoSyncMinutes(Number(e.target.value) || 0)}
                    placeholder="0=手动"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {sourceTab === 'scan' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={scanRoot}
                  onChange={(e) => setScanRoot(e.target.value)}
                  placeholder="输入或选择父目录路径，例如 D:\code"
                  className="min-w-[200px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setFolderPickerTarget('scanRoot')}
                  className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                >
                  <FolderOpen className="h-3.5 w-3.5 text-sky-400" /> 浏览目录
                </button>
                <button
                  type="button"
                  disabled={pickingNative}
                  onClick={() => void handleNativeFolderPick('scanRoot')}
                  className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                >
                  <MonitorUp className="h-3.5 w-3.5 text-emerald-400" /> 系统弹窗
                </button>
                <button
                  type="button"
                  onClick={() => void handleScan()}
                  className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
                >
                  扫描
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
                  <input
                    type="checkbox"
                    checked={onlyOpenSpec}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setOnlyOpenSpec(next);
                      if (scanRoot.trim()) {
                        void runScan(scanRoot, next);
                      }
                    }}
                  />
                  <span>仅显示 OpenSpec 项目（过滤无 openspec/ 的纯 Git 仓）</span>
                </label>

                {candidates.length > 0 && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-slate-400">
                      共 {candidates.length} 个，已选 {selectedPaths.size} 个
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedPaths(new Set(candidates.map((c) => c.path)))}
                      className="text-sky-400 hover:underline"
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedPaths(new Set())}
                      className="text-slate-400 hover:underline"
                    >
                      清空
                    </button>
                  </div>
                )}
              </div>

              {hasScanned && candidates.length === 0 ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 text-center text-xs text-slate-500">
                  未发现符合条件的项目（可检查目录深度或取消“仅显示 OpenSpec 项目”）
                </div>
              ) : null}

              {candidates.length > 0 && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2">
                  {candidates.map((c) => {
                    const checked = selectedPaths.has(c.path);
                    return (
                      <label key={c.path} className="flex cursor-pointer items-center justify-between rounded px-2 py-1 hover:bg-slate-900">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedPaths((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.path)) next.delete(c.path);
                                else next.add(c.path);
                                return next;
                              });
                            }}
                          />
                          <span className="text-xs font-medium text-slate-200">{c.name}</span>
                          <span className="font-mono text-[11px] text-slate-500">{c.path}</span>
                        </div>
                        <div className="flex gap-1 text-[10px]">
                          {c.hasOpenSpec && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300">OpenSpec</span>}
                          {c.hasGit && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-sky-300">Git</span>}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {sourceTab === 'workset' && (
            <div className="space-y-3">
              <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="text-xs font-semibold text-slate-200">导入 openspec-ui.json 配置文件</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={configDirPath}
                    onChange={(e) => setConfigDirPath(e.target.value)}
                    placeholder="输入含 openspec-ui.json 的目录路径"
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void handleImportOpenSpecUiJson()}
                    className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    导入配置
                  </button>
                </div>
              </div>

              {env.worksets.length === 0 && env.stores.length === 0 ? (
                <div className="rounded-lg border border-slate-800 p-4 text-center text-xs text-slate-500">
                  本机暂无已注册的 OpenSpec Workset 或 Store
                </div>
              ) : (
                <>
                  {env.worksets.map((w) => (
                    <div key={w.name} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 p-3">
                      <div>
                        <div className="text-xs font-semibold text-slate-200">Workset: {w.name}</div>
                        <div className="text-[11px] text-slate-500">{w.members.length} 个成员目录</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleImportWorkset(w.name, w.members)}
                        className="rounded bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500"
                      >
                        一键导入
                      </button>
                    </div>
                  ))}
                  {env.stores.map((s) => (
                    <div key={s.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 p-3">
                      <div>
                        <div className="text-xs font-semibold text-slate-200">Store: {s.id}</div>
                        <div className="font-mono text-[11px] text-slate-500">{s.path}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleImportWorkset(`store-${s.id}`, [s.path])}
                        className="rounded bg-emerald-600 px-2.5 py-1 text-xs text-white hover:bg-emerald-500"
                      >
                        作为工作区导入
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {mode === 'create-workspace' && sourceTab !== 'workset' && (
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleAddDraftFromForm}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
              >
                <Plus className="h-3.5 w-3.5" /> 加入待绑定仓库列表
              </button>
              <span className="text-xs text-slate-400">已加入 {draftRepos.length} 个仓库</span>
            </div>
          )}

          {draftRepos.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950 p-2.5">
              {draftRepos.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 truncate">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300">{item.role}</span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {item.sourceType === 'remote' ? '线上只读' : '本地'}
                    </span>
                    <span className="truncate font-mono text-slate-300">
                      {item.localPath ?? item.remoteUrl}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDraftRepos((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-slate-500 hover:text-rose-400"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}

          {errorMsg && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              {errorMsg}
            </div>
          )}
        </div>

        {sourceTab !== 'workset' && (
          <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-4 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleSubmit()}
              className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {submitting ? '处理中...' : mode === 'create-workspace' ? '创建并切换' : '确认绑定'}
            </button>
          </div>
        )}
      </div>

      {folderPickerTarget && (
        <LocalFolderPickerModal
          initialPath={folderPickerTarget === 'localPath' ? localPath : scanRoot}
          onSelect={(pickedPath) => {
            if (folderPickerTarget === 'localPath') {
              setLocalPath(pickedPath);
            } else {
              setScanRoot(pickedPath);
              void runScan(pickedPath, onlyOpenSpec);
            }
          }}
          onClose={() => setFolderPickerTarget(null)}
        />
      )}
    </div>
  );
}
