/**
 * @file 兼容性多阶段 Kanban 看板、By-Repo 泳道、Cross-Repo 聚合与 Specs 浏览组件
 * @description 兼容 OpenSpec UI 的阶段式 Kanban、仓库筛选条、Artifact 状态胶囊与 Ideas 栏，同时保留跨仓聚合与手动关联能力。
 * @author ypc
 */

import type {
  ChangeStage,
  CrossRepoChangeGroup,
  MainSpecEntry,
  RepoChangeEntry,
  Workspace,
  WorkspaceIdea,
} from '@openspecui/shared';
import {
  Archive,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clock,
  Columns3,
  GripVertical,
  Kanban,
  Layers,
  Lightbulb,
  Link2,
  Lock,
  Plus,
  Rows3,
  Search,
  Unlink,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useEscapeKey } from '../hooks/useEscapeKey';
import {
  compareArchivedEntriesDesc,
  formatArchiveTime,
} from '../utils/formatArchiveTime';
import { MarkdownViewer } from './MarkdownViewer';
import { SpecHistoryPanel } from './SpecHistoryPanel';

interface ChangeBoardProps {
  workspace: Workspace;
  changeGroups: CrossRepoChangeGroup[];
  mainSpecs: MainSpecEntry[];
  readOnlyMode?: boolean;
  onOpenDetail: (groupKey: string, focusRepoId?: string) => void;
  onOpenIdeaModal: (idea?: WorkspaceIdea | null) => void;
  onRefresh: () => void;
}

const REPO_DOT_COLORS = [
  'bg-sky-400',
  'bg-emerald-400',
  'bg-violet-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-cyan-400',
];

const STAGE_COLUMNS: Array<{ id: ChangeStage; label: string; accent: string }> = [
  { id: 'planning', label: 'Planning', accent: 'text-sky-300' },
  { id: 'ready_to_apply', label: 'Ready to apply', accent: 'text-indigo-300' },
  { id: 'in_progress', label: 'In progress', accent: 'text-amber-300' },
  { id: 'complete', label: 'Complete', accent: 'text-emerald-300' },
];

type SortMode = 'custom' | 'name-asc' | 'name-desc' | 'least-done' | 'most-done';
type LayoutMode = 'stages' | 'by-repo' | 'cross-repo';

/** 公共重排辅助方法：将数组中 fromId 元素移动到 toId 位置 */
function reorderStringList(baseIds: string[], fromId: string, toId: string): string[] {
  const unique = Array.from(new Set(baseIds));
  const fromIdx = unique.indexOf(fromId);
  const toIdx = unique.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
    return unique;
  }
  const next = [...unique];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

function getEntrySortKey(entry: RepoChangeEntry): string {
  return `${entry.repoId}:${entry.changeName}`;
}

