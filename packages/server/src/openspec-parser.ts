/**
 * @file OpenSpec 规范、变更与 Delta Diff 解析引擎
 * @description 探测本机 openspec CLI / store / workset，解析主规范、活跃与归档变更、Delta 差异，并提供 tasks.md 乐观锁安全回写。
 * @author ypc
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ArtifactStateItem,
  CapabilityDeltaDiff,
  ChangeStage,
  CrossRepoChangeGroup,
  DeltaOperation,
  DeltaRequirementDiff,
  MainSpecEntry,
  OpenSpecEnvironmentInfo,
  RepoBinding,
  RepoChangeEntry,
  TaskItem,
  TasksDocument,
  ToggleTaskInput,
  Workspace,
} from '@openspecui/shared';
import { readDeclaredStoreId } from './registry.js';
import {
  assertTasksWritePath,
  execSafeCommand,
  resolveSafePathInsideRepo,
  SecurityError,
} from './security.js';

/** 乐观并发冲突错误 */
export class ConflictError extends SecurityError {
  constructor(message: string) {
    super(message, 409, 'TASK_CONFLICT');
  }
}

/**
 * 探测本机 OpenSpec CLI 环境、已注册 Store 与 Workset（并行执行并限制超时）。
 */
export async function inspectOpenSpecEnvironment(): Promise<OpenSpecEnvironmentInfo> {
  const info: OpenSpecEnvironmentInfo = {
    cliAvailable: false,
    stores: [],
    worksets: [],
  };

  try {
    const ver = await execSafeCommand('openspec', ['--version'], { timeoutMs: 3_500 });
    info.cliAvailable = true;
    info.cliVersion = ver.stdout.trim();
  } catch {
    return info;
  }

  const [storesRes, worksetsRes] = await Promise.allSettled([
    execSafeCommand('openspec', ['store', 'list', '--json'], { timeoutMs: 4_000 }),
    execSafeCommand('openspec', ['workset', 'list', '--json'], { timeoutMs: 4_000 }),
  ]);

  if (storesRes.status === 'fulfilled') {
    try {
      const parsed = JSON.parse(storesRes.value.stdout) as {
        stores?: Array<{ id: string; path: string; remote?: string }>;
      };
      if (Array.isArray(parsed.stores)) {
        info.stores = parsed.stores.map((s) => ({
          id: s.id,
          path: s.path,
          remote: s.remote,
        }));
      }
    } catch {
      // 忽略解析异常
    }
  }

  if (worksetsRes.status === 'fulfilled') {
    try {
      const parsed = JSON.parse(worksetsRes.value.stdout) as {
        worksets?: Array<{ name: string; members?: string[]; folders?: string[] }>;
      };
      if (Array.isArray(parsed.worksets)) {
        info.worksets = parsed.worksets.map((w) => ({
          name: w.name,
          members: w.members ?? w.folders ?? [],
        }));
      }
    } catch {
      // 部分版本 workset list 可能不支持 --json，忽略即可
    }
  }

  return info;
}

/** 计算文本 SHA-256 摘要 */
export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 解析 `tasks.md` 内容为结构化任务列表。
 */
export function parseTasksMarkdown(
  rawContent: string,
  relativePath: string,
  readOnly: boolean,
): TasksDocument {
  const lines = rawContent.split(/\r?\n/);
  const items: TaskItem[] = [];
  let currentSection = '默认分组';
  const taskPattern = /^\s*-\s+\[([ xX])\]\s+(.*)$/;
  const headingPattern = /^#{1,3}\s+(.+)$/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = headingPattern.exec(line);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      continue;
    }
    const taskMatch = taskPattern.exec(line);
    if (taskMatch) {
      items.push({
        lineNumber: i + 1,
        section: currentSection,
        checked: taskMatch[1].toLowerCase() === 'x',
        text: taskMatch[2].trim(),
        rawLine: line,
      });
    }
  }

  const completedCount = items.filter((item) => item.checked).length;
  return {
    relativePath,
    fileHash: computeSha256(rawContent),
    readOnly,
    items,
    completedCount,
    totalCount: items.length,
    rawContent,
  };
}

