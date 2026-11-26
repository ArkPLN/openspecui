/**
 * @file Git 只读集成与按需文件监听测试
 * @author ypc
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeGitEscapedPath,
  getRepoDiff,
  getRepoGitStatus,
  getSpecEvolutionHistory,
  getWorkspaceGitTimeline,
  matchChangeToGitAcrossWorkspace,
  parseDiffGitHeaderPaths,
  parseUnifiedDiffOutput,
  switchRepoBranch,
} from '../src/git-service.js';
import { RegistryManager } from '../src/registry.js';
import { execSafeCommand } from '../src/security.js';
import { RemoteRepoManager } from '../src/remote-repo.js';
import { LazyWatcherManager } from '../src/watcher.js';

const tempDirs: string[] = [];
const watchers: LazyWatcherManager[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initGitRepo(dir: string, branch: string, fileName: string, message: string): Promise<void> {
  await execSafeCommand('git', ['init', '-b', branch], { cwd: dir });
  await execSafeCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execSafeCommand('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  fs.writeFileSync(path.join(dir, fileName), 'v1\n', 'utf8');
  await execSafeCommand('git', ['add', '.'], { cwd: dir });
  await execSafeCommand('git', ['commit', '-m', message], { cwd: dir });
}

afterEach(async () => {
  while (watchers.length > 0) {
    const w = watchers.pop();
    if (w) {
      await w.closeAll();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Git read-only integration & LazyWatcher', () => {
  it('inspects independent branches, timeline, change matching, diffs, and degrades for non-git dir', async () => {
    const home = makeTempDir('osui-git-home-');
    const feDir = makeTempDir('osui-git-fe-');
    const beDir = makeTempDir('osui-git-be-');
    const nonGitDir = makeTempDir('osui-nongit-');

    await initGitRepo(feDir, 'main', 'app.ts', 'chore: init fe');
    await initGitRepo(beDir, 'feat/add-sso', 'server.ts', 'feat(add-sso): initial sso endpoint');
    // Create uncommitted modification in BE
    fs.writeFileSync(path.join(beDir, 'server.ts'), 'v1\nv2\n', 'utf8');

    const registry = new RegistryManager(home);
    const feRepo = registry.buildLocalRepoBinding({ localPath: feDir, role: 'FE', kind: 'code', sourceType: 'local' });
    const beRepo = registry.buildLocalRepoBinding({ localPath: beDir, role: 'BE', kind: 'code', sourceType: 'local' });
    const nonGitRepo = registry.buildLocalRepoBinding({ localPath: nonGitDir, role: 'DOC', kind: 'code', sourceType: 'local' });

    const ws = await registry.createWorkspace({ name: 'git-ws', repos: [] }, [feRepo, beRepo, nonGitRepo]);

    const feStatus = await getRepoGitStatus(feRepo);
    const beStatus = await getRepoGitStatus(beRepo);
    const docStatus = await getRepoGitStatus(nonGitRepo);

    expect(feStatus.branch).toBe('main');
    expect(feStatus.dirtyCount).toBe(0);
    expect(beStatus.branch).toBe('feat/add-sso');
    expect(beStatus.dirtyCount).toBe(1);
    expect(docStatus.isGitRepo).toBe(false);
    expect(docStatus.error).toBe('非 Git 仓库');

    const timeline = await getWorkspaceGitTimeline(ws);
    expect(timeline.length).toBe(2);

    const matches = await matchChangeToGitAcrossWorkspace(ws, 'slug:add-sso', ['add-sso'], [beRepo.id]);
    const feMatch = matches.find((m) => m.repoId === feRepo.id)!;
    const beMatch = matches.find((m) => m.repoId === beRepo.id)!;
    const docMatch = matches.find((m) => m.repoId === nonGitRepo.id)!;
    expect(beMatch.isRelated).toBe(true);
    expect(beMatch.matchReason).toBe('branch-name');
    expect(beMatch.matchedBranch).toBe('feat/add-sso');
    // 无关仓库（非所属且未命中分支/提交）必须标记为 isRelated=false
    expect(feMatch.isRelated).toBe(false);
    expect(docMatch.isRelated).toBe(false);

    const diff = await getRepoDiff(beRepo, 'working-tree');
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].path).toBe('server.ts');
    expect(diff.files[0].patch).toContain('+v2');

    // 安全切换分支：FE 新建并切换分支成功；BE 因含冲突未提交改动被安全拒绝且保留改动
    await execSafeCommand('git', ['branch', 'feat/ui-refresh'], { cwd: feDir });
    const switchedFe = await switchRepoBranch(feRepo, 'feat/ui-refresh');
    expect(switchedFe.branch).toBe('feat/ui-refresh');

    await execSafeCommand('git', ['checkout', '-b', 'feat/conflict-base'], { cwd: beDir }).catch(() => {});
    // 为 BE 创建分支并确保切到不同内容分支时存在冲突
    await execSafeCommand('git', ['branch', 'other-branch'], { cwd: beDir });
    // 修改被跟踪文件后提交在 another 分支造成与工作区改动冲突
    await execSafeCommand('git', ['checkout', '-b', 'diverged-branch'], { cwd: beDir });
    fs.writeFileSync(path.join(beDir, 'server.ts'), 'v1\nbranch-change\n', 'utf8');
    await execSafeCommand('git', ['add', 'server.ts'], { cwd: beDir });
    await execSafeCommand('git', ['commit', '-m', 'diverge server.ts'], { cwd: beDir });
    await execSafeCommand('git', ['checkout', 'feat/add-sso'], { cwd: beDir });
    fs.writeFileSync(path.join(beDir, 'server.ts'), 'v1\nv2\n', 'utf8');
    await expect(switchRepoBranch(beRepo, 'diverged-branch')).rejects.toThrow(/切换分支失败/);
    expect(fs.readFileSync(path.join(beDir, 'server.ts'), 'utf8')).toBe('v1\nv2\n');

    // Lazy watcher switches cleanly, ignores non-OpenSpec/non-Git dirs, and releases old watchers
    const watcher = new LazyWatcherManager(() => {});
    watchers.push(watcher);
    await watcher.switchWorkspace(ws);
    expect(watcher.getActiveWatcherCount()).toBe(2);

    await watcher.switchWorkspace(undefined);
    expect(watcher.getActiveWatcherCount()).toBe(0);
  });

  it('handles remote git sync failure non-blockingly and cleans up unused cache safely', async () => {
    const home = makeTempDir('osui-remote-home-');
    const registry = new RegistryManager(home);
    const remoteMgr = new RemoteRepoManager(registry);
    const ws = await registry.createWorkspace({ name: 'remote-test', repos: [] }, []);

    // Add remote repo pointing to closed local port (fast connection refused, non-blocking)
    const added = await remoteMgr.addRemoteRepoToWorkspace(ws.id, {
      sourceType: 'remote',
      remoteUrl: 'http://127.0.0.1:9/org/nonexistent.git',
      role: 'REMOTE',
      kind: 'hybrid',
    });
    expect(added.sourceType).toBe('remote');

    const synced = await remoteMgr.syncRemoteRepo(ws.id, added.id);
    expect(synced.syncState).toBe('error');
    expect(synced.lastError).toBeTruthy();

    // Unbind and clean up cache directory
    const { removed, stillReferencedElsewhere } = await registry.removeRepoFromWorkspace(ws.id, added.id);
    expect(removed?.id).toBe(added.id);
    expect(stillReferencedElsewhere).toBe(false);
    remoteMgr.dispose();
  });

  it('tracks spec creator, deduplicates contributors by email, follows renames, and lists added/removed requirements', async () => {
    const home = makeTempDir('osui-spec-hist-home-');
    const repoDir = makeTempDir('osui-spec-hist-repo-');
    const nonGitDir = makeTempDir('osui-spec-hist-nongit-');

    const registry = new RegistryManager(home);
    const repo = registry.buildLocalRepoBinding({
      localPath: repoDir,
      role: 'BE',
      kind: 'hybrid',
      sourceType: 'local',
    });
    const nonGitRepo = registry.buildLocalRepoBinding({
      localPath: nonGitDir,
      role: 'DOC',
      kind: 'hybrid',
      sourceType: 'local',
    });

    // 非 Git 目录含 spec.md 时应优雅降级
    fs.mkdirSync(path.join(nonGitDir, 'openspec', 'specs', 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(nonGitDir, 'openspec', 'specs', 'demo', 'spec.md'),
      '# demo Specification\n\n## Requirements\n\n### Requirement: Demo\nTest\n',
      'utf8',
    );
    const nonGitHistory = await getSpecEvolutionHistory(nonGitRepo, 'demo');
    expect(nonGitHistory.isGitRepo).toBe(false);
    expect(nonGitHistory.unavailableReason).toContain('未初始化 Git');

    // 初始化 Git 仓库并模拟多作者演进与路径移动（--follow）
    await execSafeCommand('git', ['init', '-b', 'main'], { cwd: repoDir });
    const oldSpecDir = path.join(repoDir, 'openspec', 'specs', 'legacy-auth');
    fs.mkdirSync(oldSpecDir, { recursive: true });
    fs.writeFileSync(
      path.join(oldSpecDir, 'spec.md'),
      [
        '# legacy-auth Specification',
        '',
        '## Purpose',
        '认证规范',
        '',
        '## Requirements',
        '',
        '### Requirement: 基础登录',
        'The system SHALL verify username and password.',
        '',
        '### Requirement: 临时口令登录',
        'The system SHALL verify one-time temporary token.',
      ].join('\n'),
      'utf8',
    );
    await execSafeCommand('git', ['config', 'user.name', 'Alice'], { cwd: repoDir });
    await execSafeCommand('git', ['config', 'user.email', 'Alice@Example.com'], { cwd: repoDir });
    await execSafeCommand('git', ['add', '.'], { cwd: repoDir });
    await execSafeCommand('git', ['commit', '-m', 'feat(spec): create auth spec'], { cwd: repoDir });

    // C2: Bob 移动目录并追加新功能点
    const newSpecDir = path.join(repoDir, 'openspec', 'specs', 'auth');
    fs.mkdirSync(newSpecDir, { recursive: true });
    await execSafeCommand('git', ['mv', 'openspec/specs/legacy-auth/spec.md', 'openspec/specs/auth/spec.md'], {
      cwd: repoDir,
    });
    fs.writeFileSync(
      path.join(newSpecDir, 'spec.md'),
      [
        '# auth Specification',
        '',
        '## Purpose',
        '认证规范',
        '',
        '## Requirements',
        '',
        '### Requirement: 基础登录',
        'The system SHALL verify username and password.',
        '',
        '### Requirement: 临时口令登录',
        'The system SHALL verify one-time temporary token.',
        '',
        '### Requirement: 刷新令牌',
        'The system SHALL issue refresh tokens.',
      ].join('\n'),
      'utf8',
    );
    await execSafeCommand('git', ['config', 'user.name', 'Bob'], { cwd: repoDir });
    await execSafeCommand('git', ['config', 'user.email', 'bob@example.com'], { cwd: repoDir });
    await execSafeCommand('git', ['add', '.'], { cwd: repoDir });
    await execSafeCommand('git', ['commit', '-m', 'feat(spec): move to auth and add refresh token'], { cwd: repoDir });

    // C3: Alice 用不同大小写邮箱移除了“临时口令登录”并修改了“基础登录”
    fs.writeFileSync(
      path.join(newSpecDir, 'spec.md'),
      [
        '# auth Specification',
        '',
        '## Purpose',
        '认证规范',
        '',
        '## Requirements',
        '',
        '### Requirement: 基础登录',
        'The system SHALL verify username, password, and MFA.',
        '',
        '### Requirement: 刷新令牌',
        'The system SHALL issue refresh tokens.',
      ].join('\n'),
      'utf8',
    );
    await execSafeCommand('git', ['config', 'user.name', 'Alice Chen'], { cwd: repoDir });
    await execSafeCommand('git', ['config', 'user.email', 'alice@example.com'], { cwd: repoDir });
    await execSafeCommand('git', ['add', '.'], { cwd: repoDir });
    await execSafeCommand('git', ['commit', '-m', 'refactor(spec): enforce MFA and drop temp token'], { cwd: repoDir });

    const history = await getSpecEvolutionHistory(repo, 'auth');
    expect(history.isGitRepo).toBe(true);
    expect(history.totalCommits).toBe(3);
    expect(history.analyzedCommits).toBe(3);
    expect(history.truncated).toBe(false);

    // 创建者与按小写邮箱去重的贡献者统计
    expect(history.creator?.authorEmail.toLowerCase()).toBe('alice@example.com');
    expect(history.creator?.isCreator).toBe(true);
    expect(history.contributors.length).toBe(2);

    const aliceSummary = history.contributors.find((c) => c.contributorKey === 'alice@example.com')!;
    expect(aliceSummary.authorName).toBe('Alice Chen');
    expect(aliceSummary.commitCount).toBe(2);
    expect(aliceSummary.createdCount).toBe(2);
    expect(aliceSummary.modifiedCount).toBe(1);
    expect(aliceSummary.removedCount).toBe(1);

    const bobSummary = history.contributors.find((c) => c.contributorKey === 'bob@example.com')!;
    expect(bobSummary.isCreator).toBe(false);
    expect(bobSummary.addedCount).toBe(1);

    // 逆序时间线：C3 -> C2 -> C1
    expect(history.revisions[0].operations).toEqual(['MODIFIED', 'REMOVED']);
    expect(history.revisions[0].changes.find((c) => c.operation === 'REMOVED')?.name).toBe('临时口令登录');
    expect(history.revisions[1].operations).toEqual(['ADDED']);
    expect(history.revisions[1].changes[0].name).toBe('刷新令牌');
    expect(history.revisions[2].operations).toEqual(['CREATED']);
    expect(history.revisions[2].filePathAtCommit).toBe('openspec/specs/legacy-auth/spec.md');

    // 窗口截断（limit=2）时仍保留完整创建者与全量贡献者计数，且首条展示变更依然准确
    const windowed = await getSpecEvolutionHistory(repo, 'auth', { limit: 2 });
    expect(windowed.totalCommits).toBe(3);
    expect(windowed.analyzedCommits).toBe(2);
    expect(windowed.truncated).toBe(true);
    expect(windowed.creator?.contributorKey).toBe('alice@example.com');
    expect(windowed.revisions.length).toBe(2);
    expect(windowed.revisions[1].operations).toEqual(['ADDED']);
  });

  it('decodes octal-escaped and quoted UTF-8 file paths across diff parsing and real git inspections', async () => {
    // 1. 单元测试：还原 C 风格八进制 UTF-8 路径与双引号 Diff 头
    const octalPath =
      '"a/sql/2026/20260922\\347\\220\\206\\350\\256\\272\\350\\257\\276\\345\\240\\202/20261125\\347\\272\\277\\344\\270\\213\\346\\224\\266\\346\\254\\276\\347\\231\\273\\350\\256\\260\\346\\235\\203\\351\\231\\220\\350\\241\\245\\351\\275\\220.sql"';
    const octalPathB = octalPath.replace('"a/', '"b/');
    const expectedChinesePath = 'sql/2026/20260922理论课堂/20261125线下收款登记权限补齐.sql';

    expect(decodeGitEscapedPath(octalPath)).toBe(`a/${expectedChinesePath}`);
    expect(parseDiffGitHeaderPaths(`${octalPath} ${octalPathB}`)).toEqual({
      oldPath: expectedChinesePath,
      newPath: expectedChinesePath,
    });

    // 单边引号重命名与含空格路径
    expect(parseDiffGitHeaderPaths('a/plain.sql "b/目录 空格/新 文件.sql"')).toEqual({
      oldPath: 'plain.sql',
      newPath: '目录 空格/新 文件.sql',
    });

    const rawOctalDiff = [
      `diff --git ${octalPath} ${octalPathB}`,
      'new file mode 100644',
      'index 0000000..f5737d4',
      '--- /dev/null',
      `+++ ${octalPathB}`,
      '@@ -0,0 +1,1 @@',
      '+SELECT 1;',
    ].join('\n');
    const parsedRaw = parseUnifiedDiffOutput(rawOctalDiff);
    expect(parsedRaw.files.length).toBe(1);
    expect(parsedRaw.files[0].path).toBe(expectedChinesePath);
    expect(parsedRaw.files[0].status).toBe('added');
    expect(parsedRaw.files[0].patch).toContain(`diff --git a/${expectedChinesePath} b/${expectedChinesePath}`);
    expect(parsedRaw.files[0].patch).toContain(`+++ b/${expectedChinesePath}`);
    expect(parsedRaw.files[0].patch).not.toContain('\\347');

    // 2. 真实 Git 集成验证：中文目录 + 中文文件名 + 空格路径
    const home = makeTempDir('osui-utf8-home-');
    const repoDir = makeTempDir('osui-utf8-repo-');
    const registry = new RegistryManager(home);
    const repo = registry.buildLocalRepoBinding({
      localPath: repoDir,
      role: 'SQL',
      kind: 'code',
      sourceType: 'local',
    });

    await execSafeCommand('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execSafeCommand('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
    await execSafeCommand('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoDir });

    const targetAbs = path.join(repoDir, expectedChinesePath);
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, 'SELECT 1;\n', 'utf8');
    await execSafeCommand('git', ['add', '.'], { cwd: repoDir });
    await execSafeCommand('git', ['commit', '-m', 'feat(sql): add chinese path script'], { cwd: repoDir });

    // 获取刚提交的 SHA 并验证 getRepoDiff
    const headRes = await execSafeCommand('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    const headSha = headRes.stdout.trim();
    const commitDiff = await getRepoDiff(repo, headSha);
    expect(commitDiff.files.length).toBe(1);
    expect(commitDiff.files[0].path).toBe(expectedChinesePath);
    expect(commitDiff.files[0].patch).not.toContain('\\347');

    // 未提交修改中文含空格文件名，验证 getRepoGitStatus 与 working-tree Diff
    const spaceChinesePath = 'sql/2026/20260922理论课堂/带 空格.sql';
    const spaceAbs = path.join(repoDir, spaceChinesePath);
    fs.writeFileSync(spaceAbs, 'SELECT 2;\n', 'utf8');
    const status = await getRepoGitStatus(repo);
    expect(status.dirtyFiles.some((f) => f.path === spaceChinesePath)).toBe(true);

    await execSafeCommand('git', ['add', spaceChinesePath], { cwd: repoDir });
    const wtDiff = await getRepoDiff(repo, 'working-tree');
    expect(wtDiff.files.some((f) => f.path === spaceChinesePath)).toBe(true);
  });
});
