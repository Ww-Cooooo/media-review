import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { UI_REVISION, SERVICE_PROTOCOL, runtimePaths, ordinaryDirectory, readJson, pathIdentity, ReviewError } from './runtime.mjs';
import { startupLock } from './service-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localUrl = value => typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value);

export async function liveReview(root) {
  const location = await runtimePaths(root); let entry;
  try { entry = await readJson(location.session, 8192); }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw new ReviewError('服务登记不可读，原文件保留；请检查本机session.json', 'session_unreadable'); }
  if (entry.app !== 'ai-carry-media-review' || !localUrl(entry.url)) return null;
  let health;
  try {
    const response = await fetch(`${entry.url}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null; health = await response.json();
  } catch { return null; }
  if (!health.ok || health.app !== entry.app || health.rootId !== entry.rootId || health.runtimeId !== entry.runtimeId) return null;
  if (health.protocol !== SERVICE_PROTOCOL || health.uiRevision !== UI_REVISION || entry.protocol !== SERVICE_PROTOCOL || health.dataId !== pathIdentity(location.local) || entry.dataId !== health.dataId) throw new ReviewError('同一数据目录的另一版本仍在运行。请先保存并明确退出旧版，再从当前入口重开；没有另起服务或结束未知进程。', 'incompatible_runtime');
  if (typeof entry.runtimeRoot !== 'string' || pathIdentity(entry.runtimeRoot) !== entry.rootId || await fs.realpath(entry.runtimeRoot).catch(() => null) !== entry.runtimeRoot) throw new ReviewError('活动运行副本的实际位置已变化，请先处理该副本；未删除rootId校验或共写资料', 'runtime_moved');
  return entry;
}

export async function connectReview({ rootDir = ROOT, start = true } = {}) {
  const root = await fs.realpath(rootDir), location = await runtimePaths(root);
  await ordinaryDirectory(location.local); await fs.access(path.join(root, 'dist/index.html'));
  let entry = await liveReview(root), reused = !!entry;
  if (!entry && start) {
    const held = await startupLock(location.local, () => liveReview(root));
    try {
      entry = held.live;
      if (!entry) {
        const child = spawn(process.execPath, [path.join(root, 'server/launch.mjs')], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
        let startupError = false; child.once('error', () => { startupError = true; }); child.unref();
        const deadline = performance.now() + 15_000;
        while (performance.now() < deadline && !entry) {
          if (startupError) throw new Error('本机服务未能启动，请检查Node环境');
          await new Promise(resolve => setTimeout(resolve, 150)); entry = await liveReview(root);
        }
        if (!entry) throw new ReviewError('本机服务未就绪或门闩被占用；请从入口重试。没有为此启动另一套写入服务。', 'startup_failed');
      } else reused = true;
    } finally { await held.lock?.close(); }
  }
  if (!entry) throw new ReviewError('校对室尚未运行，请从桌面或open入口重开', 'service_offline', 503);
  const response = await fetch(`${entry.url}/api/session/bootstrap`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const bootstrap = await response.json();
  if (!response.ok || bootstrap.runtimeId !== entry.runtimeId || bootstrap.rootId !== entry.rootId || bootstrap.dataId !== entry.dataId || bootstrap.protocol !== SERVICE_PROTOCOL || !/^[a-f0-9]{64}$/u.test(bootstrap.token)) throw new ReviewError('当前服务身份未确认，未发送素材或意见', 'invalid_runtime');
  const post = async (route, body) => {
    const result = await fetch(`${entry.url}${route}`, { method: 'POST', redirect: 'error', headers: { Origin: entry.url, 'Content-Type': 'application/json', 'X-Review-Token': bootstrap.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const value = await result.json();
    if (!result.ok) throw new ReviewError(value.message || '本机操作未完成', value.error, result.status);
    return value;
  };
  return { entry, reused, post };
}

export async function openReview({ rootDir = ROOT, media = null, taskId = null, browser = true, forceBrowser = false, requestId, title, label, previousTaskId = null, sampleTimesMs = [], inspect = false } = {}) {
  if (media && taskId) throw new ReviewError('带入新媒体与打开已有任务不能同时指定；原任务未改动', 'invalid_task', 400);
  const { entry, reused, post } = await connectReview({ rootDir });
  const task = media ? (await post('/api/tasks/register', { source: path.resolve(media), requestId, title, label, previousTaskId })).task : taskId ? (await post('/api/tasks/get', { taskId })).task : null;
  let inspection = null;
  if (task && inspect) {
    try { inspection = (await post('/api/jobs/enqueue', { taskId: task.id, kind: 'inspection', sampleTimesMs })).job; }
    catch (cause) { inspection = { state: 'not-queued', message: cause.message }; }
  }
  const taskUrl = task ? `${entry.url}/?task=${task.id}` : entry.url;
  let browserAction = { open: false, reason: '调用者未要求打开浏览器' };
  if (browser) {
    browserAction = await post('/api/browser/claim', { force: forceBrowser });
    if (browserAction.open) {
      const executable = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(executable, [taskUrl], { stdio: 'ignore', windowsHide: true });
      const requested = await new Promise(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); }); child.unref();
      browserAction = { ...browserAction, requested, ...(requested ? {} : { open: false, reason: '系统浏览器打开请求未确认；任务已保留，请用taskUrl或桌面入口打开。' }) };
    }
  }
  return { pass: true, contract: 'media-review-agent/v2', url: entry.url, taskUrl, reused, currentVersion: UI_REVISION, browser: browserAction, ...(task ? { task, media: { id: task.id, name: task.media.name, fingerprint: task.media.fingerprint } } : {}), ...(inspection ? { inspection } : {}) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) || process.argv[1]?.endsWith('open-preview.mjs')) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--media');
    if (index >= 0 && !args[index + 1]) throw new Error('--media需要明确媒体路径');
    const result = await openReview({ media: index < 0 ? null : args[index + 1], browser: !args.includes('--check') && !args.includes('--no-browser'), forceBrowser: !args.includes('--check') });
    if (args.includes('--check')) console.log(JSON.stringify(result));
    else { console.log(`Media Review入口：${result.url}`); console.log('无需保持终端；进程真正退出后，请从桌面或同一启动入口重开。'); }
  } catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