/**
 * 对 `tasks.md` 执行基于 `fileHash` + 行号的乐观锁单行勾选回写。
 */
export function applyTaskLineToggle(
  repo: RepoBinding,
  input: ToggleTaskInput,
): TasksDocument {
  if (repo.sourceType === 'remote') {
    throw new SecurityError('远程仓库为只读缓存，禁止修改 tasks.md', 403, 'REMOTE_READ_ONLY');
  }
  if (input.archived) {
    throw new SecurityError('已归档变更的任务不允许直接修改', 403, 'ARCHIVED_READ_ONLY');
  }

  const relPath = `openspec/changes/${input.changeName}/tasks.md`;
  assertTasksWritePath(relPath);
  const absPath = resolveSafePathInsideRepo(repo.localPath, relPath);

  if (!fs.existsSync(absPath)) {
    throw new SecurityError(`tasks.md 不存在: ${relPath}`, 404, 'FILE_NOT_FOUND');
  }

  const rawContent = fs.readFileSync(absPath, 'utf8');
  const currentHash = computeSha256(rawContent);
  if (currentHash !== input.fileHash) {
    throw new ConflictError('tasks.md 已被外部修改，已阻止覆盖并请刷新最新任务列表');
  }

  // 保留原有的换行符风格（CRLF vs LF）
  const lineEnding = rawContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawContent.split(/\r?\n/);
  const idx = input.lineNumber - 1;
  if (idx < 0 || idx >= lines.length) {
    throw new ConflictError('目标任务行号越界，文件可能已变更');
  }

  const targetLine = lines[idx];
  if (input.expectedRawLine !== undefined && targetLine !== input.expectedRawLine) {
    throw new ConflictError('目标任务行内容已变更，已阻止覆盖');
  }

  const match = /^(\s*-\s+\[)([ xX])(\]\s+.*)$/.exec(targetLine);
  if (!match) {
    throw new ConflictError('目标行不是有效的任务复选框格式');
  }

  const currentChecked = match[2].toLowerCase() === 'x';
  if (currentChecked !== input.expectedChecked) {
    throw new ConflictError('任务勾选状态已被外部更改，请刷新后重试');
  }

  const nextMarker = input.nextChecked ? 'x' : ' ';
  lines[idx] = `${match[1]}${nextMarker}${match[3]}`;
  const updatedContent = lines.join(lineEnding);

  // 原子写回：同目录写临时文件后 rename
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, updatedContent, 'utf8');
  fs.renameSync(tmpPath, absPath);

  return parseTasksMarkdown(updatedContent, relPath, false);
}

/**
 * 从规范全文中提取按 Requirement 名称索引的原文段落。
 */
export function extractRequirementsMap(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  let currentName: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentName) {
      map.set(normalizeReqHeader(currentName), buffer.join('\n').trim());
    }
  };

  for (const line of lines) {
    const reqMatch = /^###\s+Requirement:\s*(.+)$/.exec(line);
    if (reqMatch) {
      flush();
      currentName = reqMatch[1].trim();
      buffer = [line];
      continue;
    }
    if (/^##\s+/.test(line)) {
      flush();
      currentName = null;
      buffer = [];
      continue;
    }
    if (currentName) {
      buffer.push(line);
    }
  }
  flush();
  return map;
}

