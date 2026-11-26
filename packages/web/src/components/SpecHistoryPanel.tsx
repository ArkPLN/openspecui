/**
 * @file 主规范（Spec）作者、贡献者与 Requirement 级演进历史面板
 * @description 在「Specs 规范库」选中某条主规范时按需懒加载其 Git 演进记录，展示创建者、去重贡献者与每次提交的追加/修改/重命名/移除功能点清单。
 * @author ypc
 */

import type {
  SpecContributorSummary,
  SpecHistoryResponse,
  SpecRequirementChangeItem,
  SpecRevisionEntry,
} from '@openspecui/shared';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCommitHorizontal,
  History,
  Info,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  UserCheck,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';

interface SpecHistoryPanelProps {
  repoId: string;
  capabilityPath: string;
}

/** 格式化 ISO 提交时间为紧凑中文时间 */
function formatCommitDate(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return iso;
  }
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 渲染单个贡献者标签及其语义变更计数 */
function ContributorBadge({ contributor }: { contributor: SpecContributorSummary }) {
  const hasRemoved = contributor.removedCount > 0;
  return (
    <div
      title={contributor.authorEmail ? `${contributor.authorName} <${contributor.authorEmail}>` : contributor.authorName}
      className={`inline-flex flex-wrap items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] ${
        hasRemoved
          ? 'border-rose-500/40 bg-rose-950/25 text-slate-200'
          : contributor.isCreator
            ? 'border-sky-500/40 bg-sky-950/30 text-slate-200'
            : 'border-slate-700 bg-slate-950/70 text-slate-300'
      }`}
    >
      {contributor.isCreator ? (
        <span className="inline-flex items-center gap-1 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
          <Sparkles className="h-2.5 w-2.5" />
          创建者
        </span>
      ) : null}
      <span className="font-medium text-slate-100">{contributor.authorName}</span>
      <span className="text-[10px] text-slate-400">({contributor.commitCount} 次)</span>
      {contributor.addedCount > 0 && (
        <span className="rounded bg-emerald-950/70 px-1.5 py-0.5 text-[10px] text-emerald-300">
          +{contributor.addedCount} 新增
        </span>
      )}
      {contributor.modifiedCount > 0 && (
        <span className="rounded bg-sky-950/70 px-1.5 py-0.5 text-[10px] text-sky-300">
          ~{contributor.modifiedCount} 修改
        </span>
      )}
      {contributor.renamedCount > 0 && (
        <span className="rounded bg-violet-950/70 px-1.5 py-0.5 text-[10px] text-violet-300">
          &gt;{contributor.renamedCount} 重命名
        </span>
      )}
      {contributor.removedCount > 0 && (
        <span className="rounded bg-rose-950/80 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
          -{contributor.removedCount} 移除
        </span>
      )}
    </div>
  );
}

/** 渲染单条 Requirement 变更清单项 */
function RequirementChangeRow({ item }: { item: SpecRequirementChangeItem }) {
  if (item.operation === 'REMOVED') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-rose-500/35 bg-rose-950/35 px-2.5 py-1.5 text-[11px] text-rose-300">
        <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
        <div className="min-w-0 flex-1">
          <span className="mr-1.5 font-semibold">[移除功能点]</span>
          <span className="font-medium break-all">{item.name}</span>
        </div>
      </div>
    );
  }
  if (item.operation === 'ADDED') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-950/30 px-2.5 py-1.5 text-[11px] text-emerald-300">
        <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <span className="mr-1.5 font-semibold">[追加功能点]</span>
          <span className="font-medium break-all">{item.name}</span>
        </div>
      </div>
    );
  }
  if (item.operation === 'RENAMED') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-violet-500/30 bg-violet-950/30 px-2.5 py-1.5 text-[11px] text-violet-300">
        <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <span className="mr-1.5 font-semibold">[重命名]</span>
          <span className="line-through opacity-75 break-all">{item.fromName}</span>
          <span className="mx-1.5 text-slate-400">-&gt;</span>
          <span className="font-medium break-all">{item.name}</span>
          {item.matchSource === 'delta' ? (
            <span className="ml-2 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200">
              Delta 声明
            </span>
          ) : item.similarity !== undefined ? (
            <span className="ml-2 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200">
              相似度 {item.similarity}%
            </span>
          ) : null}
        </div>
      </div>
    );
  }
  if (item.operation === 'MODIFIED') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-sky-500/25 bg-sky-950/25 px-2.5 py-1.5 text-[11px] text-sky-300">
        <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <span className="mr-1.5 font-semibold">[修改功能点]</span>
          <span className="font-medium break-all">{item.name}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-slate-700 bg-slate-900/80 px-2.5 py-1.5 text-[11px] text-slate-300">
      <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
      <div className="min-w-0 flex-1">
        <span className="mr-1.5 font-semibold text-emerald-300">[初始创建]</span>
        <span className="font-medium break-all">{item.name}</span>
      </div>
    </div>
  );
}

