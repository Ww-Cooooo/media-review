import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { runtimePaths, readJson, atomicJson, ReviewError } from './runtime.mjs';
import { inspectServiceLock } from './service-lock.mjs';
import { connectReview, openReview } from './open.mjs';

export async function prepareRestart(root, runtimeId) {
  const script = path.join(root, 'server/restart-worker.mjs');
  const stat = await fs.lstat(script);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ReviewError('本机重启接续入口不可用；原服务保持运行。', 'restart_unavailable', 503);
  const child = fork(script, ['--worker', runtimeId], { cwd: root, detached: true, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const abort = () => { if (child.connected) child.disconnect(); child.unref(); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('本机重启入口未准备就绪，原服务保持运行。')), 8000);
      const finish = cause => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('error', error); child.removeListener('exit', exit); cause ? reject(cause) : resolve(); };
      const message = value => { if (value?.ready === true && value.runtimeId === runtimeId) finish(); };
      const error = () => finish(new Error('本机重启入口被阻止或未能启动，原服务保持运行。'));
      const exit = () => finish(new Error('本机重启入口提前退出，原服务保持运行。'));
      child.on('message', message); child.once('error', error); child.once('exit', exit);
    });
    child.on('error', () => {});
    return { abort, commit: () => { if (child.connected) child.send({ action: 'start' }, () => { if (child.connected) child.disconnect(); }); child.unref(); } };
  } catch (cause) { abort(); throw new ReviewError(cause.message, 'restart_unavailable', 503); }
}

async function worker(runtimeId) {
  if (!/^[a-f0-9]{32}$/u.test(runtimeId) || !process.send) throw new Error('重启接续只能由当前Media Review服务准备。');
  const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const location = await runtimePaths(root), before = await readJson(location.session, 8192);
  if (before.runtimeId !== runtimeId) throw new Error('原运行身份已变化，未重启其他服务。');
  let writeDiagnostic = true;
  const diagnostic = path.join(location.local, 'restart.json');
  try { writeDiagnostic = (await readJson(diagnostic, 4096)).format === 'media-review-restart/v1'; } catch (cause) { if (cause.code !== 'ENOENT') writeDiagnostic = false; }
  const base = { format: 'media-review-restart/v1', previousRuntimeId: runtimeId, requestedAt: new Date().toISOString() };
  const record = async value => { if (writeDiagnostic) await atomicJson(diagnostic, { ...base, ...value }).catch(() => {}); };
  const proceed = await new Promise(resolve => {
    const finish = value => { clearTimeout(timer); process.removeListener('message', message); process.removeListener('disconnect', disconnected); resolve(value); };
    const message = value => { if (value?.action === 'start') finish(true); };
    const disconnected = () => finish(false);
    const timer = setTimeout(() => finish(false), 60_000);
    process.on('message', message); process.once('disconnect', disconnected);
    process.send({ ready: true, runtimeId });
  });
  if (process.connected) process.disconnect();
  if (!proceed) return;
  await record({ state: 'waiting-for-exit' });
  try {
    const deadline = performance.now() + 30_000;
    while (await inspectServiceLock(location.local, 'runtime')) {
      if (performance.now() > deadline) throw new Error('原服务门闩未释放，未另起或结束未知进程。');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const { entry } = await connectReview({ rootDir: root });
    if (entry.runtimeId === runtimeId) throw new Error('尚未确认新运行身份。');
    let browserRequested = false;
    if (entry.url !== before.url) browserRequested = (await openReview({ rootDir: root, browser: true })).browser.requested === true;
    await record({ state: 'reconnected', runtimeId: entry.runtimeId, url: entry.url, addressChanged: entry.url !== before.url, browserRequested });
  } catch { await record({ state: 'failed', message: 'Media Review未能确认重启；请保留旧页，从桌面入口核对。可能存在安全软件阻止、端口变化或版本冲突。' }); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  try { await worker(process.argv[3]); }
  catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
}
