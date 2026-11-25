/**
 * @file Change 详情工作台弹窗/面板组件
 * @description 展示 Proposal、Specs（含 Delta vs Main Diff）、Design、Tasks（含依赖状态与回写）及 Git 关联 Diff。
 * @author ypc
 */

import type {
  CrossRepoChangeGroup,
  CrossRepoProjectLink,
  GitDiffResult,
  RepoChangeEntry,
} from '@openspecui/shared';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Check,
  Columns2,
  GitBranch,
  GitCommitHorizontal,
  Lock,
  Maximize2,
  Minimize2,
  Pin,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type RepoChangeGitMatchResponse } from '../api';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { formatArchiveTime } from '../utils/formatArchiveTime';
import { DiffViewer } from './DiffViewer';
import { headingTextToSlug, MarkdownViewer } from './MarkdownViewer';

type DetailTabId = 'proposal' | 'specs' | 'design' | 'tasks' | 'git';

interface ResolvedArtifactLink {
  tab: 'proposal' | 'specs' | 'design' | 'tasks';
  anchor?: string;
  capabilityPath?: string;
}

/**
 * 解析 Markdown 文档中的相对路径超链接，判断是否指向当前 Change 的四大产物 Tab
 */
function resolveChangeArtifactLink(href: string): ResolvedArtifactLink | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(https?:|mailto:|tel:)/i.test(trimmed)) {
    return null;
  }

  const hashIdx = trimmed.indexOf('#');
  const rawPath = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const rawHash = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';
  const cleanPath = rawPath.split('?')[0].replace(/\\/g, '/').trim();
  let decodedPath = cleanPath;
  let anchor = rawHash.trim();
  try {
    decodedPath = decodeURIComponent(cleanPath);
    anchor = decodeURIComponent(anchor);
  } catch {
    // 保留原值避免非法百分号编码抛错
  }

  const normalized = decodedPath
    .replace(/^(\.\/)+/, '')
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\/+/, '')
    .toLowerCase();

  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] ?? '';

  if (fileName === 'proposal.md' || normalized === 'proposal') {
    return { tab: 'proposal', anchor: anchor || undefined };
  }
  if (fileName === 'design.md' || normalized === 'design') {
    return { tab: 'design', anchor: anchor || undefined };
  }
  if (fileName === 'tasks.md' || normalized === 'tasks') {
    return { tab: 'tasks', anchor: anchor || undefined };
  }

  // 匹配 specs/、specs/<cap>/spec.md 或直接指向某能力 spec.md
  const specsIdx = segments.lastIndexOf('specs');
  if (specsIdx >= 0) {
    const afterSpecs = segments.slice(specsIdx + 1);
    const capParts = afterSpecs[afterSpecs.length - 1] === 'spec.md' ? afterSpecs.slice(0, -1) : afterSpecs;
    return {
      tab: 'specs',
      capabilityPath: capParts.length > 0 ? capParts.join('/') : undefined,
      anchor: anchor || undefined,
    };
  }
  if (fileName === 'spec.md') {
    return { tab: 'specs', anchor: anchor || undefined };
  }

  return null;
}

