/**
 * @file 前端 REST API 与 WebSocket 客户端封装
 * @description 统一管理 CSRF Token 注入、工作区/OpenSpec/Git 接口调用及实时事件订阅。
 * @author ypc
 */

import type {
  AddRepoInput,
  CreateChangeLinkInput,
  CreateIdeaInput,
  CreateRepoLinkInput,
  CreateWorkspaceInput,
  CrossRepoChangeGroup,
  DirectoryBrowseResult,
  DiscoveredRepoCandidate,
  GitCommitItem,
  GitDiffResult,
  GitRepoStatus,
  MainSpecEntry,
  OpenSpecEnvironmentInfo,
  RegistryStoreData,
  RepoBinding,
  SetBranchPinInput,
  SpecHistoryResponse,
  TasksDocument,
  ToggleTaskInput,
  UpdateIdeaInput,
  UpdateWorkspaceOrderInput,
  Workspace,
  WorkspaceIdea,
  WsServerMessage,
} from '@openspecui/shared';

export interface WorkspaceOverviewResponse {
  workspace: Workspace;
  changeGroups: CrossRepoChangeGroup[];
  mainSpecs: MainSpecEntry[];
  gitStatuses: GitRepoStatus[];
  env: OpenSpecEnvironmentInfo;
}

export interface RepoChangeGitMatchResponse {
  repoId: string;
  isRelated: boolean;
  matchedBranch?: string;
  matchReason: 'manual-pin' | 'branch-name' | 'commit-message' | 'current-branch' | 'none';
  isPinned: boolean;
  commits: GitCommitItem[];
  status: GitRepoStatus;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let currentCsrfToken = '';

export function setCsrfToken(token: string): void {
  currentCsrfToken = token;
}

async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && currentCsrfToken) {
    headers.set('X-OpenSpecUI-Token', currentCsrfToken);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ApiError('请求本地服务超时，请检查仓库状态或重试', 408, 'REQUEST_TIMEOUT');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(
      parsed.message || `请求失败 (${res.status})`,
      res.status,
      parsed.error || 'UNKNOWN_ERROR',
    );
  }
  return parsed as T;
}

