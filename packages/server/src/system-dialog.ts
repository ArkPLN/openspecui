/**
 * @file 跨平台本机系统文件夹选择弹窗封装
 * @description 通过受控 execFile 调用宿主机原生文件夹选择对话框，避免浏览器沙箱无法读取本地绝对路径的限制。
 * @author ypc
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSafeCommand, SecurityError } from './security.js';

export interface PickFolderResult {
  cancelled: boolean;
  path?: string;
}

/**
 * 调起宿主机系统原生文件夹选择器并返回选中的规范化绝对路径。
 * 使用 TopMost 隐藏窗体作为父窗口，防止在 Windows 下弹窗被浏览器遮挡。
 */
export async function pickLocalFolderDialog(initialPath?: string): Promise<PickFolderResult> {
  const validInitial =
    initialPath && fs.existsSync(initialPath) ? path.resolve(initialPath) : undefined;

  if (process.platform === 'win32') {
    const escapedInitial = validInitial ? validInitial.replace(/'/g, "''") : '';
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "选择本地项目或工作区目录"',
      '$dialog.ShowNewFolderButton = $false',
      escapedInitial ? `$dialog.SelectedPath = '${escapedInitial}'` : '',
      'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
      '$owner.Dispose()',
    ]
      .filter(Boolean)
      .join('; ');

    try {
      const res = await execSafeCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        { timeoutMs: 120_000 },
      );
      const selected = res.stdout.trim();
      if (!selected) {
        return { cancelled: true };
      }
      return { cancelled: false, path: fs.realpathSync(selected) };
    } catch (err) {
      throw new SecurityError(
        `调起系统文件夹选择框失败: ${(err as Error).message}`,
        500,
        'FOLDER_DIALOG_FAILED',
      );
    }
  }

  if (process.platform === 'darwin') {
    try {
      const res = await execSafeCommand(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "选择本地项目目录")'],
        { timeoutMs: 120_000 },
      );
      const selected = res.stdout.trim();
      return selected
        ? { cancelled: false, path: fs.realpathSync(selected) }
        : { cancelled: true };
    } catch {
      return { cancelled: true };
    }
  }

  // Linux 优先尝试 zenity，取消或未安装时返回 cancelled/提示
  try {
    const args = ['--file-selection', '--directory', '--title=选择本地项目目录'];
    if (validInitial) {
      args.push(`--filename=${validInitial}/`);
    }
    const res = await execSafeCommand('zenity', args, { timeoutMs: 120_000 });
    const selected = res.stdout.trim();
    return selected
      ? { cancelled: false, path: fs.realpathSync(selected) }
      : { cancelled: true };
  } catch {
    return { cancelled: true };
  }
}
