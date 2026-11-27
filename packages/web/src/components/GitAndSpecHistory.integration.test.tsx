import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkbenchServer, type WorkbenchServerInstance } from '../../../server/src/server';
import { api, type WorkspaceOverviewResponse } from '../api';
import { GitActivityView } from './GitActivityView';
import { SpecHistoryPanel } from './SpecHistoryPanel';
import { useState } from 'react';

let server: WorkbenchServerInstance;
let serverUrl: string;
let tempRoot: string;
let emptyGitConfigPath: string;
const nativeFetch = globalThis.fetch;

function runGit(cwd: string, args: string[], date?: string): string {
  const dateEnv = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyGitConfigPath,
      ...dateEnv,
    },
  });
}

function makeTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(tempRoot, prefix));
  return directory;
}

function initRepo(prefix: string): string {
  const directory = makeTempDir(prefix);
  runGit(directory, ['init', '-b', 'main']);
  runGit(directory, ['config', 'user.name', 'Tester']);
  runGit(directory, ['config', 'user.email', 'tester@example.com']);
  fs.writeFileSync(path.join(directory, 'README.md'), 'initial\n', 'utf8');
  runGit(directory, ['add', '.']);
  runGit(directory, ['commit', '-m', 'initial commit'], '2026-01-01T00:00:00Z');
  return directory;
}

function commitFile(
  directory: string,
  relativePath: string,
  content: string,
  message: string,
  authorName: string,
  authorEmail: string,
  date: string,
): void {
  const filePath = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  runGit(directory, ['config', 'user.name', authorName]);
  runGit(directory, ['config', 'user.email', authorEmail]);
  runGit(directory, ['add', '.']);
  runGit(directory, ['commit', '-m', message], date);
}

async function createLocalWorkspace(name: string, repositories: Array<{ directory: string; role: string }>) {
  return api.createWorkspace({
    name,
    repos: repositories.map(({ directory, role }) => ({
      sourceType: 'local',
      localPath: directory,
      role,
      kind: 'hybrid',
    })),
  });
}

async function addRemoteCache(workspaceId: string, sourceDirectory: string) {
  const remoteUrl = `https://example.invalid/acme/${workspaceId}.git`;
  const cacheDirectory = server.remoteManager.getCacheDirForUrl(remoteUrl);
  fs.mkdirSync(path.dirname(cacheDirectory), { recursive: true });
  if (!fs.existsSync(path.join(cacheDirectory, '.git'))) {
    runGit(tempRoot, ['clone', '--quiet', sourceDirectory, cacheDirectory]);
  }
  const repo = await server.remoteManager.addRemoteRepoToWorkspace(workspaceId, {
    sourceType: 'remote',
    remoteUrl,
    name: '远程缓存',
    role: 'REMOTE',
    kind: 'hybrid',
    autoSyncIntervalMinutes: 0,
  });
  return { repo, cacheDirectory };
}

async function getAvailablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    throw new Error('无法获取测试端口');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function installDomEnvironmentShims(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: () => undefined,
  });
  if (!globalThis.PointerEvent) {
    globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osui-web-git-history-'));
  emptyGitConfigPath = path.join(tempRoot, 'empty.gitconfig');
  fs.writeFileSync(emptyGitConfigPath, '', 'utf8');
  const port = await getAvailablePort();
  server = await createWorkbenchServer({
    port,
    host: '127.0.0.1',
    devMode: true,
    appHomeDir: path.join(tempRoot, 'app-home'),
  });
  serverUrl = `http://127.0.0.1:${server.port}`;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), serverUrl);
    const headers = new Headers(init?.headers);
    headers.set('Origin', serverUrl);
    return nativeFetch(url, { ...init, headers });
  }) as typeof fetch;
  installDomEnvironmentShims();
  await api.initSession();
}, 30_000);

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  await server?.close();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}, 30_000);

