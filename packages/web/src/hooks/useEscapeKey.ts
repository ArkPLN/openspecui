/**
 * @file 通用 Esc 键关闭弹窗 Hook
 * @description 抽取公共键盘监听方法，支持通过 enabled 控制嵌套弹窗仅关闭最顶层。
 * @author ypc
 */

import { useEffect } from 'react';

/**
 * 监听 Esc 键并在启用状态下触发关闭回调。
 *
 * @param onEscape 关闭回调
 * @param enabled 是否启用（嵌套弹窗存在时外层传入 false）
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onEscape, enabled]);
}
