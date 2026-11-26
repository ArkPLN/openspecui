/**
 * @file 只读 Git 集成服务
 * @description 为本地与远程缓存仓库提供只读 Git 状态查询、跨仓混合提交时间线、Change-Branch/Commit 关联及代码 Diff 预览。
 * @author ypc
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ChangeBranchPin,
  GitCommitItem,
  GitDiffResult,
  GitFileDiff,
  GitRepoStatus,
  OpenSpecEnvironmentInfo,
  RepoBinding,
  SpecContributorSummary,
  SpecHistoryResponse,
  SpecRevisionEntry,
  Workspace,
} from '@openspecui/shared';
import { compareSpecRequirementSnapshots, resolveRepoSpecRoot } from './openspec-parser.js';
import {
  execSafeCommand,
  resolveSafePathInsideRepo,
  SecurityError,
  validateGitRefOrSha,
} from './security.js';

const MAX_DIFF_FILES = 60;
const MAX_PATCH_BYTES = 120 * 1024;

/** 判断目录是否为 Git 仓库 */
function isGitDirectory(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.git'));
}

/** 包装只读 git 调用，统一禁用 core.quotePath 并对 index.lock 做短暂退避重试 */
async function runGitReadOnly(repoPath: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const maxAttempts = 3;
  const fullArgs = ['-c', 'core.quotePath=false', ...args];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await execSafeCommand('git', fullArgs, { cwd: repoPath, timeoutMs });
      return res.stdout;
    } catch (err) {
      const stderr = String((err as { stderr?: string })?.stderr ?? '');
      if (/index\.lock/i.test(stderr) && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
        continue;
      }
      throw err;
    }
  }
  return '';
}

/**
 * 解码 Git 输出的带引号或 C 风格八进制转义文件路径（例如 `"a/\347\220\206..."`）为原始 UTF-8 字符串。
 *
 * @param rawPath Git 原始路径字段
 * @returns 剥离外层引号并还原 UTF-8 字符后的路径
 */
export function decodeGitEscapedPath(rawPath: string): string {
  const isQuoted = rawPath.length >= 2 && rawPath.startsWith('"') && rawPath.endsWith('"');
  if (!isQuoted && !/\\[0-7]{3}/.test(rawPath)) {
    return rawPath;
  }

  const inner = isQuoted ? rawPath.slice(1, -1) : rawPath;
  const bytes: number[] = [];

  for (let i = 0; i < inner.length; ) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const octCandidate = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octCandidate)) {
        bytes.push(parseInt(octCandidate, 8));
        i += 4;
        continue;
      }
      const next = inner[i + 1];
      const escapeByteMap: Record<string, number> = {
        '"': 0x22,
        '\\': 0x5c,
        t: 0x09,
        n: 0x0a,
        r: 0x0d,
        a: 0x07,
        b: 0x08,
        f: 0x0c,
        v: 0x0b,
      };
      if (next in escapeByteMap) {
        bytes.push(escapeByteMap[next]);
        i += 2;
        continue;
      }
    }

    const codePoint = inner.codePointAt(i)!;
    const symbol = String.fromCodePoint(codePoint);
    for (const byte of Buffer.from(symbol, 'utf8')) {
      bytes.push(byte);
    }
    i += symbol.length;
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * 解析 `diff --git` 首行（`diff --git ` 之后部分）的左右路径，兼容双引号包裹、单边引号重命名与八进制转义。
 *
 * @param headerRemainder `diff --git ` 后的首行文本
 * @returns 剥离 `a/`、`b/` 前缀并解码后的左右路径；格式不合法时返回 null
 */
