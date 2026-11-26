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
  SpecRequirementChangeItem,
  SpecRequirementChangeKind,
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

interface DetailedRequirementBlock {
  displayName: string;
  rawBlock: string;
}

/**
 * 从规范全文中提取保留原始标题与原文段落的 Requirement 映射（键为规范化小写名称）。
 */
function extractDetailedRequirementsMap(markdown: string): Map<string, DetailedRequirementBlock> {
  const map = new Map<string, DetailedRequirementBlock>();
  const lines = markdown.split(/\r?\n/);
  let currentName: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentName) {
      map.set(normalizeReqHeader(currentName), {
        displayName: currentName,
        rawBlock: buffer.join('\n').trim(),
      });
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

/**
 * 从规范全文中提取按 Requirement 名称索引的原文段落。
 */
export function extractRequirementsMap(markdown: string): Map<string, string> {
  const detailed = extractDetailedRequirementsMap(markdown);
  const map = new Map<string, string>();
  for (const [key, item] of detailed.entries()) {
    map.set(key, item.rawBlock);
  }
  return map;
}

function normalizeReqHeader(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 规范化单条 Requirement 正文用于判定内容是否实质修改 */
function normalizeRequirementText(rawBlock: string): string {
  return rawBlock.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/** 剥离 OpenSpec 模板固定词后提取中英文混合语义词元（用于重命名相似度匹配） */
function tokenizeRequirementSemantics(rawBlock: string): Set<string> {
  const lines = rawBlock.split(/\r?\n/);
  // 去掉首行 `### Requirement: ...` 标题，避免标题完全改写拉低或干扰正文相似度
  const bodyWithoutTitle = lines.length > 1 ? lines.slice(1).join('\n') : rawBlock;
  const stripped = bodyWithoutTitle
    .replace(/####\s+Scenario:\s*/gi, ' ')
    .replace(/\bthe\s+system\s+shall\b/gi, ' ')
    .replace(/\b(?:shall|should|must|may|when|then|and)\b/gi, ' ')
    .replace(/[`*_#>\-\[\]()]/g, ' ')
    .toLowerCase();

  const tokens = new Set<string>();
  const latinMatches = stripped.match(/[a-z0-9_]+/g) ?? [];
  for (const word of latinMatches) {
    if (word.length >= 2) {
      tokens.add(word);
    }
  }

  const cjkRuns = stripped.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 计算两个词元集合的 Dice 相似度系数（0~1） */
function computeDiceSimilarity(a: Set<string>, b: Set<string>): number {
  // 剥离模板词后词元过少时不做相似度推测，防止空壳需求误匹配
  if (a.size < 2 || b.size < 2) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / (a.size + b.size);
}

/** Spec 相邻快照的 Requirement 语义差异对比结果 */
export interface SpecSnapshotDiffResult {
  operations: SpecRequirementChangeKind[];
  changes: SpecRequirementChangeItem[];
  counts: {
    created: number;
    added: number;
    modified: number;
    renamed: number;
    removed: number;
  };
}

/**
 * 对比相邻两版 `spec.md` 的 Requirement 语义差异，区分创建、追加、修改、重命名、移除与纯文档修订。
 *
 * @param prevMarkdown 上一版本规范文本；传入 undefined 表示首次创建提交
 * @param currMarkdown 当前版本规范文本
 * @param options 可选同提交归档 Delta Spec 文本与相似度阈值
 * @returns 结构化的操作类型集合、Requirement 变更清单与汇总计数
 */
export function compareSpecRequirementSnapshots(
  prevMarkdown: string | undefined,
  currMarkdown: string,
  options: {
    deltaSpecsRaw?: string[];
    similarityThreshold?: number;
  } = {},
): SpecSnapshotDiffResult {
  const currMap = extractDetailedRequirementsMap(currMarkdown);
  const changes: SpecRequirementChangeItem[] = [];

  if (prevMarkdown === undefined) {
    for (const item of currMap.values()) {
      changes.push({ operation: 'CREATED', name: item.displayName });
    }
    return {
      operations: changes.length > 0 ? ['CREATED'] : ['DOCS_UPDATED'],
      changes,
      counts: {
        created: changes.length,
        added: 0,
        modified: 0,
        renamed: 0,
        removed: 0,
      },
    };
  }

  const prevMap = extractDetailedRequirementsMap(prevMarkdown);
  const addedKeys = new Set<string>();
  const removedKeys = new Set<string>();
  const modifiedItems: SpecRequirementChangeItem[] = [];

  for (const [key, currItem] of currMap.entries()) {
    const prevItem = prevMap.get(key);
    if (!prevItem) {
      addedKeys.add(key);
    } else if (normalizeRequirementText(prevItem.rawBlock) !== normalizeRequirementText(currItem.rawBlock)) {
      modifiedItems.push({ operation: 'MODIFIED', name: currItem.displayName });
    }
  }

  for (const key of prevMap.keys()) {
    if (!currMap.has(key)) {
      removedKeys.add(key);
    }
  }

  const renamedItems: SpecRequirementChangeItem[] = [];

  // 1. 优先使用同提交内归档 Delta Spec 声明的 RENAMED FROM:/TO: 确定性映射
  if (options.deltaSpecsRaw && options.deltaSpecsRaw.length > 0 && addedKeys.size > 0 && removedKeys.size > 0) {
    for (const deltaRaw of options.deltaSpecsRaw) {
      const parsedDelta = parseDeltaSpecDiff('delta', 'delta', deltaRaw);
      for (const item of parsedDelta.items) {
        if (item.operation !== 'RENAMED' || !item.fromName) {
          continue;
        }
        const fromKey = normalizeReqHeader(item.fromName);
        const toKey = normalizeReqHeader(item.name);
        if (removedKeys.has(fromKey) && addedKeys.has(toKey)) {
          const prevItem = prevMap.get(fromKey)!;
          const currItem = currMap.get(toKey)!;
          removedKeys.delete(fromKey);
          addedKeys.delete(toKey);
          renamedItems.push({
            operation: 'RENAMED',
            name: currItem.displayName,
            fromName: prevItem.displayName,
            matchSource: 'delta',
          });
        }
      }
    }
  }

  // 2. 兜底使用剥离模板词后的正文语义相似度做一对一贪心匹配
  const threshold = options.similarityThreshold ?? 0.55;
  if (removedKeys.size > 0 && addedKeys.size > 0) {
    const prevTokens = new Map<string, Set<string>>();
    const currTokens = new Map<string, Set<string>>();
    for (const rKey of removedKeys) {
      prevTokens.set(rKey, tokenizeRequirementSemantics(prevMap.get(rKey)!.rawBlock));
    }
    for (const aKey of addedKeys) {
      currTokens.set(aKey, tokenizeRequirementSemantics(currMap.get(aKey)!.rawBlock));
    }

    const candidates: Array<{ rKey: string; aKey: string; score: number }> = [];
    for (const rKey of removedKeys) {
      const rSet = prevTokens.get(rKey)!;
      for (const aKey of addedKeys) {
        const score = computeDiceSimilarity(rSet, currTokens.get(aKey)!);
        if (score >= threshold) {
          candidates.push({ rKey, aKey, score });
        }
      }
    }
    candidates.sort((x, y) => y.score - x.score);

    for (const candidate of candidates) {
      if (!removedKeys.has(candidate.rKey) || !addedKeys.has(candidate.aKey)) {
        continue;
      }
      removedKeys.delete(candidate.rKey);
      addedKeys.delete(candidate.aKey);
      renamedItems.push({
        operation: 'RENAMED',
        name: currMap.get(candidate.aKey)!.displayName,
        fromName: prevMap.get(candidate.rKey)!.displayName,
        matchSource: 'similarity',
        similarity: Math.round(candidate.score * 100),
      });
    }
  }

  const addedItems: SpecRequirementChangeItem[] = [];
  for (const aKey of addedKeys) {
    addedItems.push({ operation: 'ADDED', name: currMap.get(aKey)!.displayName });
  }

  const removedItems: SpecRequirementChangeItem[] = [];
  for (const rKey of removedKeys) {
    removedItems.push({ operation: 'REMOVED', name: prevMap.get(rKey)!.displayName });
  }

  // 排序：移除告警靠前或按固定顺序展示，便于界面与测试保持确定性
  changes.push(...addedItems, ...modifiedItems, ...renamedItems, ...removedItems);

  const operations: SpecRequirementChangeKind[] = [];
  if (addedItems.length > 0) operations.push('ADDED');
  if (modifiedItems.length > 0) operations.push('MODIFIED');
  if (renamedItems.length > 0) operations.push('RENAMED');
  if (removedItems.length > 0) operations.push('REMOVED');
  if (operations.length === 0) operations.push('DOCS_UPDATED');

  return {
    operations,
    changes,
    counts: {
      created: 0,
      added: addedItems.length,
      modified: modifiedItems.length,
      renamed: renamedItems.length,
      removed: removedItems.length,
    },
  };
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
      // 处理 FROM:/TO: 格式（兼容反引号包裹与可选 `### Requirement:` 前缀）
      const cleanRenamedTarget = (raw: string): string =>
        raw
          .trim()
          .replace(/^`+|`+$/g, '')
          .replace(/^###\s+Requirement:\s*/i, '')
          .trim();
      const fromMatch = /FROM:\s*(.+)/i.exec(block);
      const toMatch = /TO:\s*(.+)/i.exec(block);
      const fromName = fromMatch ? cleanRenamedTarget(fromMatch[1]) : currentReqName;
      const toName = toMatch ? cleanRenamedTarget(toMatch[1]) : currentReqName;
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
