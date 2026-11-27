import net from 'node:net';
import { createWorkbenchServer } from '../../server/src/server.js';

async function findAvailablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') {
    throw new Error('无法获取测试服务端口');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

const appHomeDir = process.argv[2];
if (!appHomeDir) {
  throw new Error('缺少测试服务数据目录');
}

const port = await findAvailablePort();
const instance = await createWorkbenchServer({ port, host: '127.0.0.1', appHomeDir });
process.stdout.write(`OPENSPECUI_TEST_SERVER=${JSON.stringify({ port: instance.port })}\n`);

const close = async () => {
  await instance.close();
  process.exit(0);
};

process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
