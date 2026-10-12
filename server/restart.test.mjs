import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReviewServer } from './app.mjs';
import { connectReview } from './open.mjs';
import { UI_REVISION, pathIdentity, ReviewError } from './runtime.mjs';
import { parseLauncherArguments, launcherUri, launcherCommand, readNativeLauncher } from './native-launcher.mjs';

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-restart-'));
  const root = path.join(base, 'workspace/media-review-desk');
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>页面重启隔离测试</body></html>');
  const app = await createReviewServer({ rootDir: root, ...options });
  t.after(async () => { await app.close(); await fs.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const bootstrap = await (await fetch(app.url + '/api/session/bootstrap')).json();
  const post = (route, body) => fetch(app.url + route, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Review-Token': bootstrap.token }, body: JSON.stringify(body) });
  const info = async () => (await (await post('/api/session/restart-info', {})).json());
  const restart = async extra => post('/api/session/restart', { confirm: true, runtimeId: app.identity.runtimeId, impactRevision: (await info()).impactRevision, ...extra });
  return { ...app, base, root, post, info, restart };
}

test('本机协议只接受安装时固定资料根的start动作，不接受命令、其他资料根或额外参数', () => {
  const root = path.join(os.tmpdir(), 'media review 隔离入口');
  const uri = launcherUri(path.join(root, 'data'));
  assert.equal(parseLauncherArguments(['--data-dir', root, uri]), root);
  assert.equal(parseLauncherArguments(['--data-dir', root, uri + '/']), root);
  if (process.platform === 'win32') assert.ok(launcherCommand(process.execPath, root, 'C:\\').includes('--data-dir "C:\\\\" "%1"'));
  for (const args of [[], ['--data-dir', 'relative', uri], ['--data-dir', root, uri + '?command=node'], ['--data-dir', root, uri + '#x'], ['--data-dir', root, uri, '--check'], ['--data-dir', root, launcherUri(path.join(root, 'other/data'))], ['--data-dir', root, 'file:///C:/Windows/notepad.exe']]) assert.throws(() => parseLauncherArguments(args));
});

test('页面启动能力核对注册命令、版本和普通文件，公开回执不含本机路径', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-protocol-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'app'), dataRoot = path.join(base, 'private'), local = path.join(dataRoot, 'data');
  await fs.mkdir(path.join(root, 'server'), { recursive: true }); await fs.mkdir(local, { recursive: true });
  const node = path.join(base, 'node.exe'); await fs.writeFile(node, '隔离占位，不执行'); await fs.writeFile(path.join(root, 'server/native-start.mjs'), '隔离占位，不执行');
  const value = { format: 'media-review-native-launcher/v1', uiRevision: UI_REVISION, runtimeRoot: root, node, dataRoot };
  const config = path.join(local, 'native-launcher.json'); await fs.writeFile(config, JSON.stringify(value));
  const options = { platform: 'win32', registryReader: async () => launcherCommand(node, root, dataRoot) };
  const result = await readNativeLauncher(local, options);
  assert.equal(result.available, true); assert.equal(result.uri, launcherUri(local)); assert.equal(result.rootId, pathIdentity(root)); assert.ok(!JSON.stringify(result).includes(base));
  assert.equal((await readNativeLauncher(local, { ...options, registryReader: async () => '其他应用的命令' })).available, false);
  await fs.writeFile(config, JSON.stringify({ ...value, uiRevision: 'other' })); assert.equal((await readNativeLauncher(local, options)).available, false);
  await fs.writeFile(config, JSON.stringify(value)); await fs.unlink(node); assert.equal((await readNativeLauncher(local, options)).available, false);
});

test('重启入口需要认证、运行身份与新鲜影响确认，不允许未确认的未保存窗口', async t => {
  let prepared = 0;
  const app = await fixture(t, { restartPreparer: async () => { prepared++; return { commit() {}, abort() {} }; } });
  assert.equal((await fetch(app.url + '/api/session/restart', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await app.restart({ runtimeId: '0'.repeat(32) })).status, 409);
  const old = await app.info(); await app.post('/api/clients/heartbeat', { clientId: randomUUID(), dirty: true });
  assert.equal((await app.post('/api/session/restart', { confirm: true, runtimeId: app.identity.runtimeId, impactRevision: old.impactRevision, keepUnsaved: true })).status, 409);
  assert.equal((await app.restart({ keepUnsaved: false })).status, 409); assert.equal(prepared, 0);
  const response = await app.restart({ keepUnsaved: true }); assert.equal(response.status, 200); assert.equal((await response.json()).restarting, true); assert.equal(prepared, 1);
});

test('重启接续准备失败时保留旧服务和任务；不因辅助启动失败退出校对室', async t => {
  const app = await fixture(t, { restartPreparer: async () => { throw new ReviewError('隔离模拟启动被阻止；原服务保持运行', 'restart_unavailable', 503); } });
  const media = { name: 'isolated.mp4', fingerprint: 'd'.repeat(64), size: 1024, type: 'video/mp4', durationMs: 16000 };
  const registered = await app.post('/api/tasks/manual', { media, requestId: randomUUID(), newTask: true }); assert.equal(registered.status, 200);
  const task = (await registered.json()).task;
  assert.equal((await app.restart({})).status, 503);
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
  assert.equal((await (await app.post('/api/tasks/get', { taskId: task.id })).json()).task.status, 'waiting');
});

test('重启不会中断已接纳的短操作，准备期间也不允许第二次重启', async t => {
  let release, entered, finishPrepare, prepareEntered;
  const reading = new Promise(resolve => { entered = resolve; });
  const preparing = new Promise(resolve => { prepareEntered = resolve; });
  const app = await fixture(t, { nativeLauncherReader: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { available: false }; }, restartPreparer: async () => { prepareEntered(); await new Promise(resolve => { finishPrepare = resolve; }); return { commit() {}, abort() {} }; } });
  const info = await app.info();
  const pending = app.post('/api/session/launcher', {}); await reading;
  const body = { confirm: true, runtimeId: app.identity.runtimeId, impactRevision: info.impactRevision };
  assert.equal((await app.post('/api/session/restart', body)).status, 409); release(); await pending;
  const first = app.post('/api/session/restart', body); await preparing;
  assert.equal((await app.post('/api/session/restart', body)).status, 503);
  finishPrepare(); assert.equal((await first).status, 200);
});

