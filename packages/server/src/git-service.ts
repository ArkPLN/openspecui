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
  RepoBinding,
  Workspace,
} from '@openspecui/shared';
import { execSafeCommand, SecurityError, validateGitRefOrSha } from './security.js';

const MAX_DIFF_FILES = 60;
const MAX_PATCH_BYTES = 120 * 1024;

/** 判断目录是否为 Git 仓库 */
function isGitDirectory(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.git'));
}

/** 包装只读 git 调用，遇到 index.lock 时做短暂退避重试 */
async function runGitReadOnly(repoPath: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await execSafeCommand('git', args, { cwd: repoPath, timeoutMs });
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
        const filePath = parts.slice(8).join(' ').split('\t')[0];
        dirtyFiles.push({ path: filePath, status: xy });
      } else if (line.startsWith('u ')) {
        const parts = line.split(' ');
        const filePath = parts.slice(10).join(' ');
        dirtyFiles.push({ path: filePath, status: 'UU' });
      } else if (line.startsWith('? ')) {
        dirtyFiles.push({ path: line.slice(2).trim(), status: '??' });
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
    const fullChunk = `diff --git ${chunk}`;
    const firstLine = chunk.split(/\r?\n/, 1)[0] ?? '';
    const pathMatch = /^a\/(.+?)\s+b\/(.+)$/.exec(firstLine);
    const filePath = pathMatch ? pathMatch[2] : firstLine;

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
