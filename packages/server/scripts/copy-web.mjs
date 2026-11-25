/**
 * @file 构建后复制前端产物至服务端 dist/public 目录
 * @author ypc
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, '..');
const webDist = path.resolve(serverRoot, '../web/dist');
const targetPublic = path.resolve(serverRoot, 'dist/public');

if (fs.existsSync(webDist)) {
  fs.rmSync(targetPublic, { recursive: true, force: true });
  fs.cpSync(webDist, targetPublic, { recursive: true });
  console.log(`[copy-web] 已嵌入前端构建产物至 ${targetPublic}`);
} else {
  console.warn(`[copy-web] 未找到前端构建目录 (${webDist})，跳过静态资源复制`);
}
