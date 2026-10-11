import net from 'node:net';
import { pathIdentity, ReviewError } from './runtime.mjs';

function address(local, kind) {
  const id = pathIdentity(local);
  if (process.platform === 'win32') return `\\\\.\\pipe\\media-review-${kind}-${id}`;
  if (process.platform === 'linux') return `\0media-review-${kind}-${id}`;
  // 其他系统用内核持有的回环门闩，不创建可能永久残留的socket锁文件。
  const value = Number.parseInt(id.slice(kind === 'startup' ? 0 : 8, kind === 'startup' ? 8 : 16), 16);
  return { host: '127.0.0.1', port: 49152 + value % 16384, exclusive: true };
}

export async function tryServiceLock(local, kind, metadata = {}) {
  const server = net.createServer(socket => {
    socket.on('error', () => {}); socket.setTimeout(1500, () => socket.destroy());
    socket.end(JSON.stringify({ app: 'media-review-lock/v1', dataId: pathIdentity(local), kind, ...metadata }) + '\n');
  });
  server.maxConnections = 16;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(address(local, kind), resolve);
    });
  } catch (cause) {
    if (cause.code === 'EADDRINUSE') return null;
    throw cause;
  }
  server.on('error', () => {});
  let closing;
  return {
    update(value) { Object.assign(metadata, value); },
    close() { return closing ??= new Promise(resolve => server.close(resolve)); },
  };
}

export async function inspectServiceLock(local, kind) {
  return new Promise(resolve => {
    const socket = net.connect(address(local, kind));
    let text = '', done = false;
    const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish(null)); socket.on('error', () => finish(null));
    socket.on('data', chunk => {
      text += chunk.toString('utf8');
      if (text.length > 4096) return finish(null);
      if (!text.includes('\n')) return;
      try {
        const value = JSON.parse(text);
        finish(value.app === 'media-review-lock/v1' && value.dataId === pathIdentity(local) && value.kind === kind ? value : null);
      } catch { finish(null); }
    });
    socket.on('end', () => finish(null));
  });
}

export async function startupLock(local, inspect, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const live = await inspect();
    if (live) return { live, lock: null };
    const lock = await tryServiceLock(local, 'startup');
    if (lock) {
      try { return { live: await inspect(), lock }; }
      catch (cause) { await lock.close(); throw cause; }
    }
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 100));
  }
  throw new ReviewError('校对室仍在启动或本机门闩被占用；没有另起服务，也没有结束未知进程。请稍后重试。', 'startup_busy');
}