function normalizeReqHeader(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 解析 Delta Spec 并与对应主 Spec 进行条文级对照。
 */
export function parseDeltaSpecDiff(
  capabilityPath: string,
  deltaFilePath: string,
  deltaSpecRaw: string,
  mainSpecRaw?: string,
): CapabilityDeltaDiff {
  const mainReqMap = mainSpecRaw ? extractRequirementsMap(mainSpecRaw) : new Map<string, string>();
  const items: DeltaRequirementDiff[] = [];
  const lines = deltaSpecRaw.split(/\r?\n/);

  let currentOp: DeltaOperation | null = null;
  let currentReqName: string | null = null;
  let currentBuffer: string[] = [];

  const flushRequirement = () => {
    if (!currentOp || !currentReqName) {
      return;
    }
    const block = currentBuffer.join('\n').trim();
    if (currentOp === 'RENAMED') {
      // 处理 FROM:/TO: 格式
      const fromMatch = /FROM:\s*(?:###\s+Requirement:\s*)?(.+)/i.exec(block);
      const toMatch = /TO:\s*(?:###\s+Requirement:\s*)?(.+)/i.exec(block);
      const fromName = fromMatch?.[1].trim() ?? currentReqName;
      const toName = toMatch?.[1].trim() ?? currentReqName;
      items.push({
        operation: 'RENAMED',
        name: toName,
        fromName,
        afterMarkdown: block,
        beforeMarkdown: mainReqMap.get(normalizeReqHeader(fromName)),
      });
    } else {
      items.push({
        operation: currentOp,
        name: currentReqName,
        afterMarkdown: block,
        beforeMarkdown: mainReqMap.get(normalizeReqHeader(currentReqName)),
      });
    }
  };

  for (const line of lines) {
    const opMatch = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/i.exec(line);
    if (opMatch) {
      flushRequirement();
      currentOp = opMatch[1].toUpperCase() as DeltaOperation;
      currentReqName = null;
      currentBuffer = [];
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushRequirement();
      currentOp = null;
      currentReqName = null;
      currentBuffer = [];
      continue;
    }
    const reqMatch = /^###\s+Requirement:\s*(.+)$/.exec(line);
    if (reqMatch && currentOp) {
      flushRequirement();
      currentReqName = reqMatch[1].trim();
      currentBuffer = [line];
      continue;
    }
    if (currentOp === 'RENAMED' && !currentReqName && /^\s*-?\s*FROM:/i.test(line)) {
      currentReqName = 'RENAMED_ITEM';
      currentBuffer = [line];
      continue;
    }
    if (currentOp && currentReqName) {
      currentBuffer.push(line);
    }
  }
  flushRequirement();

  return {
    capabilityPath,
    deltaFilePath,
    hasMainSpec: Boolean(mainSpecRaw),
    mainSpecRaw,
    deltaSpecRaw,
    items,
  };
}

/** 递归收集指定 specs/ 目录下的所有 spec.md 文件及其能力路径 */
function collectSpecFiles(specsDir: string): Array<{ capabilityPath: string; absPath: string }> {
  if (!fs.existsSync(specsDir)) {
    return [];
  }
  const results: Array<{ capabilityPath: string; absPath: string }> = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const rel = path.relative(specsDir, fullPath).replace(/\\/g, '/');
        // 典型路径为 <capability-path>/spec.md，回退则去掉 .md
        const capabilityPath = rel.endsWith('/spec.md')
          ? rel.slice(0, -'/spec.md'.length)
          : rel.replace(/\.md$/, '');
        results.push({ capabilityPath, absPath: fullPath });
      }
    }
  }

  walk(specsDir);
  return results;
}

/**
 * 解析仓库对应的实际 OpenSpec 根目录（支持本地 openspec/ 或外部 store）。
 */
export function resolveRepoSpecRoot(
  repo: RepoBinding,
  envInfo?: OpenSpecEnvironmentInfo,
): { openSpecDir?: string; declaredStoreId?: string; storeMissing?: boolean } {
  const localOpenSpecDir = path.join(repo.localPath, 'openspec');
  const declaredStoreId = repo.declaredStoreId ?? readDeclaredStoreId(repo.localPath);

  if (declaredStoreId) {
    const matchedStore = envInfo?.stores.find((s) => s.id === declaredStoreId);
    if (matchedStore && fs.existsSync(path.join(matchedStore.path, 'openspec'))) {
      return { openSpecDir: path.join(matchedStore.path, 'openspec'), declaredStoreId };
    }
    if (matchedStore && fs.existsSync(matchedStore.path)) {
      return { openSpecDir: matchedStore.path, declaredStoreId };
    }
    return { declaredStoreId, storeMissing: true };
  }

  if (fs.existsSync(localOpenSpecDir)) {
    return { openSpecDir: localOpenSpecDir };
  }
  // 独立 Store 仓库有时根目录直接含 specs/ 与 changes/
  if (
    repo.kind === 'store' &&
    (fs.existsSync(path.join(repo.localPath, 'specs')) ||
      fs.existsSync(path.join(repo.localPath, 'changes')))
  ) {
    return { openSpecDir: repo.localPath };
  }

  return {};
}

