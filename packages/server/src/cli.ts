#!/usr/bin/env node
/**
 * @file openspecui CLI 单实例启动入口
 * @description 检测本机是否已有 openspecui 实例运行，若存在则复用并切换目标目录，否则自动探测端口启动并打开浏览器。
 * @author ypc
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getDefaultAppHomeDir } from './registry.js';
import { createWorkbenchServer } from './server.js';

interface LockFilePayload {
  pid: number;
  port: number;
  csrfToken: string;
  startedAt: string;
}

interface CliArgs {
  port: number;
  host: string;
  devMode: boolean;
  noOpen: boolean;
  targetDir: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  let port = 3456;
  let host = '127.0.0.1';
  let devMode = false;
  let noOpen = false;
  let targetDir = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dev') {
      devMode = true;
    } else if (arg === '--no-open') {
      noOpen = true;
    } else if (arg === '--host' && argv[i + 1]) {
      host = argv[i + 1].trim() || '127.0.0.1';
      i += 1;
    } else if (arg === '--port' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
        port = parsed;
      }
      i += 1;
    } else if (!arg.startsWith('-')) {
      targetDir = path.resolve(arg);
    }
  }

  return { port, host, devMode, noOpen, targetDir };
}

/** 探测指定端口是否被本地进程占用 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

/** 从起始端口向上查找可用端口 */
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 30; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return 0;
}

/** 检查锁文件记录的实例是否仍在运行 */
async function tryReuseExistingInstance(
  lockPath: string,
  targetDir: string,
): Promise<{ port: number } | null> {
  if (!fs.existsSync(lockPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(raw) as LockFilePayload;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const healthRes = await fetch(`http://127.0.0.1:${lock.port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!healthRes.ok) {
      return null;
    }
    const health = (await healthRes.json()) as { app?: string };
    if (health.app !== 'openspecui') {
      return null;
    }

    // 向已存在单实例发送目录激活请求
    const activateRes = await fetch(`http://127.0.0.1:${lock.port}/api/cli/activate-dir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenSpecUI-Token': lock.csrfToken,
      },
      body: JSON.stringify({ dirPath: targetDir }),
    });
    if (!activateRes.ok) {
      return null;
    }
    return { port: lock.port };
  } catch {
    return null;
  }
}

/** 打开本机默认浏览器（失败时不阻断 CLI 运行） */
function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const appHome = getDefaultAppHomeDir();
  fs.mkdirSync(appHome, { recursive: true });
  const lockPath = path.join(appHome, 'server.lock.json');

  const reused = await tryReuseExistingInstance(lockPath, args.targetDir);
  if (reused) {
    const url = `http://127.0.0.1:${reused.port}`;
    console.log(`[openspecui] 检测到已运行实例，已切换上下文至: ${args.targetDir}`);
    console.log(`[openspecui] 工作台地址: ${url}`);
    if (!args.noOpen) {
      openBrowser(url);
    }
    return;
  }

  const chosenPort = await findAvailablePort(args.port);
  const instance = await createWorkbenchServer({
    port: chosenPort,
    host: args.host,
    devMode: args.devMode,
    appHomeDir: appHome,
  });

  // 仅当启动目录是合法 OpenSpec/Git 项目、openspec-ui.json 或包含 OpenSpec 子项目的父目录时才自动注册激活
  if (fs.existsSync(args.targetDir)) {
    const active = await instance.registry.ensureDirectoryActivated(args.targetDir);
    if (active) {
      await instance.watcher.switchWorkspace(active);
    }
  }

  const lockPayload: LockFilePayload = {
    pid: process.pid,
    port: instance.port,
    csrfToken: instance.csrfToken,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockPayload, null, 2), { mode: 0o600 });

  const uiUrl = args.devMode ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${instance.port}`;
  console.log(`[openspecui] 本地工作台已启动: http://127.0.0.1:${instance.port}`);
  if (instance.readOnlyMode) {
    console.log('[openspecui] 已开启局域网只读查看模式（写操作与本机目录控制已禁用）');
    for (const lanUrl of instance.lanUrls) {
      console.log(`[openspecui] 局域网/手机访问地址: ${lanUrl}`);
    }
  }
  if (args.devMode) {
    console.log(`[openspecui] 开发模式前端地址: ${uiUrl}`);
  }
  if (!args.noOpen) {
    openBrowser(uiUrl);
  }

  const shutdown = async () => {
    try {
      if (fs.existsSync(lockPath)) {
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockFilePayload;
        if (current.pid === process.pid) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {
      // 忽略退出清理异常
    }
    await instance.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err) => {
  console.error('[openspecui] 启动失败:', err);
  process.exit(1);
});
