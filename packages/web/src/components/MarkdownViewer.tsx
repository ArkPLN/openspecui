/**
 * @file 安全 Markdown 渲染组件
 * @description 使用 react-markdown + remark-gfm 渲染 Proposal、Design 与 Spec 文档（不解析原始 HTML，防御 XSS），支持切换源码视图。
 * @author ypc
 */

import type { TaskItem } from '@openspecui/shared';
import { Check, Code2, Eye } from 'lucide-react';
import { Children, isValidElement, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownTaskToggleOptions {
  items: TaskItem[];
  disabled?: boolean;
  togglingLineNumber?: number | null;
  onToggle: (item: TaskItem) => void;
}

interface MarkdownViewerProps {
  content: string;
  title?: string;
  defaultRaw?: boolean;
  /** 顶栏左侧或中部附加信息徽标（例如任务进度、只读状态提示） */
  headerExtra?: ReactNode;
  /** 可选：启用 GFM 任务列表交互勾选回写 */
  taskToggle?: MarkdownTaskToggleOptions;
  /** 可选：拦截文档内相对超链接点击，返回 true 表示已由宿主容器接管导航 */
  onNavigateLink?: (href: string) => boolean | void;
}

/**
 * 递归提取 React 节点中的纯文本，用于生成与 GitHub/Markdown 一致的标题锚点
 */
function extractNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractNodeText).join('');
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractNodeText(node.props.children);
  }
  return Children.toArray(node).map(extractNodeText).join('');
}

/**
 * 将标题文本转换为稳定 URL 锚点 slug（保留中文、英文、数字与连字符）
 */
export function headingTextToSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u002c\u002e\u002f\u003a-\u0040\u005b-\u005e\u0060\u007b-\u007f]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href.trim());
}