export function parseDiffGitHeaderPaths(
  headerRemainder: string,
): { oldPath: string; newPath: string } | null {
  // 1. 快速处理未加引号的对称路径（含空格路径在 core.quotePath=false 下通常不加引号：a/<p> b/<p>）
  if (!headerRemainder.includes('"') && headerRemainder.startsWith('a/')) {
    const mid = (headerRemainder.length - 1) / 2;
    if (
      Number.isInteger(mid) &&
      headerRemainder[mid] === ' ' &&
      headerRemainder.startsWith('b/', mid + 1) &&
      headerRemainder.slice(2, mid) === headerRemainder.slice(mid + 3)
    ) {
      const decoded = decodeGitEscapedPath(headerRemainder.slice(2, mid));
      return { oldPath: decoded, newPath: decoded };
    }
  }

  // 2. 若至少一侧含引号，使用双 Token 状态机依次读取
  if (headerRemainder.includes('"')) {
    const readToken = (startIdx: number): { token: string; nextIdx: number } | null => {
      let idx = startIdx;
      while (idx < headerRemainder.length && /\s/.test(headerRemainder[idx])) {
        idx += 1;
      }
      if (idx >= headerRemainder.length) {
        return null;
      }

      if (headerRemainder[idx] === '"') {
        let end = idx + 1;
        while (end < headerRemainder.length) {
          if (headerRemainder[end] === '\\') {
            end += 2;
            continue;
          }
          if (headerRemainder[end] === '"') {
            end += 1;
            break;
          }
          end += 1;
        }
        return { token: headerRemainder.slice(idx, end), nextIdx: end };
      }

      // 未加引号的一侧可能位于重命名左/右（如 `a/old name.sql "b/new name.sql"`）
      const quoteStart = headerRemainder.indexOf(' "', idx);
      if (quoteStart !== -1 && idx === 0) {
        return { token: headerRemainder.slice(idx, quoteStart), nextIdx: quoteStart + 1 };
      }

      let end = idx;
      while (end < headerRemainder.length && !/\s/.test(headerRemainder[end])) {
        end += 1;
      }
      // 若左侧带引号而右侧未加引号且含空格，右侧直接消费到行尾
      if (startIdx > 0) {
        return { token: headerRemainder.slice(idx).trimEnd(), nextIdx: headerRemainder.length };
      }
      return { token: headerRemainder.slice(idx, end), nextIdx: end };
    };

    const first = readToken(0);
    if (!first) {
      return null;
    }
    const second = readToken(first.nextIdx);
    if (!second) {
      return null;
    }

    const rawOld = decodeGitEscapedPath(first.token);
    const rawNew = decodeGitEscapedPath(second.token);
    const oldPath = rawOld.startsWith('a/') ? rawOld.slice(2) : rawOld;
    const newPath = rawNew.startsWith('b/') ? rawNew.slice(2) : rawNew;
    return { oldPath, newPath };
  }

  // 3. 回退：未加引号的非对称重命名（例如 `a/old name.sql b/new name.sql`）
  const fallbackMatch = /^a\/(.+?)\s+b\/(.+)$/.exec(headerRemainder);
  if (fallbackMatch) {
    return {
      oldPath: decodeGitEscapedPath(fallbackMatch[1]),
      newPath: decodeGitEscapedPath(fallbackMatch[2]),
    };
  }
  return null;
}

/** 将 Diff chunk 头部行中的八进制转义或带引号路径规范化为可读 UTF-8 */
function normalizeDiffHeaderLines(fullChunk: string): string {
  const lines = fullChunk.split(/\r?\n/);
  const lineEnding = fullChunk.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;

  for (let i = 0; i < Math.min(lines.length, 8); i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const parsed = parseDiffGitHeaderPaths(line.slice('diff --git '.length));
      if (parsed && (line.includes('"') || /\\[0-7]{3}/.test(line))) {
        lines[i] = `diff --git a/${parsed.oldPath} b/${parsed.newPath}`;
        changed = true;
      }
      continue;
    }

    for (const prefix of ['--- ', '+++ ', 'rename from ', 'rename to ', 'copy from ', 'copy to ']) {
      if (!line.startsWith(prefix)) {
        continue;
      }
      const rest = line.slice(prefix.length);
      if (rest !== '/dev/null' && (rest.startsWith('"') || /\\[0-7]{3}/.test(rest))) {
        lines[i] = `${prefix}${decodeGitEscapedPath(rest)}`;
        changed = true;
      }
      break;
    }
  }

  return changed ? lines.join(lineEnding) : fullChunk;
}

/**
 * 获取单个仓库的独立 Git 状态（支持非 Git 目录优雅降级）。
 */
