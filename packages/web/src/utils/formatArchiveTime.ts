/**
 * @file 归档时间格式化与排序工具
 * @description 统一格式化 Change 的归档目录日期与文件时间戳，供看板卡片、Archive 列表及详情头部复用。
 * @author ypc
 */

import type { RepoChangeEntry } from '@openspecui/shared';

function padTwo(num: number): string {
  return String(num).padStart(2, '0');
}

function formatLocalDateTime(date: Date): { datePart: string; fullPart: string } {
  const year = date.getFullYear();
  const month = padTwo(date.getMonth() + 1);
  const day = padTwo(date.getDate());
  const hour = padTwo(date.getHours());
  const minute = padTwo(date.getMinutes());
  const datePart = `${year}-${month}-${day}`;
  return {
    datePart,
    fullPart: `${datePart} ${hour}:${minute}`,
  };
}

/**
 * 格式化展示归档时间：优先合并目录日期前缀与精确时间点，避免无前缀或跨日克隆时丢失信息
 */
export function formatArchiveTime(archivedAt?: string, archivedDate?: string): string {
  if (archivedAt) {
    const parsed = new Date(archivedAt);
    if (!Number.isNaN(parsed.getTime())) {
      const { datePart, fullPart } = formatLocalDateTime(parsed);
      if (archivedDate && archivedDate !== datePart) {
        return `${archivedDate}（${fullPart}）`;
      }
      return fullPart;
    }
  }
  if (archivedDate) {
    return archivedDate;
  }
  return '未知时间';
}

/**
 * 计算归档条目排序用的毫秒时间戳（优先使用精确 mtime，其次使用目录日期前缀）
 */
export function getArchiveSortTimestamp(entry: Pick<RepoChangeEntry, 'archivedAt' | 'archivedDate'>): number {
  if (entry.archivedAt) {
    const ms = Date.parse(entry.archivedAt);
    if (!Number.isNaN(ms)) return ms;
  }
  if (entry.archivedDate) {
    const ms = Date.parse(entry.archivedDate);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

/**
 * 已归档条目倒序比较器：
 * 1. 优先比较归档目录业务日期 `archivedDate`（倒序，避免 Git 克隆重写文件 mtime 导致错序）
 * 2. 同日或均无日期前缀时比较 `archivedAt` 文件时间戳（倒序）
 * 3. 兜底比较目录名 / Change 名（倒序）
 */
export function compareArchivedEntriesDesc(
  a: Pick<RepoChangeEntry, 'archivedDate' | 'archivedAt' | 'archiveFolderName' | 'changeName'>,
  b: Pick<RepoChangeEntry, 'archivedDate' | 'archivedAt' | 'archiveFolderName' | 'changeName'>,
): number {
  if (a.archivedDate && b.archivedDate && a.archivedDate !== b.archivedDate) {
    return b.archivedDate.localeCompare(a.archivedDate);
  }
  if (Boolean(a.archivedDate) !== Boolean(b.archivedDate)) {
    return a.archivedDate ? -1 : 1;
  }
  const timeDiff = getArchiveSortTimestamp(b) - getArchiveSortTimestamp(a);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  const nameA = a.archiveFolderName ?? a.changeName;
  const nameB = b.archiveFolderName ?? b.changeName;
  return nameB.localeCompare(nameA);
}