/** 渲染单次提交演进卡片（含默认展开或可折叠的 Requirement 变更清单） */
function RevisionItem({
  revision,
  currentPath,
}: {
  revision: SpecRevisionEntry;
  currentPath: string;
}) {
  // 含“移除”或增删变动（非超长初始创建）时默认展开清单，初始大清单超过 5 条默认折叠以节省高度
  const isLargeInitial =
    revision.operations.length === 1 &&
    revision.operations[0] === 'CREATED' &&
    revision.changes.length > 5;
  const [expanded, setExpanded] = useState(!isLargeInitial);

  const hasRemoved = revision.counts.removed > 0;
  const pathMoved = revision.filePathAtCommit && revision.filePathAtCommit !== currentPath;

  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${
        hasRemoved
          ? 'border-rose-500/40 bg-rose-950/20'
          : 'border-slate-800 bg-slate-950/60'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            title={expanded ? '收起功能点清单' : '展开功能点清单'}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-sky-300">
            {revision.shortSha}
          </span>
          <span className="font-medium text-slate-100">{revision.authorName}</span>
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
            <Clock className="h-3 w-3" />
            {formatCommitDate(revision.committedAt)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          {!revision.analyzed ? (
            <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-slate-400">
              未拉取快照
            </span>
          ) : (
            <>
              {revision.counts.created > 0 && (
                <span className="rounded border border-emerald-500/30 bg-emerald-950/50 px-1.5 py-0.5 text-emerald-300">
                  初始 {revision.counts.created} 条
                </span>
              )}
              {revision.counts.added > 0 && (
                <span className="rounded border border-emerald-500/30 bg-emerald-950/50 px-1.5 py-0.5 text-emerald-300">
                  +{revision.counts.added} 追加
                </span>
              )}
              {revision.counts.modified > 0 && (
                <span className="rounded border border-sky-500/30 bg-sky-950/50 px-1.5 py-0.5 text-sky-300">
                  ~{revision.counts.modified} 修改
                </span>
              )}
              {revision.counts.renamed > 0 && (
                <span className="rounded border border-violet-500/30 bg-violet-950/50 px-1.5 py-0.5 text-violet-300">
                  &gt;{revision.counts.renamed} 重命名
                </span>
              )}
              {revision.counts.removed > 0 && (
                <span className="inline-flex items-center gap-1 rounded border border-rose-500/50 bg-rose-950/70 px-1.5 py-0.5 font-semibold text-rose-300">
                  <AlertTriangle className="h-2.5 w-2.5" />-{revision.counts.removed} 移除以前功能点
                </span>
              )}
              {revision.operations.includes('DOCS_UPDATED') && (
                <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-slate-300">
                  仅文档/背景修订
                </span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mt-1 pl-6 text-xs text-slate-300">{revision.subject}</div>
      {pathMoved && (
        <div className="mt-1 pl-6 font-mono text-[10px] text-slate-400">
          历史路径: {revision.filePathAtCommit}
        </div>
      )}

      {expanded && revision.analyzed && (
        <div className="mt-2 space-y-1.5 pl-6">
          {revision.changes.length === 0 ? (
            <div className="text-[11px] text-slate-400">本次提交未增删或修改 Requirement 条目（仅调整 Purpose 或排版）。</div>
          ) : (
            revision.changes.map((item, idx) => (
              <RequirementChangeRow key={`${revision.sha}-${item.operation}-${item.name}-${idx}`} item={item} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SpecHistoryPanel({ repoId, capabilityPath }: SpecHistoryPanelProps) {
  const [limit, setLimit] = useState(20);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SpecHistoryResponse | null>(null);
  const [timelineExpanded, setTimelineExpanded] = useState(true);

  useEffect(() => {
    setLimit(20);
  }, [repoId, capabilityPath]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getSpecHistory(repoId, capabilityPath, limit)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError((err as Error).message || '加载 Spec 演进历史失败');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, capabilityPath, limit, reloadSeq]);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <History className="h-3.5 w-3.5 text-sky-400" />
          <span>作者与功能点演进追溯</span>
          {data?.isGitRepo && data.totalCommits > 0 && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-400">
              共 {data.totalCommits} 次提交 · {data.contributors.length} 位贡献者
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data?.isGitRepo && data.revisions.length > 0 && (
            <button
              type="button"
              onClick={() => setTimelineExpanded((v) => !v)}
              className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              {timelineExpanded ? '收起演进清单' : `展开演进清单 (${data.revisions.length})`}
            </button>
          )}
          <button
            type="button"
            onClick={() => setReloadSeq((s) => s + 1)}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            title="重新查询该 Spec 的 Git 历史"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="mt-2.5 flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
          <span>正在分析 Git 提交历史与 Requirement 语义变更...</span>
        </div>
      ) : error ? (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-lg border border-rose-500/35 bg-rose-950/35 px-3 py-2 text-xs text-rose-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setReloadSeq((s) => s + 1)}
            className="rounded bg-rose-500/20 px-2 py-0.5 text-[11px] hover:bg-rose-500/30"
          >
            重试
          </button>
        </div>
      ) : data && (!data.isGitRepo || data.unavailableReason) ? (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs text-slate-400">
          <Info className="h-3.5 w-3.5 shrink-0 text-sky-400" />
          <span>{data.unavailableReason || '暂无 Git 提交历史记录'}</span>
        </div>
      ) : data ? (
        <div className="mt-2.5 space-y-3">
          {/* 创建者与全部去重贡献者汇总栏 */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
              {data.creator && (
                <span className="inline-flex items-center gap-1 text-slate-200">
                  <UserCheck className="h-3.5 w-3.5 text-sky-400" />
                  创建者：<strong className="font-semibold">{data.creator.authorName}</strong>
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5 text-slate-400" />
                全部贡献者（按邮箱去重）：
              </span>
              {data.truncated && (
                <span className="text-[10px] text-amber-300">
                  当前仅分析最近 {data.analyzedCommits} 次提交快照（共 {data.totalCommits} 次）
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.contributors.map((contributor) => (
                <ContributorBadge key={contributor.contributorKey} contributor={contributor} />
              ))}
            </div>
          </div>

          {/* 逆序演进时间线与功能点清单 */}
          {timelineExpanded && (
            <div className="max-h-[340px] space-y-2 overflow-auto pr-1">
              {data.revisions.map((revision) => (
                <RevisionItem
                  key={revision.sha}
                  revision={revision}
                  currentPath={data.specFilePath}
                />
              ))}
              {data.truncated && limit < 40 && (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={() => setLimit(40)}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 text-[11px] text-sky-300 hover:bg-slate-800"
                  >
                    加载更多早期提交（最多分析最近 40 次）
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="text-[10px] text-slate-500">
            注：基于 Git 提交历史与 Requirement 块级语义对比生成；重命名优先读取归档 Delta 声明，兜底按正文相似度自动识别。
          </div>
        </div>
      ) : null}
    </div>
  );
}
