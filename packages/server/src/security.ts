/**
 * @file 服务端安全守卫与受控子进程执行器
 * @description 提供路径穿越校验、Git URL 协议白名单、Origin/CSRF 检查及无 Shell 插值的安全命令执行。
 * @author ypc
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 统一安全错误类型，便于路由层映射为 HTTP 400/403 */
export class SecurityError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 403, code = 'SECURITY_VIOLATION') {
    super(message);
    this.name = 'SecurityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 合法的 SCP 风格 SSH Git 地址正则（如 git@github.com:org/repo.git） */
const SCP_GIT_URL_PATTERN = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._~:/@+-]+$/;

/** 允许的 Git 分支/Ref 字符白名单（禁止空白、控制字符、前导短横线） */
const SAFE_GIT_REF_PATTERN = /^(?!-)[a-zA-Z0-9._/@{}+-]+$/;

/**
 * 校验并规范化线上 Git URL。
 * 严格放行 https/http/ssh/SCP 风格地址，显式拦截 file://、ext::、fd:: 及参数注入。
 *
 * @param rawUrl 用户输入的线上 Git 地址
 * @returns 去除首尾空白后的合法 URL
 */
export function validateRemoteGitUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new SecurityError('Git URL 不能为空', 400, 'INVALID_GIT_URL');
  }
  if (trimmed.startsWith('-')) {
    throw new SecurityError('非法 Git URL：禁止以短横线开头', 400, 'INVALID_GIT_URL');
  }
  if (/[\s\r\n\0]/.test(trimmed)) {
    throw new SecurityError('非法 Git URL：包含空白或控制字符', 400, 'INVALID_GIT_URL');
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('ext::') ||
    lower.startsWith('fd::') ||
    lower.startsWith('file://') ||
    lower.includes('::')
  ) {
    throw new SecurityError('安全策略禁止使用 file://、ext:: 等本地/扩展传输协议', 400, 'UNSAFE_GIT_PROTOCOL');
  }

  if (lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('ssh://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new SecurityError('无效的 Git URL 格式', 400, 'INVALID_GIT_URL');
    }
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new SecurityError('不支持的 Git 协议或缺少主机名', 400, 'UNSAFE_GIT_PROTOCOL');
    }
    return trimmed;
  }

  if (SCP_GIT_URL_PATTERN.test(trimmed)) {
    return trimmed;
  }

  throw new SecurityError(
    '仅支持 https://、http://、ssh:// 或 git@host:owner/repo.git 格式的 Git 地址',
    400,
    'UNSAFE_GIT_PROTOCOL',
  );
}

/**
 * 校验 Git 分支名或 Commit SHA，防止参数注入。
 *
 * @param ref 分支名或 Commit SHA
 * @returns 校验通过的 ref
 */
export function validateGitRefOrSha(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.includes('..') || !SAFE_GIT_REF_PATTERN.test(trimmed)) {
    throw new SecurityError(`非法 Git 引用或 SHA: ${ref}`, 400, 'INVALID_GIT_REF');
  }
  return trimmed;
}

/**
 * 规范化并将相对路径约束在已注册仓库根目录内，防止 `..` 与软链接越界。
 *
 * @param repoRoot 仓库根目录绝对路径
 * @param relativePath 相对路径
 * @returns 解析并验证后的真实绝对路径
 */
export function resolveSafePathInsideRepo(repoRoot: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new SecurityError('非法的仓库相对路径', 403, 'PATH_TRAVERSAL');
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(repoRoot);
  } catch {
    throw new SecurityError('目标仓库目录不存在或不可访问', 404, 'REPO_NOT_FOUND');
  }

  const candidate = path.resolve(canonicalRoot, relativePath);
  // 若目标文件已存在，解析其 realpath 以防软链接逃逸；否则校验父目录链
  const targetToCheck = fs.existsSync(candidate)
    ? fs.realpathSync(candidate)
    : path.resolve(fs.realpathSync(findExistingAncestor(candidate)), path.relative(findExistingAncestor(candidate), candidate));

  const normalizedRoot = normalizeForPrefixCheck(canonicalRoot);
  const normalizedTarget = normalizeForPrefixCheck(targetToCheck);

  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new SecurityError('拒绝越权路径访问：目标路径超出工作区仓库边界', 403, 'PATH_TRAVERSAL');
  }

  return targetToCheck;
}

