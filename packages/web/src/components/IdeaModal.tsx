/**
 * @file 工作区轻量 Idea 弹窗组件
 * @description 支持创建、查看、编辑和删除工作区内的本地 Idea，可选关联具体仓库。
 * @author ypc
 */

import type { RepoBinding, WorkspaceIdea } from '@openspecui/shared';
import { Lightbulb, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface IdeaModalProps {
  workspaceId: string;
  repos: RepoBinding[];
  idea?: WorkspaceIdea | null;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function IdeaModal({
  workspaceId,
  repos,
  idea,
  readOnly = false,
  onClose,
  onSaved,
}: IdeaModalProps) {
  useEscapeKey(onClose);
  const [repoId, setRepoId] = useState(idea?.repoId ?? '');
  const [title, setTitle] = useState(idea?.title ?? '');
  const [description, setDescription] = useState(idea?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSave = async () => {
    if (readOnly) return;
    if (!title.trim()) {
      setErrorMsg('请输入 Idea 标题');
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    try {
      if (idea) {
        await api.updateIdea(workspaceId, idea.id, {
          repoId: repoId || null,
          title: title.trim(),
          description: description.trim(),
        });
      } else {
        await api.createIdea(workspaceId, {
          repoId: repoId || undefined,
          title: title.trim(),
          description: description.trim(),
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!idea || readOnly) return;
    setSaving(true);
    try {
      await api.deleteIdea(workspaceId, idea.id);
      onSaved();
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Lightbulb className="h-4 w-4 text-amber-400" />
            <span>{idea ? 'Idea 详情' : '记录新 Idea'}</span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5 text-xs">
          <div>
            <label className="mb-1 block text-slate-400">关联仓库（可选）</label>
            <select
              disabled={readOnly}
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200"
            >
              <option value="">不限定仓库（工作区级灵感）</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  [{r.role}] {r.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-slate-400">标题</label>
            <input
              type="text"
              disabled={readOnly}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：支持一键导出静态规范文档"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            />
          </div>

          <div>
            <label className="mb-1 block text-slate-400">描述</label>
            <textarea
              rows={4}
              disabled={readOnly}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="补充背景、约束或初步思路..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            />
          </div>

          {idea && (
            <div className="text-[11px] text-slate-500">
              创建时间：{new Date(idea.createdAt).toLocaleString()}
            </div>
          )}

          {errorMsg && <div className="text-rose-400">{errorMsg}</div>}
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 px-5 py-3 text-xs">
          <div>
            {idea && !readOnly && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleDelete()}
                className="flex items-center gap-1 rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-rose-300 hover:bg-rose-950/50"
              >
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            >
              关闭
            </button>
            {!readOnly && (
              <button
                type="button"
                disabled={saving || !title.trim()}
                onClick={() => void handleSave()}
                className="rounded-lg bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存 Idea'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