interface ChangeDetailViewProps {
  workspaceId: string;
  group: CrossRepoChangeGroup;
  repoLinks?: CrossRepoProjectLink[];
  initialRepoId?: string;
  readOnlyMode?: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

const DELTA_BADGE: Record<string, string> = {
  ADDED: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  MODIFIED: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  REMOVED: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  RENAMED: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
};

export function ChangeDetailView({
  workspaceId,
  group,
  repoLinks = [],
  initialRepoId,
  readOnlyMode = false,
  onClose,
  onRefresh,
}: ChangeDetailViewProps) {
  const [activeRepoId, setActiveRepoId] = useState<string>(
    initialRepoId ?? group.entries[0]?.repoId ?? '',
  );
  const [activeTab, setActiveTab] = useState<DetailTabId>('proposal');
  const [compareSideBySide, setCompareSideBySide] = useState(false);
  const [specsViewMode, setSpecsViewMode] = useState<'markdown' | 'diff'>('markdown');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const [pendingScrollTarget, setPendingScrollTarget] = useState<{
    anchor?: string;
    capabilityPath?: string;
    scrollTopOnTabSwitch?: boolean;
  } | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  const [gitMatches, setGitMatches] = useState<RepoChangeGitMatchResponse[]>([]);
  const [showUnrelatedRepos, setShowUnrelatedRepos] = useState(false);
  const [selectedDiff, setSelectedDiff] = useState<GitDiffResult | null>(null);
  const [diffTitle, setDiffTitle] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);

  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    if (initialRepoId && group.entries.some((e) => e.repoId === initialRepoId)) {
      setActiveRepoId(initialRepoId);
    } else if (!group.entries.some((e) => e.repoId === activeRepoId)) {
      setActiveRepoId(group.entries[0]?.repoId ?? '');
    }
  }, [group, initialRepoId, activeRepoId]);

  const resolvedOwnerRepoIds = (() => {
    const directIds = group.entries.map((e) => e.repoId);
    const linkedIds = new Set<string>(directIds);
    for (const link of repoLinks) {
      if (link.repoIds.some((id) => directIds.includes(id))) {
        for (const id of link.repoIds) {
          linkedIds.add(id);
        }
      }
    }
    return Array.from(linkedIds);
  })();

  useEffect(() => {
    const names = Array.from(new Set([group.title, ...group.entries.map((e) => e.changeName)]));
    void api
      .matchChangeGit(workspaceId, group.key, names, resolvedOwnerRepoIds)
      .then((res) => setGitMatches(res.matches))
      .catch(() => setGitMatches([]));
    setShowUnrelatedRepos(false);
    setSelectedDiff(null);
  }, [workspaceId, group.key, group.title, group.entries, repoLinks]);

  const currentEntry: RepoChangeEntry | undefined =
    group.entries.find((e) => e.repoId === activeRepoId) ?? group.entries[0];

  useEffect(() => {
    if (!pendingScrollTarget) return;
    const rafId = window.requestAnimationFrame(() => {
      const container = contentScrollRef.current;
      if (!container) return;

      let scopeRoot: HTMLElement = container;
      let matchedCapability = false;
      if (pendingScrollTarget.capabilityPath) {
        const targetCap = pendingScrollTarget.capabilityPath.toLowerCase();
        const specBlocks = container.querySelectorAll<HTMLElement>('[data-spec-path]');
        for (const block of specBlocks) {
          const cap = (block.dataset.specPath ?? '').toLowerCase();
          if (cap === targetCap || cap.endsWith(`/${targetCap}`)) {
            scopeRoot = block;
            matchedCapability = true;
            break;
          }
        }
      }

      if (pendingScrollTarget.anchor) {
        const rawAnchor = pendingScrollTarget.anchor;
        const slugAnchor = headingTextToSlug(rawAnchor);
        const nodes = scopeRoot.querySelectorAll<HTMLElement>('[id]');
        for (const node of nodes) {
          if (node.id === rawAnchor || node.id === slugAnchor) {
            node.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setPendingScrollTarget(null);
            return;
          }
        }
      }

      if (matchedCapability) {
        scopeRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (pendingScrollTarget.scrollTopOnTabSwitch) {
        container.scrollTo({ top: 0, behavior: 'smooth' });
      }
      setPendingScrollTarget(null);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [activeTab, activeRepoId, specsViewMode, pendingScrollTarget]);

  const handleNavigateMarkdownLink = (href: string): boolean => {
    const resolved = resolveChangeArtifactLink(href);
    if (!resolved) {
      setLinkNotice(`该链接指向普通相对路径（${href}），非当前 Change 的 Proposal/Specs/Design/Tasks 文档。`);
      return false;
    }

    setLinkNotice(null);
    if (resolved.tab === 'specs' && resolved.anchor && specsViewMode !== 'markdown') {
      setSpecsViewMode('markdown');
    }
    setPendingScrollTarget({
      anchor: resolved.anchor,
      capabilityPath: resolved.capabilityPath,
      scrollTopOnTabSwitch: resolved.tab !== activeTab,
    });
    setActiveTab(resolved.tab);
    return true;
  };

  const handleToggleTask = async (
    entry: RepoChangeEntry,
    lineNumber: number,
    expectedChecked: boolean,
    rawLine: string,
  ) => {
    if (readOnlyMode || !entry.tasks || entry.tasks.readOnly) {
      return;
    }
    const key = `${entry.repoId}:${lineNumber}`;
    setTogglingKey(key);
    setTaskNotice(null);
    try {
      await api.toggleTask(workspaceId, {
        repoId: entry.repoId,
        changeName: entry.changeName,
        archived: entry.archived,
        fileHash: entry.tasks.fileHash,
        lineNumber,
        expectedChecked,
        nextChecked: !expectedChecked,
        expectedRawLine: rawLine,
      });
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setTaskNotice('检测到 tasks.md 已被外部工具或 AI 修改，已自动刷新最新内容，请核对后重试。');
        onRefresh();
      } else {
        setTaskNotice((err as Error).message);
      }
    } finally {
      setTogglingKey(null);
    }
  };

  const handlePinBranch = async (repoId: string, branch: string) => {
    if (readOnlyMode) return;
    await api.setBranchPin(workspaceId, {
      changeKey: group.key,
      repoId,
      branch: branch || undefined,
    });
    const names = Array.from(new Set([group.title, ...group.entries.map((e) => e.changeName)]));
    const res = await api.matchChangeGit(workspaceId, group.key, names, resolvedOwnerRepoIds);
    setGitMatches(res.matches);
  };

  const handleOpenDiff = async (repoId: string, target: string, label: string) => {
    setLoadingDiff(true);
    setDiffTitle(label);
    try {
      const diff = await api.getRepoDiff(repoId, target);
      setSelectedDiff(diff);
    } finally {
      setLoadingDiff(false);
    }
  };

  const renderMissingArtifactNotice = (
    entry: RepoChangeEntry,
    id: 'proposal' | 'specs' | 'design' | 'tasks',
  ) => {
    const state = entry.artifactStates.find((a) => a.id === id);
    if (!state || state.status === 'done') return null;
    if (state.status === 'next') {
      return (
        <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-6 text-xs text-sky-200">
          尚未撰写 `{id}`，且当前无前置阻塞：这是下一步待撰写的产物（可执行 `/opsx-propose` 或 `/opsx-continue` 补全）。
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-950 p-6 text-xs text-slate-400">
        尚未撰写 `{id}`，当前等待前置产物完成：{state.blockedBy?.join(', ') || 'prerequisite'}。
      </div>
    );
  };

  const renderEntrySpecs = (entry: RepoChangeEntry) => (
    <div className="space-y-4">
      {entry.deltaDiffs.length === 0 ? (
        renderMissingArtifactNotice(entry, 'specs')
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-400">
              共 {entry.deltaDiffs.length} 个能力规范文件
            </span>
            <div className="flex items-center rounded-lg border border-slate-700 bg-slate-950 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setSpecsViewMode('markdown')}
                className={`rounded-md px-2.5 py-1 ${
                  specsViewMode === 'markdown' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                规范文档 (Markdown)
              </button>
              <button
                type="button"
                onClick={() => setSpecsViewMode('diff')}
                className={`rounded-md px-2.5 py-1 ${
                  specsViewMode === 'diff' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Delta vs Main 对比
              </button>
            </div>
          </div>

          {entry.deltaDiffs.map((delta) =>
            specsViewMode === 'markdown' ? (
              <div key={delta.deltaFilePath} data-spec-path={delta.capabilityPath.toLowerCase()}>
                <MarkdownViewer
                  content={delta.deltaSpecRaw}
                  title={`[${entry.repoRole}] ${delta.capabilityPath} (${delta.deltaFilePath})`}
                  onNavigateLink={handleNavigateMarkdownLink}
                />
              </div>
            ) : (
              <div
                key={delta.deltaFilePath}
                data-spec-path={delta.capabilityPath.toLowerCase()}
                className="space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300">
                      {entry.repoRole}
                    </span>
                    <span className="font-mono text-xs font-semibold text-slate-100">{delta.capabilityPath}</span>
                  </div>
                  {delta.hasMainSpec ? (
                    <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-300">
                      已关联主规范对照
                    </span>
                  ) : (
                    <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
                      全新能力规范（主 specs 尚不存在）
                    </span>
                  )}
                </div>

                {delta.items.length === 0 ? (
                  <MarkdownViewer
                    content={delta.deltaSpecRaw}
                    title={delta.deltaFilePath}
                    onNavigateLink={handleNavigateMarkdownLink}
                  />
                ) : (
                  <div className="space-y-3">
                    {delta.items.map((item, idx) => (
                      <div key={idx} className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
                        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5 text-xs">
                          <span className="font-semibold text-slate-200">
                            {item.fromName ? `${item.fromName} -> ${item.name}` : item.name}
                          </span>
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${DELTA_BADGE[item.operation]}`}>
                            {item.operation}
                          </span>
                        </div>
                        {item.operation === 'MODIFIED' && item.beforeMarkdown ? (
                          <div className="grid divide-y divide-slate-800 md:grid-cols-2 md:divide-x md:divide-y-0">
                            <div className="bg-rose-950/20 p-3">
                              <div className="mb-1 text-[10px] font-medium text-rose-300">主规范原条文 (Main Spec)</div>
                              <pre className="whitespace-pre-wrap text-xs leading-5 text-slate-300">
                                {item.beforeMarkdown}
                              </pre>
                            </div>
                            <div className="bg-emerald-950/20 p-3">
                              <div className="mb-1 text-[10px] font-medium text-emerald-300">本次 Delta 变更后</div>
                              <pre className="whitespace-pre-wrap text-xs leading-5 text-slate-200">
                                {item.afterMarkdown}
                              </pre>
                            </div>
                          </div>
                        ) : (
                          <pre className="whitespace-pre-wrap p-3 text-xs leading-5 text-slate-200">
                            {item.afterMarkdown}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
        </>
      )}
    </div>
  );

  const renderEntryTasks = (entry: RepoChangeEntry) => {
    if (!entry.tasks) {
      return <div className="space-y-3">{renderMissingArtifactNotice(entry, 'tasks')}</div>;
    }

    const tasks = entry.tasks;
    const isReadOnly = readOnlyMode || tasks.readOnly;
    const togglingPrefix = `${entry.repoId}:`;
    const togglingLineNumber =
      togglingKey && togglingKey.startsWith(togglingPrefix)
        ? Number(togglingKey.slice(togglingPrefix.length))
        : null;

    return (
      <div className="space-y-3">
        <MarkdownViewer
          content={tasks.rawContent}
          title={`[${entry.repoRole}] ${tasks.relativePath}`}
          onNavigateLink={handleNavigateMarkdownLink}
          headerExtra={
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-500">
                ({tasks.completedCount}/{tasks.totalCount})
              </span>
              {readOnlyMode ? (
                <span className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                  <Lock className="h-3 w-3" /> 局域网只读模式
                </span>
              ) : entry.sourceType === 'remote' ? (
                <span className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                  <Lock className="h-3 w-3" /> 远程仓库为只读缓存（禁用勾选回写）
                </span>
              ) : entry.archived ? (
                <span className="flex items-center gap-1 rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
                  <Lock className="h-3 w-3" /> 已归档只读
                </span>
              ) : null}
            </div>
          }
          taskToggle={{
            items: tasks.items,
            disabled: isReadOnly,
            togglingLineNumber,
            onToggle: (item) =>
              void handleToggleTask(entry, item.lineNumber, item.checked, item.rawLine),
          }}
        />
      </div>
    );
  };

  const renderArtifactTabIcon = (id: 'proposal' | 'specs' | 'design' | 'tasks') => {
    const st = currentEntry?.artifactStates.find((a) => a.id === id);
    if (!st) return null;
    if (st.status === 'done') return <Check className="h-3 w-3 text-emerald-400" />;
    if (st.status === 'next') return <ArrowRight className="h-3 w-3 text-sky-400" />;
    return <Lock className="h-3 w-3 text-slate-500" />;
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs ${
        isFullscreen ? 'p-0' : 'p-2 md:p-4'
      }`}
    >
      <div
        className={`flex flex-col overflow-hidden border border-slate-700 bg-slate-900 shadow-2xl ${
          isFullscreen
            ? 'h-screen w-screen max-w-none rounded-none border-0'
            : 'h-[92vh] w-[96vw] max-w-[1600px] rounded-2xl'
        }`}
      >
        {/* 头部 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              {currentEntry && <span>{currentEntry.repoName}</span>}
              <span>·</span>
              <span>{group.stage}</span>
              <span>·</span>
              <span>
                {group.totalProgress.completed} / {group.totalProgress.total} tasks
              </span>
              {currentEntry?.archived && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">
                    <Archive className="h-3 w-3" />
                    归档于 {formatArchiveTime(currentEntry.archivedAt, currentEntry.archivedDate)}
                  </span>
                </>
              )}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-slate-100">{group.title}</h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {group.entries.length >= 2 && (activeTab === 'specs' || activeTab === 'tasks') && (
              <button
                type="button"
                onClick={() => setCompareSideBySide((v) => !v)}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs ${
                  compareSideBySide
                    ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                    : 'border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Columns2 className="h-3.5 w-3.5" /> 双仓并排对照
              </button>
            )}

            {!compareSideBySide &&
              group.entries.length > 1 &&
              group.entries.map((entry) => (
                <button
                  key={`${entry.repoId}:${entry.changeName}`}
                  type="button"
                  onClick={() => setActiveRepoId(entry.repoId)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                    currentEntry?.repoId === entry.repoId
                      ? 'bg-sky-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  [{entry.repoRole}] {entry.repoName}
                </button>
              ))}

            <button
              type="button"
              onClick={() => setIsFullscreen((v) => !v)}
              className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              title={isFullscreen ? '退出全屏' : '全屏查看'}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Artifact & Git Tab 栏 */}
        <div className="flex flex-wrap gap-1 border-b border-slate-800 px-5 py-2 text-xs">
          {(
            [
              { id: 'proposal', label: 'Proposal' },
              { id: 'specs', label: 'Specs (Delta Diff)' },
              { id: 'design', label: 'Design' },
              { id: 'tasks', label: 'Tasks' },
              { id: 'git', label: 'Git 分支 & Diff' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium ${
                activeTab === tab.id ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.id !== 'git' && renderArtifactTabIcon(tab.id)}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* 滚动内容区 */}
        <div ref={contentScrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
          {linkNotice && (
            <div className="flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-950/30 px-3 py-2 text-xs text-sky-200">
              <span className="min-w-0 flex-1 truncate">{linkNotice}</span>
              <button
                type="button"
                onClick={() => setLinkNotice(null)}
                className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                title="关闭提示"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {taskNotice && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{taskNotice}</span>
              <button
                type="button"
                onClick={onRefresh}
                className="ml-auto flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-amber-100 hover:bg-amber-500/30"
              >
                <RefreshCw className="h-3 w-3" /> 刷新
              </button>
            </div>
          )}

          {activeTab === 'specs' &&
            (compareSideBySide && group.entries.length >= 2 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {group.entries.map((entry) => (
                  <div key={`${entry.repoId}:${entry.changeName}`}>{renderEntrySpecs(entry)}</div>
                ))}
              </div>
            ) : (
              currentEntry && renderEntrySpecs(currentEntry)
            ))}

          {activeTab === 'tasks' &&
            (compareSideBySide && group.entries.length >= 2 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {group.entries.map((entry) => (
                  <div key={`${entry.repoId}:${entry.changeName}`}>{renderEntryTasks(entry)}</div>
                ))}
              </div>
            ) : (
              currentEntry && renderEntryTasks(currentEntry)
            ))}

          {activeTab === 'proposal' &&
            currentEntry &&
            (currentEntry.proposalContent ? (
              <MarkdownViewer
                content={currentEntry.proposalContent}
                title="proposal.md"
                onNavigateLink={handleNavigateMarkdownLink}
              />
            ) : (
              renderMissingArtifactNotice(currentEntry, 'proposal')
            ))}

          {activeTab === 'design' &&
            currentEntry &&
            (currentEntry.designContent ? (
              <MarkdownViewer
                content={currentEntry.designContent}
                title="design.md"
                onNavigateLink={handleNavigateMarkdownLink}
              />
            ) : (
              renderMissingArtifactNotice(currentEntry, 'design')
            ))}

          {activeTab === 'git' && (() => {
            const relatedMatches = gitMatches.filter((m) => m.isRelated);
            const unrelatedMatches = gitMatches.filter((m) => !m.isRelated);
            const visibleMatches = showUnrelatedRepos ? gitMatches : relatedMatches;

            return (
            <div className="grid gap-4 lg:grid-cols-5">
              <div className="space-y-3 lg:col-span-2">
                {visibleMatches.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-xs text-slate-500">
                    当前 Change 所属仓库未命中 Git 关联记录
                  </div>
                ) : (
                  visibleMatches.map((match) => (
                  <div
                    key={match.repoId}
                    className="space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300">
                          {match.status.repoRole}
                        </span>
                        <span className="font-semibold text-slate-200">{match.status.repoName}</span>
                        {!match.isRelated && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                            其他仓
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-400">匹配：{match.matchReason}</span>
                    </div>

                    {!match.status.isGitRepo ? (
                      <div className="text-slate-500">{match.status.error || '非 Git 仓库'}</div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <GitBranch className="h-3.5 w-3.5 text-sky-400" />
                          <select
                            disabled={readOnlyMode}
                            value={match.matchedBranch ?? ''}
                            onChange={(e) => void handlePinBranch(match.repoId, e.target.value)}
                            className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-60"
                          >
                            <option value="">自动匹配</option>
                            {match.status.branches.map((b) => (
                              <option key={b} value={b}>
                                {b}
                              </option>
                            ))}
                          </select>
                          {match.isPinned && (
                            <span className="flex items-center gap-0.5 text-[10px] text-amber-300">
                              <Pin className="h-3 w-3" /> 已固定
                            </span>
                          )}
                        </div>

                        {match.status.dirtyCount > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleOpenDiff(
                                match.repoId,
                                'working-tree',
                                `[${match.status.repoRole}] 未提交工作区 (${match.status.dirtyCount})`,
                              )
                            }
                            className="flex w-full items-center justify-between rounded-lg border border-amber-500/30 bg-amber-950/20 px-2.5 py-1.5 text-left text-amber-200 hover:bg-amber-950/40"
                          >
                            <span>查看未提交工作区改动</span>
                            <span>{match.status.dirtyCount} 文件</span>
                          </button>
                        )}

                        <div className="max-h-48 space-y-1 overflow-y-auto">
                          {match.commits.map((c) => (
                            <button
                              key={c.sha}
                              type="button"
                              onClick={() =>
                                void handleOpenDiff(
                                  match.repoId,
                                  c.sha,
                                  `[${match.status.repoRole}] ${c.shortSha} ${c.subject}`,
                                )
                              }
                              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-900"
                            >
                              <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-slate-200">{c.subject}</div>
                                <div className="text-[10px] text-slate-500">
                                  {c.shortSha} · {c.author} · {c.filesChanged} 文件
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  ))
                )}

                {unrelatedMatches.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowUnrelatedRepos((v) => !v)}
                    className="w-full rounded-lg border border-dashed border-slate-800 px-3 py-2 text-xs text-slate-400 hover:border-slate-700 hover:text-slate-200"
                  >
                    {showUnrelatedRepos
                      ? `收起工作区其余未关联仓库 (${unrelatedMatches.length})`
                      : `显示工作区其余未关联仓库 (${unrelatedMatches.length}，仅用于手动关联)`}
                  </button>
                )}
              </div>

              <div className="lg:col-span-3">
                <DiffViewer diff={selectedDiff} loading={loadingDiff} title={diffTitle} />
              </div>
            </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