/**
 * 查找路径中存在的最近祖先目录，用于未创建文件时的软链接逃逸检测。
 */
function findExistingAncestor(targetPath: string): string {
  let current = path.dirname(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

/** Windows 下路径比较忽略大小写并去除末尾分隔符 */
function normalizeForPrefixCheck(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const trimmed = resolved.length > 3 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * 严格校验写入路径是否仅针对 `openspec/changes/<name>/tasks.md`（或归档外活跃 tasks.md）。
 *
 * @param relativePath 规范化相对路径
 */
export function assertTasksWritePath(relativePath: string): void {
  const unixPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  // 仅允许 openspec/changes/<changeName>/tasks.md（禁止归档目录与其余任何文件）
  const match = /^openspec\/changes\/([^/]+)\/tasks\.md$/.exec(unixPath);
  if (!match || match[1] === 'archive' || match[1] === '.' || match[1] === '..') {
    throw new SecurityError('仅允许回写活跃变更下的 openspec/changes/<name>/tasks.md', 403, 'WRITE_FORBIDDEN');
  }
}

/**
 * 判断规范化子路径是否严格位于受控父目录下（用于删除缓存目录前兜底）。
 */
export function isStrictlyInsideDirectory(parentDir: string, childPath: string): boolean {
  if (!fs.existsSync(parentDir) || !fs.existsSync(childPath)) {
    return false;
  }
  const realParent = normalizeForPrefixCheck(fs.realpathSync(parentDir));
  const realChild = normalizeForPrefixCheck(fs.realpathSync(childPath));
  return realChild !== realParent && realChild.startsWith(`${realParent}${path.sep}`);
}

/**
 * 校验请求 Origin / Host 是否属于本机合法来源，防御恶意网页跨站 CSRF。
 * 显式开启局域网只读模式（allowLan）时允许局域网 Host/Origin，且路由层会同时拦截所有写操作。
 */
export function isAllowedLocalRequest(
  hostHeader: string | undefined,
  originHeader: string | undefined,
  serverPort: number,
  devMode: boolean,
  allowLan = false,
): boolean {
  if (allowLan) {
    return true;
  }
  if (hostHeader) {
    const allowedHosts = new Set([
      `127.0.0.1:${serverPort}`,
      `localhost:${serverPort}`,
    ]);
    if (!allowedHosts.has(hostHeader)) {
      return false;
    }
  }

  if (!originHeader) {
    // 非浏览器直接 curl / CLI 同机调用无 Origin，允许（写接口仍需 CSRF Token）
    return true;
  }

  try {
    const parsed = new URL(originHeader);
    const isLocalHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (!isLocalHost) {
      return false;
    }
    if (Number(parsed.port) === serverPort) {
      return true;
    }
    // 开发模式下允许 Vite 默认端口访问
    if (devMode && (parsed.port === '5173' || parsed.port === '4173')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface SafeExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  env?: Record<string, string | undefined>;
}

export interface SafeExecResult {
  stdout: string;
  stderr: string;
}

/**
 * 无 Shell 插值的受控子进程执行器。
 * 对 git 命令自动注入非交互环境变量，防止凭证弹窗阻塞后台服务。
 */
export async function execSafeCommand(
  command: string,
  args: string[],
  options: SafeExecOptions = {},
): Promise<SafeExecResult> {
  const isGit = path.basename(command).toLowerCase().replace(/\.exe$/, '') === 'git';
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  };

  if (isGit) {
    mergedEnv.GIT_TERMINAL_PROMPT = '0';
    mergedEnv.GCM_INTERACTIVE = 'never';
    // 若用户未显式覆盖，注入非交互 SSH 参数，防止 SSH 密码提示卡死
    if (!mergedEnv.GIT_SSH_COMMAND) {
      mergedEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
    }
  }

  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBufferBytes ?? 10 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    env: mergedEnv,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
