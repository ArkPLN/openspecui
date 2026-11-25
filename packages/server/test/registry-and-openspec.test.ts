/**
 * @file 工作区注册表、OpenSpec 跨仓聚合、Delta Diff 与远程只读拦截测试
 * @author ypc
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateWorkspaceChanges,
  applyTaskLineToggle,
  computeArtifactStates,
  computeChangeStage,
  parseDeltaSpecDiff,
  parseRepoChanges,
  parseTasksMarkdown,
} from '../src/openspec-parser.js';
import {
  browseLocalDirectories,
  discoverLocalRepos,
  parseOpenSpecUiConfig,
  RegistryManager,
} from '../src/registry.js';
import { RemoteRepoManager } from '../src/remote-repo.js';
import { SecurityError } from '../src/security.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('RegistryManager & discovery', () => {
  it('supports distinct worktree paths, directory scan, and remote cache isolation', async () => {
    const home = makeTempDir('osui-reg-home-');
    const parentRoot = makeTempDir('osui-scan-root-');
    const wt1 = path.join(parentRoot, 'app-wt1');
    const wt2 = path.join(parentRoot, 'app-wt2');
    fs.mkdirSync(path.join(wt1, 'openspec'), { recursive: true });
    fs.mkdirSync(path.join(wt2, '.git'), { recursive: true });
    fs.writeFileSync(path.join(wt1, 'openspec', 'config.yaml'), 'schema: spec-driven\nstore: shared-specs\n', 'utf8');

    // 默认仅扫描 OpenSpec 项目（过滤掉纯 .git 目录 app-wt2）
    const discoveredOpenSpecOnly = discoverLocalRepos(parentRoot, 2);
    expect(discoveredOpenSpecOnly.length).toBe(1);
    expect(discoveredOpenSpecOnly[0].name).toBe('app-wt1');
    expect(discoveredOpenSpecOnly[0].declaredStoreId).toBe('shared-specs');

    // 显式传 onlyOpenSpec=false 时包含纯 .git 目录
    const discoveredAll = discoverLocalRepos(parentRoot, 2, false);
    expect(discoveredAll.length).toBe(2);

    // 验证只读本机目录浏览标记 hasOpenSpec / hasGit 且排序优先 OpenSpec
    const browsed = browseLocalDirectories(parentRoot);
    expect(browsed.currentPath).toBe(fs.realpathSync(parentRoot));
    expect(browsed.entries[0].name).toBe('app-wt1');
    expect(browsed.entries[0].hasOpenSpec).toBe(true);
    expect(browsed.entries[1].name).toBe('app-wt2');
    expect(browsed.entries[1].hasGit).toBe(true);
    expect(() => browseLocalDirectories(path.join(parentRoot, 'not-exist-dir'))).toThrow(SecurityError);

    const registry = new RegistryManager(home);
    const repo1 = registry.buildLocalRepoBinding({
      localPath: wt1,
      role: 'FE',
      kind: 'hybrid',
      sourceType: 'local',
    });
    const repo2 = registry.buildLocalRepoBinding({
      localPath: wt2,
      role: 'FE-WT2',
      kind: 'hybrid',
      sourceType: 'local',
    });
    const ws = await registry.createWorkspace({ name: 'multi-wt', repos: [] }, [repo1, repo2]);
    expect(ws.repos.length).toBe(2);

    // 跨仓项目（仓库）关联组创建与持久化
    const repoLink = await registry.addRepoLink(ws.id, {
      title: 'Frontend Dual Worktrees',
      repoIds: [repo1.id, repo2.id],
    });
    expect(repoLink.repoIds).toEqual([repo1.id, repo2.id]);

    // Verify persistence reload
    const reloaded = new RegistryManager(home);
    expect(reloaded.getWorkspace(ws.id)?.repos.length).toBe(2);
    expect(reloaded.getWorkspace(ws.id)?.repoLinks?.length).toBe(1);
    expect(reloaded.getWorkspace(ws.id)?.repoLinks?.[0].title).toBe('Frontend Dual Worktrees');

    // 移除成员仓库后，不足 2 个成员的项目关联组应自动清理
    await reloaded.removeRepoFromWorkspace(ws.id, repo2.id);
    expect(reloaded.getWorkspace(ws.id)?.repoLinks?.length).toBe(0);

    const remoteMgr = new RemoteRepoManager(reloaded);
    const cacheDir = remoteMgr.getCacheDirForUrl('https://github.com/org/demo.git');
    expect(cacheDir.startsWith(reloaded.remoteCacheRootDir)).toBe(true);
  });
});

describe('OpenSpec cross-repo aggregation & Delta diff', () => {
  it('aggregates mixed active/archived changes, manual links, and delta vs main spec diffs', async () => {
    const home = makeTempDir('osui-parse-home-');
    const feDir = makeTempDir('osui-fe-');
    const beDir = makeTempDir('osui-be-');

    // FE: active add-sso + active fe-only-ui
    fs.mkdirSync(path.join(feDir, 'openspec', 'changes', 'add-sso', 'specs', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(feDir, 'openspec', 'changes', 'add-sso', 'tasks.md'),
      '- [x] 1.1 Login button\n- [ ] 1.2 Callback route\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(feDir, 'openspec', 'changes', 'add-sso', 'specs', 'auth', 'spec.md'),
      '# Spec Delta\n\n## ADDED Requirements\n\n### Requirement: SSO Button\nSystem SHALL render SSO button.\n',
      'utf8',
    );

    // BE: archived 2026-11-25-add-sso + main spec auth + active be-sso-api
    fs.mkdirSync(path.join(beDir, 'openspec', 'specs', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(beDir, 'openspec', 'specs', 'auth', 'spec.md'),
      '# Auth Spec\n\n## Purpose\nAuthentication service.\n\n## Requirements\n\n### Requirement: Token Issue\nSystem SHALL issue JWT.\n',
      'utf8',
    );
    fs.mkdirSync(path.join(beDir, 'openspec', 'changes', 'archive', '2026-11-25-add-sso', 'specs', 'auth'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(beDir, 'openspec', 'changes', 'archive', '2026-11-25-add-sso', 'tasks.md'),
      '- [x] 1.1 OAuth verify\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(beDir, 'openspec', 'changes', 'archive', '2026-11-25-add-sso', 'specs', 'auth', 'spec.md'),
      '# Spec Delta\n\n## MODIFIED Requirements\n\n### Requirement: Token Issue\nSystem SHALL issue JWT for SSO.\n',
      'utf8',
    );

    const registry = new RegistryManager(home);
    const feRepo = registry.buildLocalRepoBinding({ localPath: feDir, role: 'FE', kind: 'hybrid', sourceType: 'local' });
    const beRepo = registry.buildLocalRepoBinding({ localPath: beDir, role: 'BE', kind: 'hybrid', sourceType: 'local' });
    const ws = await registry.createWorkspace({ name: 'shop', repos: [] }, [feRepo, beRepo]);

    const allEntries = [...parseRepoChanges(feRepo), ...parseRepoChanges(beRepo)];
    const groups = aggregateWorkspaceChanges(ws, allEntries);

    expect(groups.length).toBe(1);
    expect(groups[0].title).toBe('add-sso');
    expect(groups[0].aggregateStatus).toBe('mixed');
    expect(groups[0].totalProgress).toEqual({ completed: 2, total: 3 });

    const beEntry = groups[0].entries.find((e) => e.repoId === beRepo.id)!;
    expect(beEntry.archived).toBe(true);
    expect(beEntry.archivedDate).toBe('2026-11-25');
    expect(beEntry.archivedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(beEntry.archivedAt!))).toBe(false);
    expect(beEntry.deltaDiffs[0].hasMainSpec).toBe(true);
    expect(beEntry.deltaDiffs[0].items[0].operation).toBe('MODIFIED');
    expect(beEntry.deltaDiffs[0].items[0].beforeMarkdown).toContain('System SHALL issue JWT.');

    const deltaNew = parseDeltaSpecDiff('new-cap', 'specs/new-cap/spec.md', '## ADDED Requirements\n\n### Requirement: New\nTest');
    expect(deltaNew.hasMainSpec).toBe(false);
    expect(deltaNew.items[0].operation).toBe('ADDED');

    // Reject task toggle on remote repo
    const remoteRepo = { ...feRepo, sourceType: 'remote' as const };
    const tasksDoc = parseTasksMarkdown('- [ ] 1.1 Demo\n', 'openspec/changes/add-sso/tasks.md', true);
    expect(tasksDoc.readOnly).toBe(true);
    expect(() =>
      applyTaskLineToggle(remoteRepo, {
        repoId: remoteRepo.id,
        changeName: 'add-sso',
        archived: false,
        fileHash: tasksDoc.fileHash,
        lineNumber: 1,
        expectedChecked: false,
        nextChecked: true,
      }),
    ).toThrow(SecurityError);
  });

  it('supports openspec-ui.json config import, Ideas CRUD, and lifecycle stage/artifact computation', async () => {
    const home = makeTempDir('osui-compat-home-');
    const configRoot = makeTempDir('osui-ui-json-');
    const subA = path.join(configRoot, 'web-app');
    const subB = path.join(configRoot, 'api-srv');
    fs.mkdirSync(path.join(subA, 'openspec'), { recursive: true });
    fs.mkdirSync(path.join(subB, 'openspec'), { recursive: true });
    fs.writeFileSync(
      path.join(configRoot, 'openspec-ui.json'),
      JSON.stringify({ sources: [{ name: 'web', path: './web-app' }, { name: 'api', path: './api-srv' }] }),
      'utf8',
    );

    const parsedSources = parseOpenSpecUiConfig(configRoot);
    expect(parsedSources.length).toBe(2);

    const registry = new RegistryManager(home);
    const activated = await registry.ensureDirectoryActivated(configRoot);
    expect(activated?.repos.length).toBe(2);

    // Ideas CRUD & reload
    const idea = await registry.addIdea(activated!.id, {
      repoId: activated!.repos[0].id,
      title: 'Add dark mode',
      description: 'Support theme switch',
    });
    const idea2 = await registry.addIdea(activated!.id, {
      repoId: activated!.repos[1].id,
      title: 'Reorder board items',
      description: 'Support drag-and-drop sorting',
    });
    expect(idea.title).toBe('Add dark mode');
    await registry.updateIdea(activated!.id, idea.id, { title: 'Add light/dark theme' });

    // Custom order (repos, changeOrder, ideaOrder) & restart persistence
    const reversedRepoIds = [activated!.repos[1].id, activated!.repos[0].id];
    await registry.updateWorkspaceOrder(activated!.id, {
      repoIds: reversedRepoIds,
      changeOrder: ['change-b', 'change-a'],
      ideaOrder: [idea2.id, idea.id],
    });

    const reloaded = new RegistryManager(home);
    const reloadedWs = reloaded.getWorkspace(activated!.id);
    expect(reloadedWs?.repos.map((repo) => repo.id)).toEqual(reversedRepoIds);
    expect(reloadedWs?.ideas.map((item) => item.id)).toEqual([idea2.id, idea.id]);
    expect(reloadedWs?.ideas[1].title).toBe('Add light/dark theme');
    expect(reloadedWs?.customOrder).toEqual({
      changeOrder: ['change-b', 'change-a'],
      ideaOrder: [idea2.id, idea.id],
    });
    expect(await reloaded.deleteIdea(activated!.id, idea.id)).toBe(true);
    expect(await reloaded.deleteIdea(activated!.id, idea2.id)).toBe(true);

    // Artifact states & stage computation
    const planningArts = computeArtifactStates({
      hasProposal: true,
      hasSpecs: false,
      hasDesign: false,
      hasTasks: false,
    });
    expect(planningArts.find((a) => a.id === 'proposal')?.status).toBe('done');
    expect(planningArts.find((a) => a.id === 'specs')?.status).toBe('next');
    expect(planningArts.find((a) => a.id === 'tasks')?.status).toBe('blocked');
    expect(planningArts.find((a) => a.id === 'tasks')?.blockedBy).toEqual(['specs', 'design']);

    const fullArts = { hasProposal: true, hasSpecs: true, hasDesign: true, hasTasks: true };
    expect(computeChangeStage(false, { ...fullArts, hasTasks: false }, { completed: 0, total: 0 })).toBe('planning');
    expect(computeChangeStage(false, fullArts, { completed: 0, total: 3 })).toBe('ready_to_apply');
    expect(computeChangeStage(false, fullArts, { completed: 1, total: 3 })).toBe('in_progress');
    expect(computeChangeStage(false, fullArts, { completed: 3, total: 3 })).toBe('complete');
    expect(computeChangeStage(true, fullArts, { completed: 3, total: 3 })).toBe('archived');
  });
});
