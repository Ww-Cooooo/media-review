import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewServer } from './app.mjs';
import { UI_REVISION, runtimePaths, ordinaryDirectory, readJson, atomicJson } from './runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const location = await runtimePaths(root); await ordinaryDirectory(location.local);
  let port = 0;
  try {
    const old = await readJson(location.session, 4096);
    if (old.app === 'ai-carry-media-review' && old.uiRevision === UI_REVISION && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(old.url)) port = Number(new URL(old.url).port);
  } catch { /* 首次启动没有旧端口。 */ }
  let app;
  try { app = await createReviewServer({ port }); }
  catch (cause) { if (cause.code !== 'EADDRINUSE' || !port) throw cause; app = await createReviewServer(); }
  const health = await (await fetch(`${app.url}/api/health`)).json();
  await atomicJson(location.session, { app: health.app, url: app.url, rootId: health.rootId, runtimeId: health.runtimeId, uiRevision: health.uiRevision });
  console.log(`Media Review已打开：${app.url}`);
} catch (cause) { console.error(`Media Review无法启动：${cause.message}`); process.exitCode = 1; }
