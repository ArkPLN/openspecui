/**
 * @file 安全守卫与 Fastify 服务集成测试
 * @author ypc
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isValidProjectDirectory, RegistryManager } from '../src/registry.js';
import {
  assertTasksWritePath,
  resolveSafePathInsideRepo,
  SecurityError,
  validateGitRefOrSha,
  validateRemoteGitUrl,
} from '../src/security.js';
import { createWorkbenchServer, type WorkbenchServerInstance } from '../src/server.js';

const tempDirs: string[] = [];
const servers: WorkbenchServerInstance[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop();
    if (srv) {
      await srv.close();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Security guards', () => {
  it('validates allowed Git URLs and blocks dangerous protocols', () => {
    expect(validateRemoteGitUrl('https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
    expect(validateRemoteGitUrl('ssh://git@gitlab.com/team/app.git')).toBe('ssh://git@gitlab.com/team/app.git');
    expect(validateRemoteGitUrl('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');

    expect(() => validateRemoteGitUrl('ext::sh -c id')).toThrow(SecurityError);
    expect(() => validateRemoteGitUrl('file:///etc/passwd')).toThrow(SecurityError);
    expect(() => validateRemoteGitUrl('fd::17/foo')).toThrow(SecurityError);
    expect(() => validateRemoteGitUrl('--upload-pack=evil')).toThrow(SecurityError);
    expect(() => validateRemoteGitUrl('https://evil.com/repo.git --config')).toThrow(SecurityError);
  });

  it('prevents path traversal and restricts writes to active tasks.md', () => {
    const repoDir = makeTempDir('osui-repo-');
    fs.mkdirSync(path.join(repoDir, 'openspec', 'changes', 'feat-a'), { recursive: true });
    const tasksPath = path.join(repoDir, 'openspec', 'changes', 'feat-a', 'tasks.md');
    fs.writeFileSync(tasksPath, '- [ ] 1.1 demo\n', 'utf8');

    expect(resolveSafePathInsideRepo(repoDir, 'openspec/changes/feat-a/tasks.md')).toBe(
      fs.realpathSync(tasksPath),
    );
    expect(() => resolveSafePathInsideRepo(repoDir, '../../etc/passwd')).toThrow(SecurityError);
    expect(() => assertTasksWritePath('openspec/changes/archive/2026-01-01-a/tasks.md')).toThrow(SecurityError);
    expect(() => assertTasksWritePath('openspec/changes/feat-a/design.md')).toThrow(SecurityError);
    expect(() => validateGitRefOrSha('--exec=bad')).toThrow(SecurityError);
    expect(validateGitRefOrSha('origin/feat/add-sso')).toBe('origin/feat/add-sso');
  });
});

describe('Workbench server HTTP & CSRF boundary', () => {
  it('enforces localhost origin/CSRF token and optimistic concurrency on tasks.md', async () => {
    const appHome = makeTempDir('osui-home-');
    const repoDir = makeTempDir('osui-ws-repo-');
    const tasksFile = path.join(repoDir, 'openspec', 'changes', 'mvp', 'tasks.md');
    fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
    fs.writeFileSync(
      tasksFile,
      '# Tasks\r\n\r\n## 1. Init\r\n\r\n- [ ] 1.1 First task\r\n- [x] 1.2 Second task\r\n',
      'utf8',
    );

    const server = await createWorkbenchServer({ port: 0, appHomeDir: appHome });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // Health check & non-blocking session check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { app: string };
    expect(health.app).toBe('openspecui');

    const sessionRes = await fetch(`${baseUrl}/api/session`);
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { csrfToken: string; activeWorkspaceId: string | null };
    expect(session.csrfToken).toBe(server.csrfToken);

    // Non-project directory and user home directory must not auto-register
    const emptyDir = makeTempDir('osui-empty-dir-');
    expect(isValidProjectDirectory(emptyDir)).toBe(false);
    expect(isValidProjectDirectory(os.homedir())).toBe(false);
    const reg = new RegistryManager(makeTempDir('osui-empty-reg-'));
    expect(await reg.ensureDirectoryActivated(emptyDir)).toBeUndefined();
    expect(reg.getState().workspaces.length).toBe(0);

    // Cross-origin rejection
    const badOriginRes = await fetch(`${baseUrl}/api/workspaces`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(badOriginRes.status).toBe(403);

    // Mutating request without CSRF token rejected
    const noTokenRes = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'demo', repos: [] }),
    });
    expect(noTokenRes.status).toBe(403);

    // Create workspace with local repo
    const createRes = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenSpecUI-Token': server.csrfToken,
      },
      body: JSON.stringify({
        name: 'demo-ws',
        repos: [{ sourceType: 'local', localPath: repoDir, role: 'MAIN', kind: 'hybrid' }],
      }),
    });
    expect(createRes.status).toBe(200);
    const ws = (await createRes.json()) as { id: string; repos: Array<{ id: string }> };
    const repoId = ws.repos[0].id;

    // Fetch overview and toggle task
    const overviewRes = await fetch(`${baseUrl}/api/workspaces/${ws.id}/overview`);
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      changeGroups: Array<{
        entries: Array<{
          tasks: {
            fileHash: string;
            items: Array<{ lineNumber: number; checked: boolean; rawLine: string }>;
          };
        }>;
      }>;
    };
    const tasksDoc = overview.changeGroups[0].entries[0].tasks;
    const firstTask = tasksDoc.items[0];
    expect(firstTask.checked).toBe(false);

    const toggleRes = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenSpecUI-Token': server.csrfToken,
      },
      body: JSON.stringify({
        repoId,
        changeName: 'mvp',
        archived: false,
        fileHash: tasksDoc.fileHash,
        lineNumber: firstTask.lineNumber,
        expectedChecked: false,
        nextChecked: true,
        expectedRawLine: firstTask.rawLine,
      }),
    });
    expect(toggleRes.status).toBe(200);

    // Verify CRLF and second line preserved
    const updatedDisk = fs.readFileSync(tasksFile, 'utf8');
    expect(updatedDisk).toContain('- [x] 1.1 First task\r\n- [x] 1.2 Second task\r\n');

    // Stale fileHash triggers 409 Conflict
    const conflictRes = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenSpecUI-Token': server.csrfToken,
      },
      body: JSON.stringify({
        repoId,
        changeName: 'mvp',
        archived: false,
        fileHash: tasksDoc.fileHash,
        lineNumber: firstTask.lineNumber,
        expectedChecked: false,
        nextChecked: true,
      }),
    });
    expect(conflictRes.status).toBe(409);
  });

  it('enforces strict read-only mode when bound to 0.0.0.0', async () => {
    const appHome = makeTempDir('osui-lan-home-');
    const lanServer = await createWorkbenchServer({
      port: 0,
      host: '0.0.0.0',
      appHomeDir: appHome,
    });
    servers.push(lanServer);
    expect(lanServer.readOnlyMode).toBe(true);

    const baseUrl = `http://127.0.0.1:${lanServer.port}`;
    const sessRes = await fetch(`${baseUrl}/api/session`);
    expect(sessRes.status).toBe(200);
    const sess = (await sessRes.json()) as { readOnlyMode: boolean; csrfToken: string };
    expect(sess.readOnlyMode).toBe(true);
    expect(sess.csrfToken).toBe('');

    const writeRes = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'blocked', repos: [] }),
    });
    expect(writeRes.status).toBe(403);

    const browseRes = await fetch(`${baseUrl}/api/system/browse-dirs`);
    expect(browseRes.status).toBe(403);

    const checkoutRes = await fetch(`${baseUrl}/api/repos/demo/git/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'main' }),
    });
    expect(checkoutRes.status).toBe(403);
  });

  it('serves read-only spec history endpoint and blocks path traversal attempts', async () => {
    const appHome = makeTempDir('osui-spec-api-home-');
    const repoDir = makeTempDir('osui-spec-api-repo-');
    const specDir = path.join(repoDir, 'openspec', 'specs', 'demo-cap');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(specDir, 'spec.md'),
      '# demo-cap Specification\n\n## Requirements\n\n### Requirement: Demo Rule\nThe system SHALL work.\n',
      'utf8',
    );

    const server = await createWorkbenchServer({
      port: 0,
      host: '127.0.0.1',
      appHomeDir: appHome,
    });
    servers.push(server);

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const createRes = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenSpecUI-Token': server.csrfToken,
      },
      body: JSON.stringify({
        name: 'spec-api-ws',
        repos: [{ sourceType: 'local', localPath: repoDir, role: 'API', kind: 'hybrid' }],
      }),
    });
    expect(createRes.status).toBe(200);
    const ws = (await createRes.json()) as { id: string; repos: Array<{ id: string }> };
    const repoId = ws.repos[0].id;

    // 正常访问（非 Git 仓优雅降级）
    const okRes = await fetch(`${baseUrl}/api/repos/${repoId}/specs/history?capabilityPath=demo-cap`);
    expect(okRes.status).toBe(200);
    const payload = (await okRes.json()) as { isGitRepo: boolean; capabilityPath: string };
    expect(payload.isGitRepo).toBe(false);
    expect(payload.capabilityPath).toBe('demo-cap');

    // 拦截路径穿越
    const traversalRes = await fetch(
      `${baseUrl}/api/repos/${repoId}/specs/history?capabilityPath=${encodeURIComponent('../package.json')}`,
    );
    expect(traversalRes.status).toBe(403);
  });
});
