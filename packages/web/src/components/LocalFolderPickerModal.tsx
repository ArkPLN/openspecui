/**
 * @file 本机文件夹浏览选择器弹窗组件
 * @description 通过只读服务端目录枚举接口浏览本机盘符与子目录，带 OpenSpec/Git 标记并回填选中绝对路径。
 * @author ypc
 */

import type { DirectoryBrowseResult } from '@openspecui/shared';
import { ArrowUp, Check, Folder, HardDrive, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface LocalFolderPickerModalProps {
  initialPath?: string;
  onSelect: (selectedPath: string) => void;
  onClose: () => void;
}

export function LocalFolderPickerModal({
  initialPath,
  onSelect,
  onClose,
}: LocalFolderPickerModalProps) {
  useEscapeKey(onClose);
  const [data, setData] = useState<DirectoryBrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const navigateTo = async (targetPath?: string) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.browseDirs(targetPath);
      setData(res);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void navigateTo(initialPath?.trim() || undefined);
  }, [initialPath]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Folder className="h-4 w-4 text-sky-400" />
            <span>浏览本机文件夹</span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4 text-xs">
          {/* 盘符快捷入口 */}
          {data && data.roots.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-slate-500">磁盘：</span>
              {data.roots.map((root) => (
                <button
                  key={root}
                  type="button"
                  onClick={() => void navigateTo(root)}
                  className="flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-300 hover:border-sky-500 hover:text-sky-300"
                >
                  <HardDrive className="h-3 w-3" /> {root}
                </button>
              ))}
            </div>
          )}

          {/* 当前路径与返回上一级 */}
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5">
            <button
              type="button"
              disabled={!data?.parentPath || loading}
              onClick={() => data?.parentPath && void navigateTo(data.parentPath)}
              className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              <ArrowUp className="h-3 w-3" /> 上一级
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-slate-300">
              {data?.currentPath ?? '本机磁盘列表'}
            </span>
          </div>

          {errorMsg && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-rose-300">
              {errorMsg}
            </div>
          )}

          {/* 目录内容列表 */}
          <div className="h-64 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-1.5">
            {loading ? (
              <div className="p-8 text-center text-slate-500">正在读取目录...</div>
            ) : !data || data.entries.length === 0 ? (
              <div className="p-8 text-center text-slate-500">当前目录下没有子文件夹</div>
            ) : (
              data.entries.map((entry) => (
                <div
                  key={entry.path}
                  className="flex items-center justify-between rounded-md px-2.5 py-1.5 hover:bg-slate-900"
                >
                  <button
                    type="button"
                    onClick={() => void navigateTo(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Folder
                      className={`h-4 w-4 shrink-0 ${
                        entry.hasOpenSpec ? 'text-emerald-400' : 'text-sky-400'
                      }`}
                    />
                    <span className="truncate text-slate-200">{entry.name}</span>
                    {entry.hasOpenSpec && (
                      <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        OpenSpec
                      </span>
                    )}
                    {entry.hasGit && (
                      <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">
                        Git
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(entry.path);
                      onClose();
                    }}
                    className="ml-2 shrink-0 rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-sky-500 hover:bg-sky-600 hover:text-white"
                  >
                    选中
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3 text-xs">
          <span className="text-slate-500">提示：点击文件夹名进入下级，点击右侧“选中”直接填入</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!data?.currentPath}
              onClick={() => {
                if (data?.currentPath) {
                  onSelect(data.currentPath);
                  onClose();
                }
              }}
              className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" /> 选择当前目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