test('正在带入的媒体流尚未结束时拒绝重启，不切断末块校验或归属绑定', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { restartPreparer: async () => { throw new Error('不应进入重启'); } });
  app.state.media = async () => ({ task: true, type: 'video/mp4', size: 2 });
  app.state.mediaStream = async function* () { yield Buffer.from([1]); await gate; yield Buffer.from([2]); };
  const id = randomUUID(); app.state.tasks.headers.set(id, { id, status: 'waiting' });
  const transfer = await app.post('/api/workflow/media', { id }); assert.equal(transfer.status, 200);
  try { assert.equal((await app.restart({})).status, 409); }
  finally { release(); await transfer.arrayBuffer(); }
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
});

test('实际独立进程重启后复用原端口，任务仍在，新会话拒绝旧认证', { timeout: 60_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-real-restart-'));
  const root = path.join(base, 'app'), dataRoot = path.join(base, 'private');
  const previous = process.env.MEDIA_REVIEW_DATA_DIR; process.env.MEDIA_REVIEW_DATA_DIR = dataRoot;
  let connection;
  t.after(async () => {
    try { connection = await connectReview({ rootDir: root, start: false }); await connection.post('/api/session/close', { confirm: true, runtimeId: connection.entry.runtimeId, discardUnsaved: true }); } catch { /* 只收尾本测试的已知资料根。 */ }
    if (previous === undefined) delete process.env.MEDIA_REVIEW_DATA_DIR; else process.env.MEDIA_REVIEW_DATA_DIR = previous;
    await fs.rm(base, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });
  await fs.mkdir(path.join(root, 'server'), { recursive: true });
  const source = path.dirname(fileURLToPath(import.meta.url));
  for (const file of await fs.readdir(source)) if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) await fs.copyFile(path.join(source, file), path.join(root, 'server', file));
  await fs.mkdir(path.join(root, 'dist')); await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>真实进程隔离重启</body></html>');
  await fs.writeFile(path.join(root, 'standalone.json'), JSON.stringify({ format: 'media-review-standalone/v1' }));
  connection = await connectReview({ rootDir: root }); const before = connection.entry;
  const oldBootstrap = await (await fetch(before.url + '/api/session/bootstrap')).json();
  const media = { name: 'isolated.mp4', fingerprint: 'e'.repeat(64), size: 1024, type: 'video/mp4', durationMs: 16000 };
  const { task } = await connection.post('/api/tasks/manual', { media, requestId: randomUUID(), newTask: true });
  const info = await connection.post('/api/session/restart-info', {});
  assert.equal((await connection.post('/api/session/restart', { confirm: true, runtimeId: before.runtimeId, impactRevision: info.impactRevision })).restarting, true);
  const deadline = performance.now() + 25_000;
  let health;
  while (performance.now() < deadline) {
    try { health = await (await fetch(before.url + '/api/health', { signal: AbortSignal.timeout(500) })).json(); if (health.runtimeId && health.runtimeId !== before.runtimeId) break; } catch { /* 预期的真实断线间隙。 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(health.runtimeId !== before.runtimeId && health.dataId === before.dataId);
  connection = null;
  while (performance.now() < deadline && !connection) {
    try { connection = await connectReview({ rootDir: root, start: false }); }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(connection, '新服务健康后还须等待启动器登记完成，不能用旧session当新运行身份');
  assert.equal(connection.entry.url, before.url);
  assert.equal((await connection.post('/api/tasks/get', { taskId: task.id })).task.status, 'waiting');
  const stale = await fetch(before.url + '/api/session/summary', { method: 'POST', headers: { Origin: before.url, 'Content-Type': 'application/json', 'X-Review-Token': oldBootstrap.token }, body: '{}' }); assert.equal(stale.status, 403);
});