export const api = {
  async initSession(): Promise<{
    csrfToken: string;
    activeWorkspaceId: string | null;
    readOnlyMode: boolean;
    lanUrls: string[];
  }> {
    const data = await requestJson<{
      csrfToken: string;
      activeWorkspaceId: string | null;
      readOnlyMode: boolean;
      lanUrls: string[];
    }>('/api/session', {}, 6_000);
    setCsrfToken(data.csrfToken);
    return data;
  },

  async getEnv(refreshEnv = false): Promise<{ env: OpenSpecEnvironmentInfo }> {
    return requestJson(`/api/env${refreshEnv ? '?refreshEnv=1' : ''}`, {}, 12_000);
  },

  listWorkspaces(): Promise<RegistryStoreData> {
    return requestJson('/api/workspaces');
  },

  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    return requestJson('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteWorkspace(id: string, cleanupCache = false): Promise<{ ok: boolean; activeWorkspaceId: string | null }> {
    return requestJson(`/api/workspaces/${id}?cleanupCache=${cleanupCache}`, {
      method: 'DELETE',
    });
  },

  activateWorkspace(id: string): Promise<Workspace> {
    return requestJson(`/api/workspaces/${id}/activate`, {
      method: 'POST',
    });
  },

  addRepo(workspaceId: string, input: AddRepoInput): Promise<{ repo: RepoBinding; workspace: Workspace }> {
    return requestJson(`/api/workspaces/${workspaceId}/repos`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  removeRepo(workspaceId: string, repoId: string, cleanupCache = false): Promise<{ ok: boolean; workspace: Workspace }> {
    return requestJson(`/api/workspaces/${workspaceId}/repos/${repoId}?cleanupCache=${cleanupCache}`, {
      method: 'DELETE',
    });
  },

  syncRemoteRepo(workspaceId: string, repoId: string): Promise<{ repo: RepoBinding }> {
    return requestJson(
      `/api/workspaces/${workspaceId}/repos/${repoId}/sync`,
      { method: 'POST' },
      90_000,
    );
  },

  discoverRepos(
    rootPath: string,
    maxDepth = 2,
    onlyOpenSpec = true,
  ): Promise<{ candidates: DiscoveredRepoCandidate[] }> {
    return requestJson('/api/workspaces/discover', {
      method: 'POST',
      body: JSON.stringify({ rootPath, maxDepth, onlyOpenSpec }),
    });
  },

  browseDirs(targetPath?: string): Promise<DirectoryBrowseResult> {
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    return requestJson(`/api/system/browse-dirs${query}`);
  },

  pickFolder(initialPath?: string): Promise<{ cancelled: boolean; path?: string }> {
    return requestJson(
      '/api/system/pick-folder',
      {
        method: 'POST',
        body: JSON.stringify({ initialPath }),
      },
      125_000,
    );
  },

  importWorkset(name: string, members: string[]): Promise<Workspace> {
    return requestJson('/api/workspaces/import-workset', {
      method: 'POST',
      body: JSON.stringify({ name, members }),
    });
  },

  importOpenSpecUiJson(dirPath: string): Promise<Workspace> {
    return requestJson('/api/workspaces/import-openspec-ui-json', {
      method: 'POST',
      body: JSON.stringify({ dirPath }),
    });
  },

  createIdea(workspaceId: string, input: CreateIdeaInput): Promise<WorkspaceIdea> {
    return requestJson(`/api/workspaces/${workspaceId}/ideas`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  updateIdea(workspaceId: string, ideaId: string, input: UpdateIdeaInput): Promise<WorkspaceIdea> {
    return requestJson(`/api/workspaces/${workspaceId}/ideas/${ideaId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  deleteIdea(workspaceId: string, ideaId: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/workspaces/${workspaceId}/ideas/${ideaId}`, {
      method: 'DELETE',
    });
  },

  updateWorkspaceOrder(workspaceId: string, input: UpdateWorkspaceOrderInput): Promise<Workspace> {
    return requestJson(`/api/workspaces/${workspaceId}/order`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  getOverview(workspaceId: string): Promise<WorkspaceOverviewResponse> {
    return requestJson(`/api/workspaces/${workspaceId}/overview`);
  },

  toggleTask(workspaceId: string, input: ToggleTaskInput): Promise<TasksDocument> {
    return requestJson(`/api/workspaces/${workspaceId}/tasks`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  createRepoLink(workspaceId: string, input: CreateRepoLinkInput) {
    return requestJson(`/api/workspaces/${workspaceId}/repo-links`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteRepoLink(workspaceId: string, linkId: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/workspaces/${workspaceId}/repo-links/${linkId}`, {
      method: 'DELETE',
    });
  },

  createChangeLink(workspaceId: string, input: CreateChangeLinkInput) {
    return requestJson(`/api/workspaces/${workspaceId}/change-links`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteChangeLink(workspaceId: string, linkId: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/workspaces/${workspaceId}/change-links/${linkId}`, {
      method: 'DELETE',
    });
  },

  setBranchPin(workspaceId: string, input: SetBranchPinInput) {
    return requestJson(`/api/workspaces/${workspaceId}/branch-pins`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  getGitTimeline(workspaceId: string): Promise<{ commits: GitCommitItem[] }> {
    return requestJson(`/api/workspaces/${workspaceId}/git/timeline`);
  },

  matchChangeGit(
    workspaceId: string,
    changeKey: string,
    names: string[],
    ownerRepoIds: string[] = [],
  ): Promise<{ matches: RepoChangeGitMatchResponse[] }> {
    const params = new URLSearchParams({
      changeKey,
      names: names.join(','),
      ownerRepoIds: ownerRepoIds.join(','),
    });
    return requestJson(`/api/workspaces/${workspaceId}/git/match?${params.toString()}`);
  },

  getRepoDiff(repoId: string, target: string): Promise<GitDiffResult> {
    const params = new URLSearchParams({ target });
    return requestJson(`/api/repos/${repoId}/git/diff?${params.toString()}`);
  },

  getSpecHistory(repoId: string, capabilityPath: string, limit = 20): Promise<SpecHistoryResponse> {
    const params = new URLSearchParams({
      capabilityPath,
      limit: String(limit),
    });
    return requestJson(`/api/repos/${repoId}/specs/history?${params.toString()}`, {}, 20_000);
  },

  checkoutBranch(repoId: string, branch: string): Promise<{ status: GitRepoStatus }> {
    return requestJson(`/api/repos/${repoId}/git/checkout`, {
      method: 'POST',
      body: JSON.stringify({ branch }),
    });
  },
};

/**
 * 建立 WebSocket 连接并在断线后自动重连，将服务端消息转发给回调。
 */
export function connectWorkbenchSocket(onMessage: (msg: WsServerMessage) => void): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    socket = new WebSocket(wsUrl);

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        if (msg.type === 'server:hello' && msg.csrfToken) {
          setCsrfToken(msg.csrfToken);
        }
        onMessage(msg);
      } catch {
        // 忽略格式异常消息
      }
    };

    socket.onclose = () => {
      if (!closed) {
        retryTimer = window.setTimeout(connect, 1800);
      }
    };
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
    }
    socket?.close();
  };
}
