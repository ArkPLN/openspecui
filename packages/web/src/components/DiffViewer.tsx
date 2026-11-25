/**
 * @file 只读代码 Diff 查看器组件
 * @description 支持 Unified（统一）与 Split（左右对照）两种视图，展示未提交工作区或历史 Commit 的文件差异。
 * @author ypc
 */

import type { GitDiffResult, GitFileDiff } from '@openspecui/shared';
import { Columns2, FileCode2, Rows2 } from 'lucide-react';
import { useState } from 'react';

interface DiffViewerProps {
  diff: GitDiffResult | null;
  loading?: boolean;
  title?: string;
}

interface SplitRow {
  left?: string;
  right?: string;
  leftType: 'context' | 'del' | 'empty' | 'hunk';
  rightType: 'context' | 'add' | 'empty' | 'hunk';
}

function buildSplitRows(patch: string): SplitRow[] {
  const lines = patch.split(/\r?\n/);
  const rows: SplitRow[] = [];
  let delQueue: string[] = [];
  let addQueue: string[] = [];

  const flushQueues = () => {
    const maxLen = Math.max(delQueue.length, addQueue.length);
    for (let i = 0; i < maxLen; i += 1) {
      rows.push({
        left: delQueue[i],
        right: addQueue[i],
        leftType: delQueue[i] !== undefined ? 'del' : 'empty',
        rightType: addQueue[i] !== undefined ? 'add' : 'empty',
      });
    }
    delQueue = [];
    addQueue = [];
  };

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode')
    ) {
      continue;
    }
    if (line.startsWith('@@')) {
      flushQueues();
      rows.push({ left: line, right: line, leftType: 'hunk', rightType: 'hunk' });
      continue;
    }
    if (line.startsWith('-')) {
      delQueue.push(line.slice(1));
      continue;
    }
    if (line.startsWith('+')) {
      addQueue.push(line.slice(1));
      continue;
    }
    flushQueues();
    const content = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({ left: content, right: content, leftType: 'context', rightType: 'context' });
  }
  flushQueues();
  return rows;
}

const STATUS_BADGE: Record<GitFileDiff['status'], string> = {
  added: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  modified: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  deleted: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  renamed: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  binary: 'bg-slate-700/60 text-slate-300 border-slate-600',
};

export function DiffViewer({ diff, loading = false, title }: DiffViewerProps) {
  const [mode, setMode] = useState<'unified' | 'split'>('unified');

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
        正在加载代码 Diff...
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/30 p-6 text-center text-sm text-slate-500">
        点击左侧的未提交工作区或任意 Commit 查看代码变更详情（只读）
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2">
        <div className="flex items-center gap-2 text-sm">
          <FileCode2 className="h-4 w-4 text-sky-400" />
          <span className="font-medium text-slate-200">{title ?? diff.target}</span>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
            {diff.files.length} 个文件
          </span>
          {diff.truncated && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
              文件数超上限，仅展示部分
            </span>
          )}
        </div>
        <div className="flex items-center rounded-md border border-slate-700 bg-slate-950 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode('unified')}
            className={`flex items-center gap-1 rounded px-2 py-1 ${
              mode === 'unified' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Rows2 className="h-3.5 w-3.5" /> Unified
          </button>
          <button
            type="button"
            onClick={() => setMode('split')}
            className={`flex items-center gap-1 rounded px-2 py-1 ${
              mode === 'split' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Columns2 className="h-3.5 w-3.5" /> Split
          </button>
        </div>
      </div>

      {diff.files.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
          当前目标没有可展示的文本差异
        </div>
      ) : (
        diff.files.map((file) => (
          <div key={file.path} className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs">
              <span className="font-mono text-slate-200">{file.path}</span>
              <div className="flex items-center gap-2">
                {file.truncated && <span className="text-amber-400">内容已截断</span>}
                <span className={`rounded border px-1.5 py-0.5 uppercase ${STATUS_BADGE[file.status]}`}>
                  {file.status}
                </span>
              </div>
            </div>

            {mode === 'unified' || file.status === 'binary' ? (
              <pre className="max-h-96 overflow-auto p-3 text-xs leading-5">
                {file.patch.split(/\r?\n/).map((line, idx) => {
                  const cls = line.startsWith('+') && !line.startsWith('+++')
                    ? 'bg-emerald-950/60 text-emerald-300'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'bg-rose-950/60 text-rose-300'
                      : line.startsWith('@@')
                        ? 'bg-sky-950/60 text-sky-300'
                        : 'text-slate-300';
                  return (
                    <div key={idx} className={`px-1 ${cls}`}>
                      {line || ' '}
                    </div>
                  );
                })}
              </pre>
            ) : (
              <div className="max-h-96 overflow-auto text-xs leading-5">
                <table className="w-full table-fixed border-collapse font-mono">
                  <tbody>
                    {buildSplitRows(file.patch).map((row, idx) => (
                      <tr key={idx} className="border-b border-slate-900/60">
                        <td
                          className={`w-1/2 whitespace-pre-wrap break-all px-2 py-0.5 align-top ${
                            row.leftType === 'del'
                              ? 'bg-rose-950/60 text-rose-300'
                              : row.leftType === 'hunk'
                                ? 'bg-sky-950/50 text-sky-300'
                                : row.leftType === 'empty'
                                  ? 'bg-slate-900/30'
                                  : 'text-slate-300'
                          }`}
                        >
                          {row.left ?? ''}
                        </td>
                        <td
                          className={`w-1/2 whitespace-pre-wrap break-all border-l border-slate-800 px-2 py-0.5 align-top ${
                            row.rightType === 'add'
                              ? 'bg-emerald-950/60 text-emerald-300'
                              : row.rightType === 'hunk'
                                ? 'bg-sky-950/50 text-sky-300'
                                : row.rightType === 'empty'
                                  ? 'bg-slate-900/30'
                                  : 'text-slate-300'
                          }`}
                        >
                          {row.right ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
