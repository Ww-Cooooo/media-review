import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { UI_REVISION, runtimePaths, ordinaryDirectory, readJson } from './runtime.mjs';
import { enqueueMedia } from './review-workflow.mjs';

export async function openReview({ rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), media = null, browser = true } = {}) {
  const root = await fs.realpath(rootDir);
  const rootId = createHash('sha256').update(root.replaceAll('\\', '/').toLowerCase()).digest('hex');
  const location = await runtimePaths(root); await ordinaryDirectory(location.local);
  await fs.access(path.join(root, 'dist/index.html'));
  const input = media ? await enqueueMedia(root, media) : null;
  const live = async () => {
    try {
      const entry = await readJson(location.session, 4096);
      if (entry.app !== 'ai-carry-media-review' || entry.rootId !== rootId || entry.uiRevision !== UI_REVISION || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(entry.url)) return null;
      const health = await (await fetch(`${entry.url}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(1500) })).json();
      return health.ok && health.rootId === rootId && health.runtimeId === entry.runtimeId && health.uiRevision === UI_REVISION ? entry : null;
    } catch { return null; }
  };
  let entry = await live(); const reused = !!entry;
  if (!entry) {
    const child = spawn(process.execPath, [path.join(root, 'server/launch.mjs')], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
    let startupError = false; child.once('error', () => { startupError = true; }); child.unref();
    for (let count = 0; count < 60; count++) {
      if (startupError) throw new Error('本机服务未能启动，请检查Node环境');
      await new Promise(resolve => setTimeout(resolve, 200)); entry = await live(); if (entry) break;
    }
    if (!entry) throw new Error('本机服务尚未就绪，请从桌面入口重开；草稿不会因此冒充已保存');
  }
  if (browser) {
    const executable = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(executable, [entry.url], { stdio: 'ignore', windowsHide: true }); child.once('error', () => {}); child.unref();
  }
  return { pass: true, url: entry.url, reused, currentVersion: UI_REVISION, ...(input ? { media: { id: input.id, name: input.name, fingerprint: input.fingerprint } } : {}) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) || process.argv[1]?.endsWith('open-preview.mjs')) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--media');
    if (index >= 0 && !args[index + 1]) throw new Error('--media需要明确媒体路径');
    const result = await openReview({ media: index < 0 ? null : args[index + 1], browser: !args.includes('--check') && !args.includes('--no-browser') });
    if (args.includes('--check')) console.log(JSON.stringify(result));
    else { console.log(`Media Review已打开：${result.url}`); console.log('服务断开时，双击桌面的“Media Review”重开；无需保持终端。'); }
  } catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