export async function getRepoGitStatus(repo: RepoBinding): Promise<GitRepoStatus> {
  const base: GitRepoStatus = {
    repoId: repo.id,
    repoName: repo.name,
    repoRole: repo.role,
    sourceType: repo.sourceType,
    isGitRepo: false,
    branch: '-',
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    dirtyFiles: [],
    branches: [],
  };

  if (!fs.existsSync(repo.localPath) || !isGitDirectory(repo.localPath)) {
    return {
      ...base,
      error: fs.existsSync(repo.localPath) ? '非 Git 仓库' : '本地目录不存在或尚未完成克隆',
    };
  }

  try {
    const [porcelain, branchesRaw] = await Promise.all([
      runGitReadOnly(repo.localPath, ['status', '--porcelain=v2', '--branch']),
      runGitReadOnly(repo.localPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
    ]);

    let branch = 'HEAD';
    let upstream: string | undefined;
    let ahead = 0;
    let behind = 0;
    const dirtyFiles: Array<{ path: string; status: string }> = [];

    for (const line of porcelain.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      if (line.startsWith('# branch.head ')) {
        const val = line.slice('# branch.head '.length).trim();
        branch = val === '(detached)' ? 'detached' : val;
      } else if (line.startsWith('# branch.upstream ')) {
        upstream = line.slice('# branch.upstream '.length).trim();
      } else if (line.startsWith('# branch.ab ')) {
        const abMatch = /\+(\d+)\s+-(\d+)/.exec(line);
        if (abMatch) {
          ahead = Number(abMatch[1]);
          behind = Number(abMatch[2]);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const parts = line.split(' ');
        const xy = parts[1] ?? 'M.';
        const pathStartIndex = line.startsWith('2 ') ? 9 : 8;
        const rawPath = parts.slice(pathStartIndex).join(' ').split('\t')[0];
        dirtyFiles.push({ path: decodeGitEscapedPath(rawPath), status: xy });
      } else if (line.startsWith('u ')) {
        const parts = line.split(' ');
        const rawPath = parts.slice(10).join(' ');
        dirtyFiles.push({ path: decodeGitEscapedPath(rawPath), status: 'UU' });
      } else if (line.startsWith('? ')) {
        dirtyFiles.push({ path: decodeGitEscapedPath(line.slice(2).trim()), status: '??' });
      }
    }

    const branches = branchesRaw
      .split(/\r?\n/)
      .map((b) => b.trim())
      .filter((b) => b && !b.endsWith('/HEAD'));

    return {
      ...base,
      isGitRepo: true,
      branch,
      upstream,
      ahead,
      behind,
      dirtyCount: dirtyFiles.length,
      dirtyFiles,
      branches,
    };
  } catch (err) {
    return {
      ...base,
      isGitRepo: true,
      error: (err as Error).message,
    };
  }
}

/**
 * 读取单个仓库近期提交历史。
 */
export async function getRepoRecentCommits(
  repo: RepoBinding,
  options: { branch?: string; limit?: number } = {},
): Promise<GitCommitItem[]> {
  if (!fs.existsSync(repo.localPath) || !isGitDirectory(repo.localPath)) {
    return [];
  }

  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const refArgs = options.branch ? [validateGitRefOrSha(options.branch)] : ['--all'];
  const separator = '<<<OPENSPEC_COMMIT>>>';
  const fieldSep = '<<<FIELD>>>';

  let stdout = '';
  try {
    stdout = await runGitReadOnly(repo.localPath, [
      'log',
      ...refArgs,
      `-n`,
      String(limit),
      `--format=${separator}%H${fieldSep}%h${fieldSep}%D${fieldSep}%an${fieldSep}%aI${fieldSep}%s`,
      '--shortstat',
    ]);
  } catch {
    return [];
  }

  const commits: GitCommitItem[] = [];
  const blocks = stdout.split(separator).filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const headerParts = lines[0]?.split(fieldSep) ?? [];
    if (headerParts.length < 6) {
      continue;
    }
    const [sha, shortSha, refs, author, committedAt, subject] = headerParts;
    const statLine = lines.slice(1).join(' ');
    const filesMatch = /(\d+)\s+files?\s+changed/.exec(statLine);

    commits.push({
      sha,
      shortSha,
      repoId: repo.id,
      repoName: repo.name,
      repoRole: repo.role,
      branchRef: refs.trim() || options.branch || 'HEAD',
      subject,
      author,
      committedAt,
      filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    });
  }

  return commits;
}

/**
 * 聚合工作区内全部仓库的跨仓混合提交时间线（按时间倒序）。
 */
export async function getWorkspaceGitTimeline(
  workspace: Workspace,
  limitPerRepo = 25,
): Promise<GitCommitItem[]> {
  const allLists = await Promise.all(
    workspace.repos.map((repo) => getRepoRecentCommits(repo, { limit: limitPerRepo })),
  );
  return allLists
    .flat()
    .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))
    .slice(0, 80);
}

/**
 * 将 Unified Diff 文本拆分为按文件组织的 GitFileDiff 数组，带截断与二进制保护。
 */