export function MarkdownViewer({
  content,
  title,
  defaultRaw = false,
  headerExtra,
  taskToggle,
  onNavigateLink,
}: MarkdownViewerProps) {
  const [showRaw, setShowRaw] = useState(defaultRaw);
  const containerRef = useRef<HTMLDivElement>(null);

  const taskByLine = useMemo(() => {
    const map = new Map<number, TaskItem>();
    if (taskToggle) {
      for (const item of taskToggle.items) {
        map.set(item.lineNumber, item);
      }
    }
    return map;
  }, [taskToggle]);

  const scrollToLocalHash = (hash: string) => {
    const rawTarget = hash.replace(/^#/, '').trim();
    if (!rawTarget) return false;
    let decoded = rawTarget;
    try {
      decoded = decodeURIComponent(rawTarget);
    } catch {
      // 保留原始字符串兜底匹配
    }
    const slugTarget = headingTextToSlug(decoded);
    const root = containerRef.current ?? document;
    const candidates = root.querySelectorAll<HTMLElement>('[id]');
    for (const el of candidates) {
      if (el.id === decoded || el.id === rawTarget || el.id === slugTarget) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      }
    }
    return false;
  };

  return (
    <div ref={containerRef} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-4 py-2 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-slate-400">{title ?? 'Markdown'}</span>
          {headerExtra}
        </div>
        <div className="flex shrink-0 items-center rounded-md border border-slate-700 bg-slate-950 p-0.5">
          <button
            type="button"
            onClick={() => setShowRaw(false)}
            className={`flex items-center gap-1 rounded px-2 py-0.5 ${
              !showRaw ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Eye className="h-3 w-3" /> 渲染
          </button>
          <button
            type="button"
            onClick={() => setShowRaw(true)}
            className={`flex items-center gap-1 rounded px-2 py-0.5 ${
              showRaw ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code2 className="h-3 w-3" /> 源码
          </button>
        </div>
      </div>

      {showRaw ? (
        <pre className="overflow-auto whitespace-pre-wrap p-5 text-xs leading-6 text-slate-300">
          {content}
        </pre>
      ) : (
        <div className="p-5 text-sm leading-7 text-slate-200">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => {
                const id = headingTextToSlug(extractNodeText(children)) || undefined;
                return (
                  <h1 id={id} className="mb-4 scroll-mt-4 border-b border-slate-800 pb-2 text-xl font-bold text-slate-100">
                    {children}
                  </h1>
                );
              },
              h2: ({ children }) => {
                const id = headingTextToSlug(extractNodeText(children)) || undefined;
                return (
                  <h2 id={id} className="mb-3 mt-6 scroll-mt-4 border-b border-slate-800/70 pb-1.5 text-base font-semibold text-sky-300">
                    {children}
                  </h2>
                );
              },
              h3: ({ children }) => {
                const id = headingTextToSlug(extractNodeText(children)) || undefined;
                return (
                  <h3 id={id} className="mb-2 mt-4 scroll-mt-4 text-sm font-semibold text-slate-100">
                    {children}
                  </h3>
                );
              },
              h4: ({ children }) => {
                const id = headingTextToSlug(extractNodeText(children)) || undefined;
                return (
                  <h4 id={id} className="mb-1.5 mt-3 scroll-mt-4 text-xs font-semibold uppercase tracking-wide text-emerald-300">
                    {children}
                  </h4>
                );
              },
              p: ({ children }) => <p className="mb-3 text-slate-300">{children}</p>,
              ul: ({ className, children }) => {
                const isTaskList = className?.includes('contains-task-list');
                return (
                  <ul
                    className={
                      isTaskList
                        ? 'mb-3 list-none space-y-1.5 pl-0 text-slate-200'
                        : 'mb-3 list-disc space-y-1 pl-5 text-slate-300'
                    }
                  >
                    {children}
                  </ul>
                );
              },
              ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 text-slate-300">{children}</ol>,
              li: ({ className, children }) => {
                const isTaskItem = className?.includes('task-list-item');
                return (
                  <li className={isTaskItem ? 'relative list-none pl-6 leading-7' : 'leading-6'}>
                    {children}
                  </li>
                );
              },
              input: ({ node, type, checked }) => {
                if (type !== 'checkbox') {
                  return <input type={type} checked={checked} readOnly />;
                }
                const lineNumber = node?.position?.start?.line;
                const matchedItem = lineNumber ? taskByLine.get(lineNumber) : undefined;
                const isChecked = matchedItem ? matchedItem.checked : Boolean(checked);
                const isToggling = Boolean(
                  taskToggle && lineNumber && taskToggle.togglingLineNumber === lineNumber,
                );
                const isDisabled =
                  !taskToggle || !matchedItem || Boolean(taskToggle.disabled) || isToggling;

                return (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isChecked}
                    disabled={isDisabled}
                    onClick={() => {
                      if (matchedItem && !isDisabled && taskToggle) {
                        taskToggle.onToggle(matchedItem);
                      }
                    }}
                    title={
                      isDisabled
                        ? isChecked
                          ? '已完成（只读）'
                          : '只读状态不可修改'
                        : isChecked
                          ? '点击标记为未完成'
                          : '点击标记为已完成'
                    }
                    className={`absolute left-0 top-[6px] inline-flex h-4 w-4 items-center justify-center rounded-[4px] border transition ${
                      isChecked
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : 'border-slate-500 bg-transparent text-transparent'
                    } ${
                      isDisabled
                        ? 'cursor-not-allowed opacity-85'
                        : 'cursor-pointer hover:border-sky-400'
                    } ${isToggling ? 'animate-pulse' : ''}`}
                  >
                    {isChecked && <Check className="h-3 w-3 stroke-[3]" />}
                  </button>
                );
              },
              blockquote: ({ children }) => (
                <blockquote className="my-3 border-l-2 border-sky-500 bg-slate-900/50 px-3 py-1.5 text-slate-300">
                  {children}
                </blockquote>
              ),
              code: ({ className, children }) => {
                const isBlock = Boolean(className);
                if (isBlock) {
                  return (
                    <code className="block overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 font-mono text-xs leading-5 text-slate-200">
                      {children}
                    </code>
                  );
                }
                return (
                  <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-sky-300">
                    {children}
                  </code>
                );
              },
              pre: ({ children }) => <pre className="my-3 overflow-x-auto">{children}</pre>,
              table: ({ children }) => (
                <div className="my-3 overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full border-collapse text-left text-xs">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border-b border-slate-800 bg-slate-900 px-3 py-2 font-semibold text-slate-200">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border-b border-slate-800/60 px-3 py-2 text-slate-300">{children}</td>
              ),
              a: ({ href, children }) => {
                const rawHref = (href ?? '').trim();
                const external = isExternalHref(rawHref);
                return (
                  <a
                    href={href}
                    target={external ? '_blank' : undefined}
                    rel={external ? 'noopener noreferrer' : undefined}
                    title={external ? rawHref : `文档内链接: ${rawHref}`}
                    onClick={(event) => {
                      if (external || !rawHref) return;
                      // 纯页内锚点直接在当前 Markdown 容器中平滑定位
                      if (rawHref.startsWith('#')) {
                        event.preventDefault();
                        scrollToLocalHash(rawHref);
                        return;
                      }
                      // 交由宿主容器（如 ChangeDetailView）解析并切换 Tab；非外链均阻止浏览器误跳 SPA 根路径
                      event.preventDefault();
                      onNavigateLink?.(rawHref);
                    }}
                    className="cursor-pointer text-sky-400 underline hover:text-sky-300"
                  >
                    {children}
                  </a>
                );
              },
              hr: () => <hr className="my-4 border-slate-800" />,
            }}
          >
            {content}
          </Markdown>
        </div>
      )}
    </div>
  );
}
