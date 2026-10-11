import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewServer } from './app.mjs';
import { UI_REVISION, SERVICE_PROTOCOL, runtimePaths, ordinaryDirectory, readJson, atomicJson, pathIdentity } from './runtime.mjs';
import { tryServiceLock } from './service-lock.mjs';
import { liveReview } from './open.mjs';

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
let lock, app;
try {
  const location = await runtimePaths(root); await ordinaryDirectory(location.local);
  if (await liveReview(root)) process.exitCode = 0;
  else {
    lock = await tryServiceLock(location.local, 'runtime', { protocol: SERVICE_PROTOCOL, uiRevision: UI_REVISION, rootId: pathIdentity(root), state: 'starting' });
    if (!lock) throw new Error('同一数据目录已有服务在启动或运行，未另起写入服务');
    let port = 0;
    try {
      const old = await readJson(location.session, 8192);
      if (old.app === 'ai-carry-media-review' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(old.url)) port = Number(new URL(old.url).port);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    try { app = await createReviewServer({ rootDir: root, port }); }
    catch (cause) { if (cause.code !== 'EADDRINUSE' || !port) throw cause; app = await createReviewServer({ rootDir: root }); }
    const health = app.identity;
    await atomicJson(location.session, { app: health.app, url: app.url, rootId: health.rootId, runtimeId: health.runtimeId, uiRevision: health.uiRevision, protocol: health.protocol, dataId: health.dataId, runtimeRoot: root });
    lock.update({ url: app.url, runtimeId: health.runtimeId, state: 'ready' });
    app.server.once('close', () => { void lock.close(); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(signal === 'SIGINT' ? 'signal-interrupt' : 'signal-terminate'); });
    console.log(`Media Review入口：${app.url}`);
  }
} catch (cause) {
  await app?.close(); await lock?.close();
  console.error(`Media Review无法启动：${cause.message}`); process.exitCode = 1;
}