export function parseUnifiedDiffOutput(rawDiff: string): { files: GitFileDiff[]; truncated: boolean } {
  if (!rawDiff.trim()) {
    return { files: [], truncated: false };
  }

  const chunks = rawDiff.split(/^diff --git /m).filter((c) => c.trim());
  const truncated = chunks.length > MAX_DIFF_FILES;
  const files: GitFileDiff[] = [];

  for (const chunk of chunks.slice(0, MAX_DIFF_FILES)) {
    const rawFullChunk = `diff --git ${chunk}`;
    const firstLine = chunk.split(/\r?\n/, 1)[0] ?? '';
    const parsedHeader = parseDiffGitHeaderPaths(firstLine);
    const filePath = parsedHeader ? parsedHeader.newPath : decodeGitEscapedPath(firstLine);
    const fullChunk = normalizeDiffHeaderLines(rawFullChunk);

    let status: GitFileDiff['status'] = 'modified';
    if (/^new file mode /m.test(fullChunk)) {
      status = 'added';
    } else if (/^deleted file mode /m.test(fullChunk)) {
      status = 'deleted';
    } else if (/^rename from /m.test(fullChunk)) {
      status = 'renamed';
    } else if (/^Binary files .* differ$/m.test(fullChunk) || /^GIT binary patch$/m.test(fullChunk)) {
      status = 'binary';
    }

    const patchOverLimit = Buffer.byteLength(fullChunk, 'utf8') > MAX_PATCH_BYTES;
    const patch = status === 'binary'
      ? '二进制文件差异省略预览'
      : patchOverLimit
        ? `${fullChunk.slice(0, MAX_PATCH_BYTES)}\n\n... [Diff 超出单文件预览上限已截断]`
        : fullChunk;

    files.push({
      path: filePath,
      status,
      patch,
      truncated: patchOverLimit,
    });
  }

  return { files, truncated };
}

/**
 * 读取指定仓库的工作区未提交 Diff 或某个历史 Commit Diff（只读）。
 */
export async function getRepoDiff(
  repo: RepoBinding,
  target: 'working-tree' | string,
): Promise<GitDiffResult> {
  if (!fs.existsSync(repo.localPath) || !isGitDirectory(repo.localPath)) {
    throw new SecurityError('目标目录不是有效的 Git 仓库', 400, 'NOT_A_GIT_REPO');
  }

  if (target === 'working-tree') {
    const [unstaged, staged] = await Promise.all([
      runGitReadOnly(repo.localPath, ['diff', '--no-color']),
      runGitReadOnly(repo.localPath, ['diff', '--cached', '--no-color']),
    ]);
    const combined = [staged.trim(), unstaged.trim()].filter(Boolean).join('\n');
    const parsed = parseUnifiedDiffOutput(combined);
    return {
      repoId: repo.id,
      target: 'working-tree',
      ...parsed,
    };
  }

  const safeSha = validateGitRefOrSha(target);
  const raw = await runGitReadOnly(repo.localPath, [
    'show',
    '--no-color',
    '--format=',
    safeSha,
  ]);
  const parsed = parseUnifiedDiffOutput(raw);
  return {
    repoId: repo.id,
    target: safeSha,
    ...parsed,
  };
}

/** Change 与单个仓库的分支/Commit 匹配结果 */
export interface RepoChangeGitMatch {
  repoId: string;
  /** 是否与当前 Change 直接相关（属于该 Change 所属仓或命中关联规则） */
  isRelated: boolean;
  matchedBranch?: string;
  matchReason: 'manual-pin' | 'branch-name' | 'commit-message' | 'current-branch' | 'none';
  isPinned: boolean;
  commits: GitCommitItem[];
  status: GitRepoStatus;
}

/**
 * 为指定逻辑 Change 匹配工作区内各仓库的分支、未提交状态与提交列表。
 * 仅将属于该 Change 的仓库（ownerRepoIds）或命中 Pin/分支名/提交消息的仓库标记为 isRelated=true。
 */
