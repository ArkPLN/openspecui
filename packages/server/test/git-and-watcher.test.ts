/**
 * @file Git 只读集成与按需文件监听测试
 * @author ypc
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getRepoDiff,
  getRepoGitStatus,
  getWorkspaceGitTimeline,
  matchChangeToGitAcrossWorkspace,
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
});