/**
 * 读取单个仓库的全部主规范（Specs）。
 */
export function parseRepoMainSpecs(
  repo: RepoBinding,
  envInfo?: OpenSpecEnvironmentInfo,
): MainSpecEntry[] {
  const resolved = resolveRepoSpecRoot(repo, envInfo);
  if (!resolved.openSpecDir) {
    return [];
  }
  const specsDir = path.join(resolved.openSpecDir, 'specs');
  const files = collectSpecFiles(specsDir);
  return files.map(({ capabilityPath, absPath }) => {
    const rawContent = fs.readFileSync(absPath, 'utf8');
    const purposeMatch = /##\s+Purpose\s+([\s\S]*?)(?=\n##\s+|$)/i.exec(rawContent);
    const reqCount = (rawContent.match(/^###\s+Requirement:/gm) ?? []).length;
    return {
      repoId: repo.id,
      repoName: repo.name,
      repoRole: repo.role,
      capabilityPath,
      purpose: purposeMatch ? purposeMatch[1].trim() : '',
      rawContent,
      requirementCount: reqCount,
    };
  });
}

/** 从 proposal.md 提取简短摘要（优先取 Why 段落首句） */
export function extractProposalSummary(proposalContent?: string): string {
  if (!proposalContent) {
    return '';
  }
  const withoutComments = proposalContent.replace(/<!--[\s\S]*?-->/g, '');
  const whyMatch = /##\s+Why\s+([\s\S]*?)(?=\n##\s+|$)/i.exec(withoutComments);
  const block = (whyMatch ? whyMatch[1] : withoutComments)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('-'))
    .join(' ');
  return block.slice(0, 180);
}

/** 计算 spec-driven 四个规划产物的依赖完成状态 */
export function computeArtifactStates(artifacts: {
  hasProposal: boolean;
  hasSpecs: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
}): ArtifactStateItem[] {
  const proposalDone = artifacts.hasProposal;
  const specsDone = artifacts.hasSpecs;
  const designDone = artifacts.hasDesign;
  const tasksDone = artifacts.hasTasks;

  const missingForTasks: string[] = [];
  if (!specsDone) missingForTasks.push('specs');
  if (!designDone) missingForTasks.push('design');

  return [
    {
      id: 'proposal',
      label: 'Proposal',
      status: proposalDone ? 'done' : 'next',
    },
    {
      id: 'specs',
      label: 'Specs',
      status: specsDone ? 'done' : proposalDone ? 'next' : 'blocked',
      blockedBy: !specsDone && !proposalDone ? ['proposal'] : undefined,
    },
    {
      id: 'design',
      label: 'Design',
      status: designDone ? 'done' : proposalDone ? 'next' : 'blocked',
      blockedBy: !designDone && !proposalDone ? ['proposal'] : undefined,
    },
    {
      id: 'tasks',
      label: 'Tasks',
      status: tasksDone
        ? 'done'
        : missingForTasks.length === 0
          ? 'next'
          : 'blocked',
      blockedBy: !tasksDone && missingForTasks.length > 0 ? missingForTasks : undefined,
    },
  ];
}

/** 计算单个 Change 的生命周期阶段 */
export function computeChangeStage(
  archived: boolean,
  artifacts: { hasProposal: boolean; hasSpecs: boolean; hasDesign: boolean; hasTasks: boolean },
  progress: { completed: number; total: number },
): ChangeStage {
  if (archived) {
    return 'archived';
  }
  if (!artifacts.hasProposal || !artifacts.hasSpecs || !artifacts.hasTasks) {
    return 'planning';
  }
  if (progress.total > 0 && progress.completed >= progress.total) {
    return 'complete';
  }
  if (progress.completed > 0) {
    return 'in_progress';
  }
  return 'ready_to_apply';
}

/**
 * 读取单个仓库的全部 Active Changes 与 Archived Changes。
 */
export function parseRepoChanges(
  repo: RepoBinding,
  envInfo?: OpenSpecEnvironmentInfo,
): RepoChangeEntry[] {
  const resolved = resolveRepoSpecRoot(repo, envInfo);
  if (!resolved.openSpecDir) {
    return [];
  }
  const openSpecDir = resolved.openSpecDir;
  const changesDir = path.join(openSpecDir, 'changes');
  const mainSpecsDir = path.join(openSpecDir, 'specs');
  if (!fs.existsSync(changesDir)) {
    return [];
  }

  // 预加载主规范文本，用于生成 Delta Diff
  const mainSpecsMap = new Map<string, string>();
  for (const spec of collectSpecFiles(mainSpecsDir)) {
    mainSpecsMap.set(spec.capabilityPath, fs.readFileSync(spec.absPath, 'utf8'));
  }

  const entries: RepoChangeEntry[] = [];

  const resolveArchivedAt = (folderPath: string): string | undefined => {
    try {
      let latestMs = fs.statSync(folderPath).mtimeMs;
      for (const rel of ['proposal.md', 'design.md', 'tasks.md']) {
        const target = path.join(folderPath, rel);
        if (fs.existsSync(target)) {
          const mtime = fs.statSync(target).mtimeMs;
          if (mtime > latestMs) latestMs = mtime;
        }
      }
      return Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : undefined;
    } catch {
      return undefined;
    }
  };

  const readChangeFolder = (
    folderPath: string,
    changeName: string,
    archived: boolean,
    archiveFolderName?: string,
    archivedDate?: string,
  ) => {
    const proposalPath = path.join(folderPath, 'proposal.md');
    const designPath = path.join(folderPath, 'design.md');
    const tasksPath = path.join(folderPath, 'tasks.md');
    const changeSpecsDir = path.join(folderPath, 'specs');

    const proposalContent = fs.existsSync(proposalPath) ? fs.readFileSync(proposalPath, 'utf8') : undefined;
    const designContent = fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf8') : undefined;
    const tasksRaw = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : undefined;
    const tasksRel = path.relative(repo.localPath, tasksPath).replace(/\\/g, '/');
    const tasks = tasksRaw !== undefined
      ? parseTasksMarkdown(tasksRaw, tasksRel, repo.sourceType === 'remote' || archived)
      : undefined;

    const deltaFiles = collectSpecFiles(changeSpecsDir);
    const deltaDiffs = deltaFiles.map(({ capabilityPath, absPath }) => {
      const deltaRaw = fs.readFileSync(absPath, 'utf8');
      const deltaRel = path.relative(repo.localPath, absPath).replace(/\\/g, '/');
      return parseDeltaSpecDiff(capabilityPath, deltaRel, deltaRaw, mainSpecsMap.get(capabilityPath));
    });

    const artifacts = {
      hasProposal: proposalContent !== undefined,
      hasDesign: designContent !== undefined,
      hasSpecs: deltaDiffs.length > 0,
      hasTasks: tasks !== undefined,
    };
    const progress = {
      completed: tasks?.completedCount ?? 0,
      total: tasks?.totalCount ?? 0,
    };

    entries.push({
      repoId: repo.id,
      repoName: repo.name,
      repoRole: repo.role,
      sourceType: repo.sourceType,
      changeName,
      specRootPath: openSpecDir,
      archived,
      archiveFolderName,
      archivedDate,
      archivedAt: archived ? resolveArchivedAt(folderPath) : undefined,
      stage: computeChangeStage(archived, artifacts, progress),
      summary: extractProposalSummary(proposalContent),
      artifactStates: computeArtifactStates(artifacts),
      artifacts,
      progress,
      proposalContent,
      designContent,
      tasks,
      deltaDiffs,
    });
  };

  // 1. 扫描活跃 Changes
  for (const dirent of fs.readdirSync(changesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name === 'archive' || dirent.name.startsWith('.')) {
      continue;
    }
    readChangeFolder(path.join(changesDir, dirent.name), dirent.name, false);
  }

  // 2. 扫描归档 Changes（兼容 YYYY-MM-DD-<name> 命名剥离日期前缀，以便与另一仓同名活跃变更聚合）
  const archiveDir = path.join(changesDir, 'archive');
  if (fs.existsSync(archiveDir)) {
    for (const dirent of fs.readdirSync(archiveDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
        continue;
      }
      const dateMatch = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(dirent.name);
      const logicalName = dateMatch ? dateMatch[2] : dirent.name;
      const archivedDate = dateMatch ? dateMatch[1] : undefined;
      readChangeFolder(path.join(archiveDir, dirent.name), logicalName, true, dirent.name, archivedDate);
    }
  }

  return entries;
}

/**
 * 将工作区内所有物理仓库的 Change 条目按「手动映射组优先 + 同名 slug 自动聚合」合并为 CrossRepoChangeGroup。
 */
export function aggregateWorkspaceChanges(
  workspace: Workspace,
  allEntries: RepoChangeEntry[],
): CrossRepoChangeGroup[] {
  const groups: CrossRepoChangeGroup[] = [];
  const consumedKeys = new Set<string>();

  const makeEntryKey = (repoId: string, changeName: string, archived: boolean, archiveFolderName?: string) =>
    `${repoId}::${changeName}::${archived ? archiveFolderName ?? 'archived' : 'active'}`;

  // 1. 先处理手动跨仓关联映射
  for (const link of workspace.changeLinks) {
    const matchedEntries: RepoChangeEntry[] = [];
    for (const member of link.members) {
      const found = allEntries.filter(
        (e) => e.repoId === member.repoId && e.changeName === member.changeName,
      );
      for (const item of found) {
        const key = makeEntryKey(item.repoId, item.changeName, item.archived, item.archiveFolderName);
        if (!consumedKeys.has(key)) {
          consumedKeys.add(key);
          matchedEntries.push(item);
        }
      }
    }
    if (matchedEntries.length > 0) {
      groups.push(buildChangeGroup(`link:${link.id}`, link.title, true, link.id, matchedEntries));
    }
  }

  // 2. 剩余条目按 changeName 同名聚合成组
  const slugMap = new Map<string, RepoChangeEntry[]>();
  for (const entry of allEntries) {
    const key = makeEntryKey(entry.repoId, entry.changeName, entry.archived, entry.archiveFolderName);
    if (consumedKeys.has(key)) {
      continue;
    }
    const list = slugMap.get(entry.changeName) ?? [];
    list.push(entry);
    slugMap.set(entry.changeName, list);
  }

  for (const [slug, entries] of slugMap.entries()) {
    groups.push(buildChangeGroup(`slug:${slug}`, slug, false, undefined, entries));
  }

  // 排序：活跃/混合状态优先，其次按标题排序
  groups.sort((a, b) => {
    const rank = (s: CrossRepoChangeGroup['aggregateStatus']) =>
      s === 'all_active' ? 0 : s === 'mixed' ? 1 : 2;
    const diff = rank(a.aggregateStatus) - rank(b.aggregateStatus);
    return diff !== 0 ? diff : a.title.localeCompare(b.title);
  });

  return groups;
}

function buildChangeGroup(
  key: string,
  title: string,
  isManualLink: boolean,
  manualLinkId: string | undefined,
  entries: RepoChangeEntry[],
): CrossRepoChangeGroup {
  const archivedCount = entries.filter((e) => e.archived).length;
  const aggregateStatus: CrossRepoChangeGroup['aggregateStatus'] =
    archivedCount === 0
      ? 'all_active'
      : archivedCount === entries.length
        ? 'all_archived'
        : 'mixed';

  const completed = entries.reduce((sum, e) => sum + e.progress.completed, 0);
  const total = entries.reduce((sum, e) => sum + e.progress.total, 0);

  let stage: ChangeStage;
  if (aggregateStatus === 'all_archived') {
    stage = 'archived';
  } else if (entries.some((e) => !e.archived && e.stage === 'planning')) {
    stage = 'planning';
  } else if (total > 0 && completed >= total) {
    stage = 'complete';
  } else if (completed > 0) {
    stage = 'in_progress';
  } else {
    stage = 'ready_to_apply';
  }

  return {
    key,
    title,
    isManualLink,
    manualLinkId,
    aggregateStatus,
    stage,
    totalProgress: { completed, total },
    entries,
  };
}