function GitActivityHarness({
  initialOverview,
  readOnlyMode = false,
}: {
  initialOverview: WorkspaceOverviewResponse;
  readOnlyMode?: boolean;
}) {
  const [overview, setOverview] = useState(initialOverview);
  const refresh = async () => setOverview(await api.getOverview(overview.workspace.id));

  return (
    <GitActivityView
      workspace={overview.workspace}
      gitStatuses={overview.gitStatuses}
      readOnlyMode={readOnlyMode}
      onRefresh={() => void refresh()}
    />
  );
}

async function chooseBranch(user: ReturnType<typeof userEvent.setup>, repoName: string, branch: string) {
  await user.click(screen.getByRole('combobox', { name: `切换 ${repoName} 分支` }));
  await user.click(await screen.findByRole('option', { name: branch }));
}

describe('GitActivityView 真实 API 集成', () => {
  it('保留只读规则、仓库状态、远程缓存标识和 Diff 查看', async () => {
    const user = userEvent.setup();
    const localDirectory = initRepo('readonly-local-');
    const nonGitDirectory = makeTempDir('readonly-nongit-');
    const workspace = await createLocalWorkspace('readonly-workspace', [
      { directory: localDirectory, role: 'FE' },
      { directory: nonGitDirectory, role: 'DOC' },
    ]);
    await addRemoteCache(workspace.id, localDirectory);
    fs.writeFileSync(path.join(localDirectory, 'README.md'), 'initial\nreadonly change\n', 'utf8');
    const overview = await api.getOverview(workspace.id);

    render(<GitActivityHarness initialOverview={overview} readOnlyMode />);

    expect(await screen.findByText('线上只读缓存')).toBeInTheDocument();
    expect(screen.getByText('非 Git 仓库')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /切换 .* 分支/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /解绑仓库/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即同步' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '1 个未提交改动' }));
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('+readonly change')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: '查看 FE initial commit 的代码 Diff' }),
    ).toBeInTheDocument();
    const shortSha = runGit(localDirectory, ['rev-parse', '--short', 'HEAD']).trim();
    await user.click(screen.getByRole('button', { name: '查看 FE initial commit 的代码 Diff' }));
    expect(await screen.findByText(`[FE] ${shortSha} · initial commit`)).toBeInTheDocument();
    expect(screen.getByText('+initial')).toBeInTheDocument();
  }, 30_000);

  it('通过真实分支切换 API 更新状态，并为游离 HEAD 使用禁用哨兵选项', async () => {
    const user = userEvent.setup();
    const directory = initRepo('branch-local-');
    runGit(directory, ['branch', 'feature/ui']);
    const workspace = await createLocalWorkspace('branch-workspace', [{ directory, role: 'FE' }]);
    const overview = await api.getOverview(workspace.id);
    const view = render(<GitActivityHarness initialOverview={overview} />);

    await chooseBranch(user, path.basename(directory), 'feature/ui');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: `切换 ${path.basename(directory)} 分支` })).toHaveTextContent(
        'feature/ui',
      );
    });
    expect(runGit(directory, ['branch', '--show-current']).trim()).toBe('feature/ui');

    view.unmount();
    runGit(directory, ['checkout', '--detach']);
    const detachedOverview = await api.getOverview(workspace.id);
    render(<GitActivityHarness initialOverview={detachedOverview} />);
    const trigger = screen.getByRole('combobox', { name: `切换 ${path.basename(directory)} 分支` });
    expect(trigger.textContent).toMatch(/detached/);
    await user.click(trigger);
    const detachedOption = await screen.findByRole('option', { name: /detached/ });
    expect(detachedOption).toHaveAttribute('data-disabled');
  }, 30_000);

  it('展示真实分支冲突错误并保留未提交修改', async () => {
    const user = userEvent.setup();
    const directory = initRepo('conflict-local-');
    runGit(directory, ['checkout', '-b', 'feature/conflict']);
    fs.writeFileSync(path.join(directory, 'README.md'), 'branch change\n', 'utf8');
    runGit(directory, ['add', '.']);
    runGit(directory, ['commit', '-m', 'change branch content'], '2026-01-02T00:00:00Z');
    runGit(directory, ['checkout', 'main']);
    fs.writeFileSync(path.join(directory, 'README.md'), 'local change\n', 'utf8');
    const workspace = await createLocalWorkspace('conflict-workspace', [{ directory, role: 'FE' }]);
    const overview = await api.getOverview(workspace.id);

    render(<GitActivityHarness initialOverview={overview} />);
    await chooseBranch(user, path.basename(directory), 'feature/conflict');

    expect(await screen.findByText('分支切换失败')).toBeInTheDocument();
    expect(screen.getByText(/已保留未提交修改/)).toBeInTheDocument();
    expect(fs.readFileSync(path.join(directory, 'README.md'), 'utf8')).toBe('local change\n');
    expect(runGit(directory, ['branch', '--show-current']).trim()).toBe('main');

    await user.click(screen.getByRole('button', { name: `关闭 ${path.basename(directory)} 分支错误` }));
    expect(screen.queryByText('分支切换失败')).not.toBeInTheDocument();
  }, 30_000);

  it('使用真实同步 API 展示远程缓存同步错误', async () => {
    const user = userEvent.setup();
    const sourceDirectory = initRepo('remote-sync-source-');
    const workspace = await createLocalWorkspace('remote-sync-workspace', []);
    const { repo } = await addRemoteCache(workspace.id, sourceDirectory);
    const overview = await api.getOverview(workspace.id);

    render(<GitActivityHarness initialOverview={overview} />);
    await user.click(await screen.findByRole('button', { name: '立即同步' }));

    expect(await screen.findByText('仓库操作失败')).toBeInTheDocument();
    await waitFor(() => {
      const updated = server.registry.getWorkspace(workspace.id)?.repos.find((item) => item.id === repo.id);
      expect(updated?.syncState).toBe('error');
      expect(updated?.lastError).toBeTruthy();
    });
    expect(await screen.findByRole('button', { name: '立即同步' })).toBeEnabled();
  }, 30_000);

  it('为远程解绑提供取消、仅解绑、解绑并清理缓存三个真实动作', async () => {
    const user = userEvent.setup();
    const sourceDirectory = initRepo('remote-unbind-source-');
    const workspace = await createLocalWorkspace('remote-unbind-workspace', []);
    const first = await addRemoteCache(workspace.id, sourceDirectory);
    const overview = await api.getOverview(workspace.id);
    const view = render(<GitActivityHarness initialOverview={overview} />);

    await user.click(await screen.findByRole('button', { name: '解绑仓库 远程缓存' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '仅解绑' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '解绑并清理缓存' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(server.registry.getWorkspace(workspace.id)?.repos).toHaveLength(1);
    expect(fs.existsSync(first.cacheDirectory)).toBe(true);

    await user.click(screen.getByRole('button', { name: '解绑仓库 远程缓存' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '仅解绑' }));
    await waitFor(() => expect(server.registry.getWorkspace(workspace.id)?.repos).toHaveLength(0));
    await waitFor(() => expect(screen.queryByRole('button', { name: '解绑仓库 远程缓存' })).not.toBeInTheDocument());
    expect(fs.existsSync(first.cacheDirectory)).toBe(true);

    const second = await addRemoteCache(workspace.id, sourceDirectory);
    view.unmount();
    const refreshedOverview = await api.getOverview(workspace.id);
    render(<GitActivityHarness initialOverview={refreshedOverview} />);
    await user.click(await screen.findByRole('button', { name: '解绑仓库 远程缓存' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '解绑并清理缓存' }),
    );
    await waitFor(() => expect(server.registry.getWorkspace(workspace.id)?.repos).toHaveLength(0));
    await waitFor(() => expect(fs.existsSync(second.cacheDirectory)).toBe(false));
  }, 30_000);

  it('通过真实时间线 API 展示加载错误', async () => {
    const workspace = await createLocalWorkspace('timeline-error-workspace', []);
    await api.deleteWorkspace(workspace.id);
    render(
      <GitActivityView
        workspace={workspace}
        gitStatuses={[]}
        onRefresh={() => undefined}
      />,
    );

    expect(await screen.findByText('加载 Git 活动时间线失败')).toBeInTheDocument();
    expect(screen.getByText('工作区不存在')).toBeInTheDocument();
  }, 30_000);
});

async function createSpecRepository(): Promise<string> {
  const directory = initRepo('spec-history-');
  const initialSpec = [
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
  ].join('\n');
  commitFile(
    directory,
    'openspec/specs/auth/spec.md',
    initialSpec,
    'feat(spec): create auth spec',
    'Alice',
    'Alice@Example.com',
    '2026-02-01T00:00:00Z',
  );

  const updatedSpec = [
    '# auth Specification',
    '',
    '## Purpose',
    '认证规范',
    '',
    '## Requirements',
    '',
    '### Requirement: 基础登录',
    'The system SHALL verify username, password and MFA code.',
    '',
    '### Requirement: 一次性口令登录',
    'The system SHALL verify one-time temporary token.',
    '',
    '### Requirement: 刷新令牌',
    'The system SHALL issue refresh tokens.',
    '',
  ].join('\n');
  commitFile(
    directory,
    'openspec/specs/auth/spec.md',
    updatedSpec,
    'feat(spec): rename login and add refresh token',
    'Bob',
    'bob@example.com',
    '2026-02-02T00:00:00Z',
  );

  const removedSpec = updatedSpec.replace(
    '\n### Requirement: 刷新令牌\nThe system SHALL issue refresh tokens.\n',
    '',
  );
  commitFile(
    directory,
    'openspec/specs/auth/spec.md',
    removedSpec,
    'fix(spec): remove refresh token requirement',
    'Alice',
    'alice@example.com',
    '2026-02-03T00:00:00Z',
  );
  return directory;
}

describe('SpecHistoryPanel 真实 API 集成', () => {
  it('展示贡献者、Requirement 时间线、折叠操作并刷新真实历史', async () => {
    const user = userEvent.setup();
    const directory = await createSpecRepository();
    const workspace = await createLocalWorkspace('spec-history-workspace', [{ directory, role: 'BE' }]);
    const repoId = workspace.repos[0].id;
    render(<SpecHistoryPanel repoId={repoId} capabilityPath="auth" />);

    expect(await screen.findByText('feat(spec): create auth spec')).toBeInTheDocument();
    expect(screen.getByText('feat(spec): rename login and add refresh token')).toBeInTheDocument();
    expect(screen.getByText('fix(spec): remove refresh token requirement')).toBeInTheDocument();
    expect(screen.getByText('创建者：')).toBeInTheDocument();
    expect(screen.getByText('创建者')).toBeInTheDocument();
    expect(screen.getByText('追加功能点')).toBeInTheDocument();
    expect(screen.getByText('修改功能点')).toBeInTheDocument();
    expect(screen.getByText('重命名')).toBeInTheDocument();
    expect(screen.getByText('移除功能点')).toBeInTheDocument();
    expect(screen.getByText('一次性口令登录')).toBeInTheDocument();

    const contributors = screen.getByRole('list', { name: 'Spec 贡献者' });
    expect(within(contributors).getAllByRole('listitem')).toHaveLength(2);
    expect(within(contributors).getByText('Alice')).toBeInTheDocument();
    expect(within(contributors).getByText('Bob')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '收起演进清单' }));
    expect(screen.queryByText('feat(spec): create auth spec')).not.toBeInTheDocument();
    expect(within(contributors).getByText('Alice')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开演进清单 (3)' }));
    expect(await screen.findByText('feat(spec): create auth spec')).toBeInTheDocument();

    const latestRevision = screen.getByRole('listitem', {
      name: /fix\(spec\): remove refresh token requirement/,
    });
    await user.click(within(latestRevision).getByRole('button', { name: /收起 .* 功能点清单/ }));
    expect(within(latestRevision).queryByText('移除功能点')).not.toBeInTheDocument();
    await user.click(within(latestRevision).getByRole('button', { name: /展开 .* 功能点清单/ }));
    expect(within(latestRevision).getByText('移除功能点')).toBeInTheDocument();

    const currentSpec = fs.readFileSync(path.join(directory, 'openspec/specs/auth/spec.md'), 'utf8');
    commitFile(
      directory,
      'openspec/specs/auth/spec.md',
      currentSpec.replace('认证规范', '认证规范与安全登录说明'),
      'docs(spec): clarify purpose',
      'Carol',
      'carol@example.com',
      '2026-02-04T00:00:00Z',
    );
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('docs(spec): clarify purpose')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Spec 贡献者' })).getByText('Carol'),
    ).toBeInTheDocument();
  }, 30_000);

  it('通过真实分页请求加载更早的 Spec 提交', async () => {
    const directory = initRepo('spec-pagination-');
    let specContent = '# auth Specification\n\n## Requirements\n\n### Requirement: Demo\nTest\n';
    commitFile(
      directory,
      'openspec/specs/auth/spec.md',
      specContent,
      'feat(spec): create paginated spec',
      'Alice',
      'alice@example.com',
      '2026-03-01T00:00:00Z',
    );
    for (let index = 1; index <= 20; index += 1) {
      specContent += `\nRevision ${index}\n`;
      commitFile(
        directory,
        'openspec/specs/auth/spec.md',
        specContent,
        `docs(spec): revision ${index}`,
        'Alice',
        'alice@example.com',
        new Date(Date.UTC(2026, 2, 1 + index)).toISOString(),
      );
    }
    const workspace = await createLocalWorkspace('spec-pagination-workspace', [{ directory, role: 'BE' }]);
    render(<SpecHistoryPanel repoId={workspace.repos[0].id} capabilityPath="auth" />);

    const loadMore = await screen.findByRole('button', {
      name: '加载更多早期提交（最多分析最近 40 次）',
    });
    expect(screen.queryByText('feat(spec): create paginated spec')).not.toBeInTheDocument();
    await userEvent.setup().click(loadMore);
    expect(await screen.findByText('feat(spec): create paginated spec')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '加载更多早期提交（最多分析最近 40 次）' }),
    ).not.toBeInTheDocument();
  }, 30_000);

  it('展示真实 API 返回的仓库错误并支持重试', async () => {
    const user = userEvent.setup();
    render(<SpecHistoryPanel repoId="missing-repo" capabilityPath="auth" />);

    expect(await screen.findByText('加载 Spec 演进历史失败')).toBeInTheDocument();
    expect(screen.getByText('仓库不存在')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('仓库不存在')).toBeInTheDocument();
  }, 30_000);

  it('展示非 Git 仓库的降级提示', async () => {
    const directory = makeTempDir('spec-nongit-');
    fs.mkdirSync(path.join(directory, 'openspec/specs/auth'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'openspec/specs/auth/spec.md'),
      '# auth Specification\n\n## Requirements\n\n### Requirement: Demo\nTest\n',
      'utf8',
    );
    const workspace = await createLocalWorkspace('spec-nongit-workspace', [{ directory, role: 'DOC' }]);
    render(<SpecHistoryPanel repoId={workspace.repos[0].id} capabilityPath="auth" />);

    expect(await screen.findByText('暂无 Git 演进历史')).toBeInTheDocument();
    expect(screen.getByText(/未初始化 Git/)).toBeInTheDocument();
  }, 30_000);
});