export async function matchChangeToGitAcrossWorkspace(
  workspace: Workspace,
  changeKey: string,
  candidateNames: string[],
  ownerRepoIds: string[] = [],
): Promise<RepoChangeGitMatch[]> {
  const ownerSet = new Set(ownerRepoIds);
  const tokens = Array.from(
    new Set(
      candidateNames
        .map((n) => n.trim().toLowerCase())
        .filter((n) => n.length >= 2),
    ),
  );

  return Promise.all(
    workspace.repos.map(async (repo) => {
      const isOwner = ownerSet.has(repo.id);
      const status = await getRepoGitStatus(repo);
      if (!status.isGitRepo) {
        return {
          repoId: repo.id,
          isRelated: isOwner,
          matchReason: 'none',
          isPinned: false,
          commits: [],
          status,
        };
      }

      const pin: ChangeBranchPin | undefined = workspace.branchPins.find(
        (p) => p.changeKey === changeKey && p.repoId === repo.id,
      );

      // 1. 手动 Pin 优先
      if (pin?.branch) {
        const commits = await getRepoRecentCommits(repo, { branch: pin.branch, limit: 20 });
        return {
          repoId: repo.id,
          isRelated: true,
          matchedBranch: pin.branch,
          matchReason: 'manual-pin',
          isPinned: true,
          commits,
          status,
        };
      }

      // 2. 分支名包含 change slug（优先当前分支，再看其它分支和 origin/*）
      const currentLower = status.branch.toLowerCase();
      if (tokens.some((t) => currentLower.includes(t))) {
        const commits = await getRepoRecentCommits(repo, { branch: status.branch, limit: 20 });
        return {
          repoId: repo.id,
          isRelated: true,
          matchedBranch: status.branch,
          matchReason: 'branch-name',
          isPinned: false,
          commits,
          status,
        };
      }

      const matchedBranch = status.branches.find((b) =>
        tokens.some((t) => b.toLowerCase().includes(t)),
      );
      if (matchedBranch) {
        const commits = await getRepoRecentCommits(repo, { branch: matchedBranch, limit: 20 });
        return {
          repoId: repo.id,
          isRelated: true,
          matchedBranch,
          matchReason: 'branch-name',
          isPinned: false,
          commits,
          status,
        };
      }

      // 3. 回退检查最近提交消息是否包含 change 名
      const recentCommits = await getRepoRecentCommits(repo, { limit: 35 });
      const matchedCommits = recentCommits.filter((c) =>
        tokens.some((t) => c.subject.toLowerCase().includes(t)),
      );
      if (matchedCommits.length > 0) {
        return {
          repoId: repo.id,
          isRelated: true,
          matchedBranch: status.branch,
          matchReason: 'commit-message',
          isPinned: false,
          commits: matchedCommits,
          status,
        };
      }

      // 4. 若均未命中：仅所属仓库本身默认展示当前分支，其余无关仓库标记为 isRelated=false
      const fallbackBranch =
        repo.sourceType === 'remote'
          ? status.branches.find((b) => b === 'origin/main' || b === 'origin/master') ?? status.branch
          : status.branch;
      return {
        repoId: repo.id,
        isRelated: isOwner,
        matchedBranch: fallbackBranch,
        matchReason: 'current-branch',
        isPinned: false,
        commits: recentCommits.slice(0, 10),
        status,
      };
    }),
  );
}

/**
 * 安全切换仓库当前工作区分支（绝不使用 -f/--force 强行覆盖未提交修改）。
 */