export function ChangeBoard({
  workspace,
  changeGroups,
  mainSpecs,
  readOnlyMode = false,
  onOpenDetail,
  onOpenIdeaModal,
  onRefresh,
}: ChangeBoardProps) {
  const [boardTab, setBoardTab] = useState<'board' | 'archive' | 'specs'>('board');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('stages');
  const [selectedRepoId, setSelectedRepoId] = useState<string>('all');
  const [searchText, setSearchText] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>(
    workspace.customOrder?.changeOrder?.length ? 'custom' : 'name-asc',
  );
  const [showArchived, setShowArchived] = useState(false);
  const [showIdeas, setShowIdeas] = useState(false);

  const [dragState, setDragState] = useState<{
    kind: 'repo' | 'idea' | 'change' | 'group';
    id: string;
    stage?: ChangeStage;
  } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [selectedMainSpec, setSelectedMainSpec] = useState<MainSpecEntry | null>(mainSpecs[0] ?? null);

  useEscapeKey(() => setShowLinkModal(false), showLinkModal);

  const repoColorMap = useMemo(() => {
    const map = new Map<string, string>();
    workspace.repos.forEach((r, idx) => {
      map.set(r.id, REPO_DOT_COLORS[idx % REPO_DOT_COLORS.length]);
    });
    return map;
  }, [workspace.repos]);

  // 展平单仓条目并附带所属 groupKey，方便 Stages / By-repo 视图精确打开详情
  const flatEntries = useMemo(() => {
    const list: Array<{ groupKey: string; entry: RepoChangeEntry }> = [];
    for (const g of changeGroups) {
      for (const entry of g.entries) {
        list.push({ groupKey: g.key, entry });
      }
    }
    return list;
  }, [changeGroups]);

  // 仓库筛选条统计
  const repoStats = useMemo(() => {
    const computeCounts = (items: RepoChangeEntry[]) => {
      const active = items.filter((e) => !e.archived);
      const planning = active.filter((e) => e.stage === 'planning').length;
      const ready = active.filter((e) => e.stage === 'ready_to_apply').length;
      const inProgress = active.filter((e) => e.stage === 'in_progress').length;
      const complete = active.filter((e) => e.stage === 'complete').length;
      const checked = active.reduce((s, e) => s + e.progress.completed, 0);
      const total = active.reduce((s, e) => s + e.progress.total, 0);
      return { activeCount: active.length, planning, ready, inProgress, complete, checked, total };
    };

    const allEntries = flatEntries.map((x) => x.entry);
    return {
      all: computeCounts(allEntries),
      byRepo: workspace.repos.map((repo) => ({
        repo,
        ...computeCounts(allEntries.filter((e) => e.repoId === repo.id)),
      })),
    };
  }, [flatEntries, workspace.repos]);

  const filteredEntries = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = flatEntries.filter(({ entry }) => {
      if (selectedRepoId !== 'all' && entry.repoId !== selectedRepoId) return false;
      if (!showArchived && entry.archived) return false;
      if (q) {
        const hay = `${entry.changeName} ${entry.repoName} ${entry.summary}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const customRank = new Map((workspace.customOrder?.changeOrder ?? []).map((k, idx) => [k, idx]));
    const pct = (e: RepoChangeEntry) => (e.progress.total > 0 ? e.progress.completed / e.progress.total : 0);
    list.sort((a, b) => {
      if (sortMode === 'custom') {
        const ra = customRank.get(getEntrySortKey(a.entry)) ?? Number.MAX_SAFE_INTEGER;
        const rb = customRank.get(getEntrySortKey(b.entry)) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
      }
      if (sortMode === 'name-desc') return b.entry.changeName.localeCompare(a.entry.changeName);
      if (sortMode === 'least-done') return pct(a.entry) - pct(b.entry);
      if (sortMode === 'most-done') return pct(b.entry) - pct(a.entry);
      // 归档条目在默认/自定义未排位模式下按归档时间倒序展示
      if (a.entry.archived && b.entry.archived) {
        return compareArchivedEntriesDesc(a.entry, b.entry);
      }
      return a.entry.changeName.localeCompare(b.entry.changeName);
    });
    return list;
  }, [flatEntries, selectedRepoId, showArchived, searchText, sortMode, workspace.customOrder]);

  const filteredGroups = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = changeGroups.filter((g) => {
      if (!showArchived && g.aggregateStatus === 'all_archived') return false;
      if (selectedRepoId !== 'all' && !g.entries.some((e) => e.repoId === selectedRepoId)) return false;
      if (q && !`${g.title} ${g.entries.map((e) => e.summary).join(' ')}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
    const pickLatestArchivedEntry = (g: CrossRepoChangeGroup): RepoChangeEntry | undefined => {
      const archivedOnes = g.entries.filter((e) => e.archived);
      if (archivedOnes.length === 0) return undefined;
      return [...archivedOnes].sort(compareArchivedEntriesDesc)[0];
    };

    const rank = new Map((workspace.customOrder?.changeOrder ?? []).map((k, idx) => [k, idx]));
    list.sort((a, b) => {
      if (sortMode === 'custom') {
        const ra = rank.get(a.key) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.key) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
      }
      if (a.aggregateStatus === 'all_archived' && b.aggregateStatus === 'all_archived') {
        const ea = pickLatestArchivedEntry(a);
        const eb = pickLatestArchivedEntry(b);
        if (ea && eb) return compareArchivedEntriesDesc(ea, eb);
      }
      return a.title.localeCompare(b.title);
    });
    return list;
  }, [changeGroups, showArchived, selectedRepoId, searchText, sortMode, workspace.customOrder]);

  const filteredSpecs = useMemo(() => {
    if (selectedRepoId === 'all') return mainSpecs;
    return mainSpecs.filter((s) => s.repoId === selectedRepoId);
  }, [mainSpecs, selectedRepoId]);

  const totalArchivedCount = useMemo(
    () => flatEntries.filter((x) => x.entry.archived).length,
    [flatEntries],
  );

  const filteredArchivedEntries = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return flatEntries
      .filter(({ entry }) => {
        if (!entry.archived) return false;
        if (selectedRepoId !== 'all' && entry.repoId !== selectedRepoId) return false;
        if (
          q &&
          !`${entry.changeName} ${entry.archiveFolderName ?? ''} ${entry.summary} ${entry.repoName}`
            .toLowerCase()
            .includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => compareArchivedEntriesDesc(a.entry, b.entry));
  }, [flatEntries, selectedRepoId, searchText]);

  const toggleLinkRepo = (repoId: string) => {
    setSelectedRepoIds((prev) =>
      prev.includes(repoId) ? prev.filter((id) => id !== repoId) : [...prev, repoId],
    );
  };

  const handleCreateRepoLink = async () => {
    setLinkError(null);
    if (!linkTitle.trim() || selectedRepoIds.length < 2) {
      setLinkError('请填写跨仓项目组名称并至少勾选 2 个项目仓库');
      return;
    }
    try {
      await api.createRepoLink(workspace.id, {
        title: linkTitle.trim(),
        repoIds: selectedRepoIds,
      });
      setShowLinkModal(false);
      setLinkTitle('');
      setSelectedRepoIds([]);
      onRefresh();
    } catch (err) {
      setLinkError((err as Error).message);
    }
  };

  const handleDropReorder = async (
    kind: 'repo' | 'idea' | 'change' | 'group',
    targetId: string,
    targetStage?: ChangeStage,
  ) => {
    if (readOnlyMode || !dragState || dragState.kind !== kind || dragState.id === targetId) {
      setDragState(null);
      setDragOverId(null);
      return;
    }
    // 禁止跨生命周期阶段拖拽伪造状态
    if (kind === 'change' && dragState.stage !== targetStage) {
      setDragState(null);
      setDragOverId(null);
      return;
    }

    if (kind === 'repo') {
      const nextRepoIds = reorderStringList(
        workspace.repos.map((r) => r.id),
        dragState.id,
        targetId,
      );
      await api.updateWorkspaceOrder(workspace.id, { repoIds: nextRepoIds });
    } else if (kind === 'idea') {
      const nextIdeaOrder = reorderStringList(
        workspace.ideas.map((i) => i.id),
        dragState.id,
        targetId,
      );
      await api.updateWorkspaceOrder(workspace.id, { ideaOrder: nextIdeaOrder });
    } else if (kind === 'change') {
      const baseKeys = Array.from(
        new Set([
          ...(workspace.customOrder?.changeOrder ?? []),
          ...filteredEntries.map(({ entry }) => getEntrySortKey(entry)),
        ]),
      );
      const nextChangeOrder = reorderStringList(baseKeys, dragState.id, targetId);
      setSortMode('custom');
      await api.updateWorkspaceOrder(workspace.id, { changeOrder: nextChangeOrder });
    } else if (kind === 'group') {
      const baseKeys = Array.from(
        new Set([
          ...(workspace.customOrder?.changeOrder ?? []),
          ...filteredGroups.map((g) => g.key),
        ]),
      );
      const nextChangeOrder = reorderStringList(baseKeys, dragState.id, targetId);
      setSortMode('custom');
      await api.updateWorkspaceOrder(workspace.id, { changeOrder: nextChangeOrder });
    }

    setDragState(null);
    setDragOverId(null);
    onRefresh();
  };

  const renderChangeCard = (groupKey: string, entry: RepoChangeEntry) => {
    const dotClass = repoColorMap.get(entry.repoId) ?? 'bg-sky-400';
    const sortKey = getEntrySortKey(entry);
    const isDropTarget =
      dragOverId === sortKey && dragState?.kind === 'change' && dragState.stage === entry.stage;
    const pct =
      entry.progress.total > 0
        ? Math.round((entry.progress.completed / entry.progress.total) * 100)
        : 0;
    const blockingHint = entry.artifactStates
      .filter((a) => a.status === 'blocked' && a.blockedBy?.length)
      .map((a) => `${a.label} 等 ${a.blockedBy?.join('/')}`)
      .join('；');

    return (
      <div
        key={`${groupKey}:${entry.repoId}:${entry.changeName}:${entry.archiveFolderName ?? 'active'}`}
        draggable={!readOnlyMode}
        onDragStart={(e) => {
          e.stopPropagation();
          setDragState({ kind: 'change', id: sortKey, stage: entry.stage });
        }}
        onDragOver={(e) => {
          if (dragState?.kind === 'change' && dragState.stage === entry.stage) {
            e.preventDefault();
            setDragOverId(sortKey);
          }
        }}
        onDragLeave={() => {
          if (dragOverId === sortKey) setDragOverId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleDropReorder('change', sortKey, entry.stage);
        }}
        onDragEnd={() => {
          setDragState(null);
          setDragOverId(null);
        }}
        onClick={() => onOpenDetail(groupKey, entry.repoId)}
        className={`cursor-pointer rounded-xl border bg-slate-900/80 p-3.5 transition hover:border-sky-500/60 hover:shadow-md ${
          isDropTarget ? 'border-sky-400 ring-2 ring-sky-500/40' : 'border-slate-800'
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-1.5 truncate">
            {!readOnlyMode && <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-slate-500" />}
            <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
            <span className="truncate font-medium text-slate-300">{entry.repoName}</span>
            <span className="rounded bg-slate-800 px-1 py-0.5 text-[10px] text-sky-300">{entry.repoRole}</span>
          </div>
          {entry.sourceType === 'remote' && (
            <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">远程</span>
          )}
        </div>

        <div className="mt-1.5 truncate text-sm font-semibold text-slate-100">{entry.changeName}</div>
        {entry.summary && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">{entry.summary}</p>
        )}

        {entry.stage === 'planning' && (
          <div className="mt-3 space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {entry.artifactStates.map((art) => (
                <span
                  key={art.id}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                    art.status === 'done'
                      ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                      : art.status === 'next'
                        ? 'border-sky-500/40 bg-sky-500/20 text-sky-300'
                        : 'border-slate-700 bg-slate-950 text-slate-500'
                  }`}
                >
                  {art.status === 'done' && <Check className="h-2.5 w-2.5" />}
                  {art.status === 'next' && <ArrowRight className="h-2.5 w-2.5" />}
                  {art.status === 'blocked' && <Lock className="h-2.5 w-2.5" />}
                  {art.label}
                  {art.status === 'next' ? ' next' : ''}
                </span>
              ))}
            </div>
            {blockingHint && <div className="text-[10px] text-slate-500">{blockingHint}</div>}
          </div>
        )}

        {(entry.stage === 'ready_to_apply' || entry.stage === 'in_progress' || entry.stage === 'complete') && (
          <div className="mt-3 space-y-1">
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>Tasks checked</span>
              <span>
                {entry.progress.completed} / {entry.progress.total}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full transition-all ${
                  entry.stage === 'complete'
                    ? 'bg-emerald-500'
                    : entry.stage === 'in_progress'
                      ? 'bg-amber-500'
                      : 'bg-slate-600'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {entry.stage === 'archived' && (
          <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-400">
            <Archive className="h-3 w-3 shrink-0 text-emerald-400" />
            <span className="truncate">归档于 {formatArchiveTime(entry.archivedAt, entry.archivedDate)}</span>
          </div>
        )}
      </div>
    );
  };

  const visibleColumns = showArchived
    ? [...STAGE_COLUMNS, { id: 'archived' as ChangeStage, label: 'Archived', accent: 'text-slate-300' }]
    : STAGE_COLUMNS;

  return (
    <div className="space-y-4">
      {/* 顶部模式切换 + 操作条 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1 text-xs">
          <button
            type="button"
            onClick={() => setBoardTab('board')}
            className={`rounded-md px-3 py-1.5 font-medium ${
              boardTab === 'board' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Board 看板 ({flatEntries.filter((x) => !x.entry.archived).length})
          </button>
          <button
            type="button"
            onClick={() => setBoardTab('archive')}
            className={`flex items-center gap-1 rounded-md px-3 py-1.5 font-medium ${
              boardTab === 'archive' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Archive className="h-3.5 w-3.5" /> Archive 归档库 ({totalArchivedCount})
          </button>
          <button
            type="button"
            onClick={() => setBoardTab('specs')}
            className={`rounded-md px-3 py-1.5 font-medium ${
              boardTab === 'specs' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Specs 规范库 ({mainSpecs.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {boardTab === 'board' && (
            <>
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 ${
                  showArchived
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Archive className="h-3.5 w-3.5" /> Archived ({totalArchivedCount})
              </button>
              {!readOnlyMode && (
                <button
                  type="button"
                  onClick={() => onOpenIdeaModal(null)}
                  className="flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-300 hover:bg-amber-500/20"
                >
                  <Lightbulb className="h-3.5 w-3.5" /> New idea
                </button>
              )}
              {!readOnlyMode && workspace.repos.length >= 2 && (
                <button
                  type="button"
                  onClick={() => {
                    setLinkError(null);
                    setShowLinkModal(true);
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800"
                >
                  <Link2 className="h-3.5 w-3.5 text-sky-400" /> 关联跨仓项目
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 仓库概览筛选卡片条（类似 OpenSpec UI Repos Filter Bar） */}
      {workspace.repos.length > 0 && (
        <div className="flex gap-2.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setSelectedRepoId('all')}
            className={`min-w-[175px] shrink-0 rounded-xl border p-3 text-left transition ${
              selectedRepoId === 'all'
                ? 'border-sky-500 bg-slate-900 shadow-sm'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between text-xs font-semibold text-slate-100">
              <span>All repos</span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                {repoStats.all.activeCount} active
              </span>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-400">
              {repoStats.all.checked}/{repoStats.all.total} tasks checked
            </div>
            <div className="mt-2 flex gap-1.5 text-[10px] text-slate-500">
              <span>P:{repoStats.all.planning}</span>
              <span>R:{repoStats.all.ready}</span>
              <span>I:{repoStats.all.inProgress}</span>
              <span>C:{repoStats.all.complete}</span>
            </div>
          </button>

          {repoStats.byRepo.map(({ repo, activeCount, planning, ready, inProgress, complete, checked, total }) => {
            const dotClass = repoColorMap.get(repo.id) ?? 'bg-sky-400';
            const active = selectedRepoId === repo.id;
            const isRepoDrop = dragOverId === repo.id && dragState?.kind === 'repo';
            return (
              <button
                key={repo.id}
                type="button"
                draggable={!readOnlyMode}
                onDragStart={() => setDragState({ kind: 'repo', id: repo.id })}
                onDragOver={(e) => {
                  if (dragState?.kind === 'repo') {
                    e.preventDefault();
                    setDragOverId(repo.id);
                  }
                }}
                onDragLeave={() => {
                  if (dragOverId === repo.id) setDragOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleDropReorder('repo', repo.id);
                }}
                onDragEnd={() => {
                  setDragState(null);
                  setDragOverId(null);
                }}
                onClick={() => setSelectedRepoId(active ? 'all' : repo.id)}
                className={`min-w-[185px] shrink-0 rounded-xl border p-3 text-left transition ${
                  isRepoDrop
                    ? 'border-sky-400 ring-2 ring-sky-500/40'
                    : active
                      ? 'border-sky-500 bg-slate-900 shadow-sm'
                      : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-100">
                  <span className="flex items-center gap-1.5 truncate">
                    {!readOnlyMode && <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-slate-500" />}
                    <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                    <span className="truncate">{repo.name}</span>
                  </span>
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                    {activeCount} active
                  </span>
                </div>
                <div className="mt-1.5 text-[11px] text-slate-400">
                  {checked}/{total} tasks checked
                </div>
                <div className="mt-2 flex gap-1.5 text-[10px] text-slate-500">
                  <span>P:{planning}</span>
                  <span>R:{ready}</span>
                  <span>I:{inProgress}</span>
                  <span>C:{complete}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {boardTab === 'board' ? (
        <>
          {/* 搜索、排序与 Stages / By repo / Cross-Repo 布局切换 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Search changes..."
                  className="w-56 rounded-lg border border-slate-800 bg-slate-900 py-1.5 pl-8 pr-3 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                />
              </div>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200"
              >
                <option value="custom">Custom (自定义排序)</option>
                <option value="name-asc">Name A–Z</option>
                <option value="name-desc">Name Z–A</option>
                <option value="least-done">Least done</option>
                <option value="most-done">Most done</option>
              </select>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setLayoutMode('stages')}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${
                  layoutMode === 'stages' ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Kanban className="h-3.5 w-3.5" /> Stages
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('by-repo')}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${
                  layoutMode === 'by-repo' ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Rows3 className="h-3.5 w-3.5" /> By repo
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('cross-repo')}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${
                  layoutMode === 'cross-repo' ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Layers className="h-3.5 w-3.5" /> 跨仓聚合
              </button>
            </div>
          </div>

          {layoutMode === 'stages' && (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {/* 可折叠 Ideas 列 */}
              {!showIdeas ? (
                <button
                  type="button"
                  onClick={() => setShowIdeas(true)}
                  className="flex w-11 shrink-0 flex-col items-center justify-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 py-4 text-xs text-amber-300 hover:border-amber-500/50"
                  title="展开 Ideas 列"
                >
                  <Lightbulb className="h-4 w-4" />
                  <span className="font-semibold">{workspace.ideas.length}</span>
                  <span className="[writing-mode:vertical-rl] text-[11px] text-slate-400">Ideas</span>
                </button>
              ) : (
                <div className="w-72 shrink-0 space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-amber-300">
                    <button
                      type="button"
                      onClick={() => setShowIdeas(false)}
                      className="flex items-center gap-1.5 hover:underline"
                    >
                      <Lightbulb className="h-3.5 w-3.5" /> Ideas ({workspace.ideas.length})
                    </button>
                    {!readOnlyMode && (
                      <button
                        type="button"
                        onClick={() => onOpenIdeaModal(null)}
                        className="rounded p-1 hover:bg-slate-800"
                        title="New idea"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
                    {workspace.ideas.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-[11px] text-slate-500">
                        暂无 Idea，点击上方 + 记录想法
                      </div>
                    ) : (
                      workspace.ideas.map((idea) => {
                        const repo = workspace.repos.find((r) => r.id === idea.repoId);
                        const isIdeaDrop = dragOverId === idea.id && dragState?.kind === 'idea';
                        return (
                          <div
                            key={idea.id}
                            draggable={!readOnlyMode}
                            onDragStart={() => setDragState({ kind: 'idea', id: idea.id })}
                            onDragOver={(e) => {
                              if (dragState?.kind === 'idea') {
                                e.preventDefault();
                                setDragOverId(idea.id);
                              }
                            }}
                            onDragLeave={() => {
                              if (dragOverId === idea.id) setDragOverId(null);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              void handleDropReorder('idea', idea.id);
                            }}
                            onDragEnd={() => {
                              setDragState(null);
                              setDragOverId(null);
                            }}
                            onClick={() => onOpenIdeaModal(idea)}
                            className={`cursor-pointer rounded-xl border bg-slate-900/80 p-3 hover:border-amber-500/50 ${
                              isIdeaDrop ? 'border-amber-400 ring-2 ring-amber-500/40' : 'border-slate-800'
                            }`}
                          >
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="flex items-center gap-1 text-amber-400">
                                {!readOnlyMode && <GripVertical className="h-3 w-3 cursor-grab text-slate-500" />}
                                Idea
                              </span>
                              <span className="text-slate-500">
                                {new Date(idea.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            <div className="mt-1 text-xs font-semibold text-slate-100">{idea.title}</div>
                            {idea.description && (
                              <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">{idea.description}</p>
                            )}
                            {repo && (
                              <div className="mt-2 inline-block rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-300">
                                Linked: {repo.name}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* 生命周期阶段 Kanban 列 */}
              {visibleColumns.map((col) => {
                const items = filteredEntries.filter(({ entry }) => entry.stage === col.id);
                return (
                  <div
                    key={col.id}
                    className="min-w-[270px] flex-1 space-y-2.5 rounded-xl border border-slate-800 bg-slate-950/60 p-3"
                  >
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-2 text-xs font-semibold">
                      <span className={col.accent}>{col.label}</span>
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                        {items.length}
                      </span>
                    </div>
                    <div className="space-y-2.5">
                      {items.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-slate-800/70 p-4 text-center text-[11px] text-slate-600">
                          暂无变更
                        </div>
                      ) : (
                        items.map(({ groupKey, entry }) => renderChangeCard(groupKey, entry))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {layoutMode === 'by-repo' && (
            <div className="space-y-4">
              {workspace.repos
                .filter((r) => selectedRepoId === 'all' || r.id === selectedRepoId)
                .map((repo) => {
                  const repoItems = filteredEntries.filter(({ entry }) => entry.repoId === repo.id);
                  const dotClass = repoColorMap.get(repo.id) ?? 'bg-sky-400';
                  return (
                    <div key={repo.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                      <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2 text-xs">
                        <div className="flex items-center gap-2 font-semibold text-slate-100">
                          <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
                          <span>{repo.name}</span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300">
                            {repo.role}
                          </span>
                        </div>
                        <span className="text-slate-400">{repoItems.length} 项变更</span>
                      </div>
                      {repoItems.length === 0 ? (
                        <div className="p-4 text-center text-xs text-slate-500">该仓库暂无匹配 Change</div>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                          {repoItems.map(({ groupKey, entry }) => renderChangeCard(groupKey, entry))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}

          {layoutMode === 'cross-repo' && (() => {
            const q = searchText.trim().toLowerCase();
            const repoLinks = (workspace.repoLinks ?? []).filter((link) => {
              if (selectedRepoId !== 'all' && !link.repoIds.includes(selectedRepoId)) return false;
              if (!q) return true;
              const linkedNames = link.repoIds
                .map((id) => workspace.repos.find((r) => r.id === id)?.name ?? '')
                .join(' ');
              return `${link.title} ${linkedNames}`.toLowerCase().includes(q);
            });

            return (
              <div className="space-y-4">
                {repoLinks.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-300">
                      跨仓项目关联组 ({repoLinks.length})
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {repoLinks.map((link) => {
                        const linkedRepos = link.repoIds
                          .map((id) => workspace.repos.find((r) => r.id === id))
                          .filter((r): r is NonNullable<typeof r> => Boolean(r));
                        const groupEntries = filteredEntries.filter((x) =>
                          link.repoIds.includes(x.entry.repoId),
                        );
                        const completed = groupEntries.reduce(
                          (sum, x) => sum + x.entry.progress.completed,
                          0,
                        );
                        const total = groupEntries.reduce(
                          (sum, x) => sum + x.entry.progress.total,
                          0,
                        );
                        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

                        return (
                          <div
                            key={link.id}
                            className="rounded-xl border border-slate-800 bg-slate-900/70 p-4"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <Link2 className="h-4 w-4 shrink-0 text-sky-400" />
                                <span className="truncate text-sm font-semibold text-slate-100">
                                  {link.title}
                                </span>
                                <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                                  项目关联组 ({linkedRepos.length} 仓)
                                </span>
                              </div>
                              {!readOnlyMode && (
                                <button
                                  type="button"
                                  title="解除跨仓项目关联"
                                  onClick={() =>
                                    void api.deleteRepoLink(workspace.id, link.id).then(onRefresh)
                                  }
                                  className="rounded p-1 text-slate-500 hover:text-rose-400"
                                >
                                  <Unlink className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>

                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                              {linkedRepos.map((repo) => {
                                const dotClass = repoColorMap.get(repo.id) ?? 'bg-sky-400';
                                const count = groupEntries.filter(
                                  (x) => x.entry.repoId === repo.id,
                                ).length;
                                return (
                                  <button
                                    key={repo.id}
                                    type="button"
                                    onClick={() => setSelectedRepoId(repo.id)}
                                    className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 hover:border-sky-500/60"
                                  >
                                    <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                                    <strong className="text-sky-400">[{repo.role}]</strong>
                                    <span>{repo.name}</span>
                                    <span className="text-slate-500">({count})</span>
                                  </button>
                                );
                              })}
                            </div>

                            <div className="mt-3 space-y-1">
                              <div className="flex justify-between text-xs text-slate-400">
                                <span>
                                  组内任务联合进度：{completed} / {total}
                                </span>
                                <span>{pct}%</span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                                <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                              </div>
                            </div>

                            {groupEntries.length > 0 && (
                              <div className="mt-3 flex flex-wrap gap-1.5">
                                {groupEntries.slice(0, 8).map(({ groupKey, entry }) => (
                                  <button
                                    key={`${entry.repoId}:${entry.archiveFolderName ?? entry.changeName}`}
                                    type="button"
                                    onClick={() => onOpenDetail(groupKey, entry.repoId)}
                                    className="rounded border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-300 hover:border-sky-500"
                                  >
                                    [{entry.repoRole}] {entry.changeName}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="grid gap-3 md:grid-cols-2">
                  {filteredGroups.length === 0 && repoLinks.length === 0 ? (
                    <div className="col-span-2 rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
                      暂无跨仓项目关联组或同名跨仓 Change，可点击右上角「关联跨仓项目」将多个协作仓库绑到一起
                    </div>
                  ) : (
                    filteredGroups.map((group) => {
                  const pct =
                    group.totalProgress.total > 0
                      ? Math.round((group.totalProgress.completed / group.totalProgress.total) * 100)
                      : 0;
                  const isGroupDrop = dragOverId === group.key && dragState?.kind === 'group';
                  return (
                    <div
                      key={group.key}
                      draggable={!readOnlyMode}
                      onDragStart={() => setDragState({ kind: 'group', id: group.key })}
                      onDragOver={(e) => {
                        if (dragState?.kind === 'group') {
                          e.preventDefault();
                          setDragOverId(group.key);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverId === group.key) setDragOverId(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        void handleDropReorder('group', group.key);
                      }}
                      onDragEnd={() => {
                        setDragState(null);
                        setDragOverId(null);
                      }}
                      onClick={() => onOpenDetail(group.key)}
                      className={`cursor-pointer rounded-xl border bg-slate-900/70 p-4 transition hover:border-sky-500 ${
                        isGroupDrop ? 'border-sky-400 ring-2 ring-sky-500/40' : 'border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 truncate">
                          {!readOnlyMode && <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-slate-500" />}
                          <Columns3 className="h-4 w-4 text-sky-400" />
                          <span className="truncate text-sm font-semibold text-slate-100">{group.title}</span>
                          {group.isManualLink && (
                            <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-300">
                              手动关联组
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                            {group.aggregateStatus === 'mixed'
                              ? '混合（部分归档）'
                              : group.aggregateStatus === 'all_archived'
                                ? '已归档'
                                : group.stage}
                          </span>
                          {!readOnlyMode && group.isManualLink && group.manualLinkId && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void api.deleteChangeLink(workspace.id, group.manualLinkId!).then(onRefresh);
                              }}
                              className="rounded p-1 text-slate-500 hover:text-rose-400"
                            >
                              <Unlink className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 space-y-1">
                        <div className="flex justify-between text-xs text-slate-400">
                          <span>
                            联合进度：{group.totalProgress.completed} / {group.totalProgress.total}
                          </span>
                          <span>{pct}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                          <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {group.entries.map((e) => (
                          <span
                            key={`${e.repoId}:${e.changeName}`}
                            className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-300"
                          >
                            <strong className="text-sky-400">[{e.repoRole}]</strong> {e.changeName} ({e.progress.completed}/{e.progress.total})
                            {e.archived ? ` · 归档 ${formatArchiveTime(e.archivedAt, e.archivedDate)}` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
                </div>
              </div>
            );
          })()}
        </>
      ) : boardTab === 'archive' ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search archived changes..."
                className="w-64 rounded-lg border border-slate-800 bg-slate-900 py-1.5 pl-8 pr-3 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <span className="text-xs text-slate-400">
              按归档时间倒序 · 共 {filteredArchivedEntries.length} 个已归档变更（点击卡片只读查看详情）
            </span>
          </div>

          {filteredArchivedEntries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
              当前筛选下暂无已归档变更（`openspec/changes/archive/`）
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredArchivedEntries.map(({ groupKey, entry }) => {
                const dotClass = repoColorMap.get(entry.repoId) ?? 'bg-sky-400';
                const pct =
                  entry.progress.total > 0
                    ? Math.round((entry.progress.completed / entry.progress.total) * 100)
                    : 0;
                return (
                  <div
                    key={`${entry.repoId}:${entry.archiveFolderName ?? entry.changeName}`}
                    onClick={() => onOpenDetail(groupKey, entry.repoId)}
                    className="cursor-pointer rounded-xl border border-slate-800 bg-slate-900/70 p-4 transition hover:border-sky-500"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300">
                          {entry.repoRole}
                        </span>
                        <span className="truncate text-xs text-slate-400">{entry.repoName}</span>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                        <Clock className="h-3 w-3" />
                        {formatArchiveTime(entry.archivedAt, entry.archivedDate)}
                      </span>
                    </div>

                    <div className="mt-2 truncate text-sm font-semibold text-slate-100">{entry.changeName}</div>
                    {entry.archiveFolderName && entry.archiveFolderName !== entry.changeName && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                        {entry.archiveFolderName}
                      </div>
                    )}
                    {entry.summary && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-400">{entry.summary}</p>
                    )}

                    <div className="mt-3 flex items-center justify-between border-t border-slate-800/80 pt-2.5 text-[11px] text-slate-400">
                      <span>
                        Tasks: {entry.progress.completed}/{entry.progress.total} ({pct}%)
                      </span>
                      <span>Delta Specs: {entry.deltaDiffs.length}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-4">
          <div className="space-y-1.5 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            {filteredSpecs.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-500">暂无主规范 `openspec/specs/`</div>
            ) : (
              filteredSpecs.map((spec) => {
                const active =
                  selectedMainSpec?.repoId === spec.repoId &&
                  selectedMainSpec?.capabilityPath === spec.capabilityPath;
                return (
                  <button
                    key={`${spec.repoId}:${spec.capabilityPath}`}
                    type="button"
                    onClick={() => setSelectedMainSpec(spec)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${
                      active ? 'bg-sky-600/20 text-sky-200 ring-1 ring-sky-500/50' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300">
                          {spec.repoRole}
                        </span>
                        <span className="truncate font-mono font-medium">{spec.capabilityPath}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-500">{spec.repoName}</div>
                    </div>
                    <span className="ml-2 shrink-0 text-[11px] text-slate-400">{spec.requirementCount} 条</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 lg:col-span-3">
            {selectedMainSpec ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-sky-400" />
                    <span className="font-mono text-sm font-semibold text-slate-100">
                      [{selectedMainSpec.repoRole}] {selectedMainSpec.capabilityPath}
                    </span>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> {selectedMainSpec.requirementCount} Requirements
                  </span>
                </div>
                <SpecHistoryPanel
                  key={`${selectedMainSpec.repoId}:${selectedMainSpec.capabilityPath}`}
                  repoId={selectedMainSpec.repoId}
                  capabilityPath={selectedMainSpec.capabilityPath}
                />
                <div className="max-h-[70vh] overflow-auto">
                  <MarkdownViewer
                    content={selectedMainSpec.rawContent}
                    title={`openspec/specs/${selectedMainSpec.capabilityPath}/spec.md`}
                  />
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-slate-500">选择左侧能力规范查看详情</div>
            )}
          </div>
        </div>
      )}

      {/* 关联跨仓项目（多仓库协同组）弹窗 */}
      {showLinkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">关联跨仓项目</h3>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  选择当前工作区中需要联动协作的 2 个及以上项目仓库；关联后将自动聚合进度并在 Change 的 Git 面板中联动展示。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowLinkModal(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block text-slate-400">跨仓项目组名称</label>
                <input
                  type="text"
                  value={linkTitle}
                  onChange={(e) => setLinkTitle(e.target.value)}
                  placeholder="例如：驾校系统（FE + BE）"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                />
              </div>
              <div className="max-h-60 space-y-1.5 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2">
                {workspace.repos.map((repo) => {
                  const checked = selectedRepoIds.includes(repo.id);
                  const dotClass = repoColorMap.get(repo.id) ?? 'bg-sky-400';
                  const activeCount = flatEntries.filter(
                    (x) => x.entry.repoId === repo.id && !x.entry.archived,
                  ).length;
                  return (
                    <label
                      key={repo.id}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-2 hover:bg-slate-900"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLinkRepo(repo.id)}
                        />
                        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                        <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-sky-300">
                          {repo.role}
                        </span>
                        <span className="truncate font-medium text-slate-200">{repo.name}</span>
                      </div>
                      <span className="shrink-0 text-[11px] text-slate-500">
                        {activeCount} active
                      </span>
                    </label>
                  );
                })}
              </div>
              {linkError && <div className="text-rose-400">{linkError}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowLinkModal(false)}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreateRepoLink()}
                  className="rounded-lg bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-500"
                >
                  保存项目关联
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