export async function switchRepoBranch(
  repo: RepoBinding,
  branchInput: string,
): Promise<GitRepoStatus> {
  if (!fs.existsSync(repo.localPath) || !isGitDirectory(repo.localPath)) {
    throw new SecurityError('当前目录不是有效的 Git 仓库', 400, 'NOT_A_GIT_REPO');
  }

  const branch = validateGitRefOrSha(branchInput);
  const [localRefsRaw, remoteRefsRaw] = await Promise.all([
    runGitReadOnly(repo.localPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGitReadOnly(repo.localPath, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
  ]);

  const localBranches = new Set(
    localRefsRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const remoteBranches = new Set(
    remoteRefsRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/HEAD')),
  );

  let switchArgs: string[];
  let fallbackCheckoutArgs: string[];

  if (localBranches.has(branch)) {
    switchArgs = ['switch', branch];
    fallbackCheckoutArgs = ['checkout', branch];
  } else if (remoteBranches.has(branch)) {
    const slashIdx = branch.indexOf('/');
    const localName = slashIdx > 0 ? branch.slice(slashIdx + 1) : branch;
    if (localBranches.has(localName)) {
      switchArgs = ['switch', localName];
      fallbackCheckoutArgs = ['checkout', localName];
    } else {
      switchArgs = ['switch', '--track', branch];
      fallbackCheckoutArgs = ['checkout', '-b', localName, '--track', branch];
    }
  } else {
    throw new SecurityError(`目标分支不存在: ${branch}`, 404, 'BRANCH_NOT_FOUND');
  }

  try {
    await runGitReadOnly(repo.localPath, switchArgs, 20_000);
  } catch (err) {
    const stderr = String((err as { stderr?: string })?.stderr ?? '');
    if (/is not a git command/i.test(stderr)) {
      try {
        await runGitReadOnly(repo.localPath, fallbackCheckoutArgs, 20_000);
      } catch (fallbackErr) {
        const fbMsg = String(
          (fallbackErr as { stderr?: string })?.stderr || (fallbackErr as Error).message,
        ).trim();
        throw new SecurityError(
          `切换分支失败（已保留未提交修改）: ${fbMsg}`,
          409,
          'GIT_CHECKOUT_CONFLICT',
        );
      }
    } else {
      const detail = stderr.trim() || (err as Error).message;
      throw new SecurityError(
        `切换分支失败（已保留未提交修改）: ${detail}`,
        409,
        'GIT_CHECKOUT_CONFLICT',
      );
    }
  }

  return getRepoGitStatus(repo);
}

/** 从起始目录向上查找最近的 `.git` 根目录 */
function findNearestGitRoot(startDir: string): string | null {
  let current: string;
  try {
    current = fs.realpathSync(startDir);
  } catch {
    return null;
  }
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** 限制异步并发数执行任务映射 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  };

  const workerCount = Math.min(Math.max(concurrency, 1), Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

/** 读取单次提交内某个文件的完整 UTF-8 文本；失败时返回 undefined */
async function readGitBlobText(
  gitRoot: string,
  sha: string,
  relPath: string,
): Promise<string | undefined> {
  try {
    const safeSha = validateGitRefOrSha(sha);
    const normalizedRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedRel || normalizedRel.startsWith('-') || normalizedRel.includes('..')) {
      return undefined;
    }
    return await runGitReadOnly(gitRoot, ['show', `${safeSha}:${normalizedRel}`], 10_000);
  } catch {
    return undefined;
  }
}

/** 从同一次提交中提取关联能力的归档 Delta Spec 原文列表（用于识别 FROM/TO 重命名） */
async function readCommitMatchingDeltaSpecs(
  gitRoot: string,
  sha: string,
  capabilityPath: string,
  specRelToGitRoot: string,
): Promise<string[]> {
  try {
    const safeSha = validateGitRefOrSha(sha);
    const changedRaw = await runGitReadOnly(
      gitRoot,
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', safeSha],
      8_000,
    );
    const suffix = `/specs/${capabilityPath.replace(/\\/g, '/')}/spec.md`.toLowerCase();
    const matchedPaths = changedRaw
      .split(/\r?\n/)
      .map((line) => decodeGitEscapedPath(line.trim()).replace(/\\/g, '/'))
      .filter((line) => {
        if (!line || line === specRelToGitRoot) return false;
        const lower = line.toLowerCase();
        return lower.includes('/changes/') && lower.endsWith(suffix);
      });

    if (matchedPaths.length === 0) {
      return [];
    }

    const texts = await Promise.all(matchedPaths.slice(0, 3).map((p) => readGitBlobText(gitRoot, safeSha, p)));
    return texts.filter((t): t is string => t !== undefined);
  } catch {
    return [];
  }
}

interface RawSpecCommitMeta {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  subject: string;
  filePathAtCommit: string;
}

/**
 * 懒加载查询单个主规范（Spec）的 Git 演进历史、创建者、去重贡献者与 Requirement 级增删清单。
 *
 * @param repo 仓库绑定信息
 * @param capabilityPath 能力路径（如 `git-integration` 或 `identity/user-auth`）
 * @param options 可选 OpenSpec 环境信息与快照回溯条数上限（默认 20，最大 40）
 * @returns 结构化的作者、贡献者统计与逆序演进列表
 */
export async function getSpecEvolutionHistory(
  repo: RepoBinding,
  capabilityPath: string,
  options: { envInfo?: OpenSpecEnvironmentInfo; limit?: number } = {},
): Promise<SpecHistoryResponse> {
  const normalizedCap = capabilityPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (
    !normalizedCap ||
    normalizedCap.startsWith('-') ||
    normalizedCap.includes('\0') ||
    normalizedCap.split('/').some((seg) => !seg || seg === '.' || seg === '..')
  ) {
    throw new SecurityError('非法的 Spec 能力路径', 403, 'PATH_TRAVERSAL');
  }

  const resolved = resolveRepoSpecRoot(repo, options.envInfo);
  if (!resolved.openSpecDir) {
    return {
      repoId: repo.id,
      capabilityPath: normalizedCap,
      specFilePath: `openspec/specs/${normalizedCap}/spec.md`,
      isGitRepo: false,
      unavailableReason: resolved.storeMissing
        ? `关联的外部 Store (${resolved.declaredStoreId ?? ''}) 未在本机注册或不可访问`
        : '当前仓库未包含有效的 OpenSpec 规范目录',
      contributors: [],
      revisions: [],
      totalCommits: 0,
      analyzedCommits: 0,
      truncated: false,
    };
  }

  const specsDir = path.join(resolved.openSpecDir, 'specs');
  const candidateMain = normalizedCap.endsWith('.md') ? normalizedCap : `${normalizedCap}/spec.md`;
  let specAbsPath = resolveSafePathInsideRepo(specsDir, candidateMain);
  if (!fs.existsSync(specAbsPath) && !normalizedCap.endsWith('.md')) {
    const flatCandidate = resolveSafePathInsideRepo(specsDir, `${normalizedCap}.md`);
    if (fs.existsSync(flatCandidate)) {
      specAbsPath = flatCandidate;
    }
  }

  if (!fs.existsSync(specAbsPath)) {
    throw new SecurityError(`目标 Spec 文件不存在: ${normalizedCap}`, 404, 'SPEC_NOT_FOUND');
  }

  const gitRoot = findNearestGitRoot(path.dirname(specAbsPath));
  if (!gitRoot) {
    return {
      repoId: repo.id,
      capabilityPath: normalizedCap,
      specFilePath: path.relative(resolved.openSpecDir, specAbsPath).replace(/\\/g, '/'),
      isGitRepo: false,
      unavailableReason: '当前规范所在目录未初始化 Git 仓库，暂无作者与演进历史',
      contributors: [],
      revisions: [],
      totalCommits: 0,
      analyzedCommits: 0,
      truncated: false,
    };
  }

  const realSpecPath = fs.realpathSync(specAbsPath);
  const specRelToGitRoot = path.relative(gitRoot, realSpecPath).replace(/\\/g, '/');

  const separator = '<<<OPENSPEC_SPEC_COMMIT>>>';
  const fieldSep = '<<<FIELD>>>';
  let logStdout = '';
  try {
    // 注意：Git 的 --follow 必须按默认倒序遍历才能正确追踪重命名，拿到结果后再在内存中 reverse 为正序
    logStdout = await runGitReadOnly(
      gitRoot,
      [
        'log',
        '--follow',
        '--name-only',
        `--format=${separator}%H${fieldSep}%h${fieldSep}%an${fieldSep}%ae${fieldSep}%aI${fieldSep}%s`,
        '--',
        specRelToGitRoot,
      ],
      15_000,
    );
  } catch (err) {
    return {
      repoId: repo.id,
      capabilityPath: normalizedCap,
      specFilePath: specRelToGitRoot,
      isGitRepo: true,
      unavailableReason: `读取 Git 提交历史失败: ${(err as Error).message}`,
      contributors: [],
      revisions: [],
      totalCommits: 0,
      analyzedCommits: 0,
      truncated: false,
    };
  }

  const allCommitsDesc: RawSpecCommitMeta[] = [];
  let lastKnownPath = specRelToGitRoot;
  for (const block of logStdout.split(separator).filter((b) => b.trim())) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const headerParts = (lines[0] ?? '').split(fieldSep);
    if (headerParts.length < 6) {
      continue;
    }
    const [sha, shortSha, authorName, authorEmail, committedAt, ...subjectParts] = headerParts;
    const subject = subjectParts.join(fieldSep);
    // --follow --name-only 在标题行之后附带该提交对应的文件路径
    const filePathAtCommit =
      lines.length > 1
        ? decodeGitEscapedPath(lines[lines.length - 1]).replace(/\\/g, '/')
        : lastKnownPath;
    lastKnownPath = filePathAtCommit;
    allCommitsDesc.push({
      sha,
      shortSha,
      authorName,
      authorEmail,
      committedAt,
      subject,
      filePathAtCommit,
    });
  }
  const allCommits = allCommitsDesc.reverse();

  if (allCommits.length === 0) {
    return {
      repoId: repo.id,
      capabilityPath: normalizedCap,
      specFilePath: specRelToGitRoot,
      isGitRepo: true,
      unavailableReason: '当前 Spec 文件尚未提交到 Git，暂无作者与演进历史',
      contributors: [],
      revisions: [],
      totalCommits: 0,
      analyzedCommits: 0,
      truncated: false,
    };
  }

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 40);
  const startIdx = Math.max(0, allCommits.length - limit);
  const truncated = startIdx > 0;
  const baselineIdx = startIdx > 0 ? startIdx - 1 : -1;

  // 拉取窗口内提交快照；若存在截断，额外多取窗口前一位提交作为首条对比基线
  const snapshotTargetIndices: number[] = [];
  if (baselineIdx >= 0) {
    snapshotTargetIndices.push(baselineIdx);
  }
  for (let i = startIdx; i < allCommits.length; i += 1) {
    snapshotTargetIndices.push(i);
  }

  const snapshotMap = new Map<number, string | undefined>();
  const fetchedSnapshots = await mapWithConcurrency(
    snapshotTargetIndices,
    3,
    async (idx) => ({
      idx,
      content: await readGitBlobText(gitRoot, allCommits[idx].sha, allCommits[idx].filePathAtCommit),
    }),
  );
  for (const item of fetchedSnapshots) {
    snapshotMap.set(item.idx, item.content);
  }

  // 构建窗口内每次提交的语义变更明细
  const windowRevisionsChronological: SpecRevisionEntry[] = [];
  const analyzedCountsByCommitIdx = new Map<number, SpecRevisionEntry['counts']>();

  for (let i = startIdx; i < allCommits.length; i += 1) {
    const commit = allCommits[i];
    const currContent = snapshotMap.get(i);
    const hasPrevBaseline = i === 0 || snapshotMap.get(i - 1) !== undefined;

    if (currContent === undefined || !hasPrevBaseline) {
      windowRevisionsChronological.push({
        sha: commit.sha,
        shortSha: commit.shortSha,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        committedAt: commit.committedAt,
        subject: commit.subject,
        filePathAtCommit: commit.filePathAtCommit,
        analyzed: false,
        operations: [],
        changes: [],
        counts: { created: 0, added: 0, modified: 0, renamed: 0, removed: 0 },
      });
      continue;
    }

    const prevContent = i === 0 ? undefined : snapshotMap.get(i - 1);
    const initialDiff = compareSpecRequirementSnapshots(prevContent, currContent);
    let finalDiff = initialDiff;

    // 仅当同时存在新增与移除候选时，按需查询同提交内归档 Delta Spec 的 RENAMED FROM/TO
    if (prevContent !== undefined && initialDiff.counts.added > 0 && initialDiff.counts.removed > 0) {
      const deltaSpecsRaw = await readCommitMatchingDeltaSpecs(
        gitRoot,
        commit.sha,
        normalizedCap,
        commit.filePathAtCommit,
      );
      if (deltaSpecsRaw.length > 0) {
        finalDiff = compareSpecRequirementSnapshots(prevContent, currContent, { deltaSpecsRaw });
      }
    }

    analyzedCountsByCommitIdx.set(i, finalDiff.counts);
    windowRevisionsChronological.push({
      sha: commit.sha,
      shortSha: commit.shortSha,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      committedAt: commit.committedAt,
      subject: commit.subject,
      filePathAtCommit: commit.filePathAtCommit,
      analyzed: true,
      operations: finalDiff.operations,
      changes: finalDiff.changes,
      counts: finalDiff.counts,
    });
  }

  // 按小写邮箱归一化聚合全部提交中的创建者与贡献者统计
  const contributorMap = new Map<string, SpecContributorSummary>();
  let creatorKey = '';

  allCommits.forEach((commit, idx) => {
    const key =
      commit.authorEmail.trim().toLowerCase() ||
      commit.authorName.trim().toLowerCase() ||
      'unknown';
    if (idx === 0) {
      creatorKey = key;
    }

    const existing = contributorMap.get(key);
    const counts = analyzedCountsByCommitIdx.get(idx);
    if (!existing) {
      contributorMap.set(key, {
        contributorKey: key,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        isCreator: idx === 0,
        commitCount: 1,
        lastCommittedAt: commit.committedAt,
        createdCount: counts?.created ?? 0,
        addedCount: counts?.added ?? 0,
        modifiedCount: counts?.modified ?? 0,
        renamedCount: counts?.renamed ?? 0,
        removedCount: counts?.removed ?? 0,
      });
    } else {
      existing.authorName = commit.authorName;
      existing.authorEmail = commit.authorEmail || existing.authorEmail;
      existing.commitCount += 1;
      existing.lastCommittedAt = commit.committedAt;
      if (counts) {
        existing.createdCount += counts.created;
        existing.addedCount += counts.added;
        existing.modifiedCount += counts.modified;
        existing.renamedCount += counts.renamed;
        existing.removedCount += counts.removed;
      }
    }
  });

  const contributors = Array.from(contributorMap.values()).sort((a, b) => {
    if (a.isCreator !== b.isCreator) {
      return a.isCreator ? -1 : 1;
    }
    return Date.parse(b.lastCommittedAt) - Date.parse(a.lastCommittedAt);
  });

  return {
    repoId: repo.id,
    capabilityPath: normalizedCap,
    specFilePath: specRelToGitRoot,
    isGitRepo: true,
    creator: contributorMap.get(creatorKey),
    contributors,
    revisions: windowRevisionsChronological.reverse(),
    totalCommits: allCommits.length,
    analyzedCommits: analyzedCountsByCommitIdx.size,
    truncated,
  };
}
