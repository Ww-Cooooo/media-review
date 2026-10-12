import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createReviewServer } from './app.mjs';

async function fixture(t, serviceOptions = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-activity-')), root = path.join(base, 'workspace/media-review-desk');
  await fs.mkdir(path.join(root, 'dist'), { recursive: true }); await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>隔离分析来源验证</body></html>');
  const app = await createReviewServer({ rootDir: root, serviceOptions });
  t.after(async () => { await app.close(); await fs.rm(base, { recursive: true, force: true }); });
  const token = /window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]+)"/u.exec(await (await fetch(app.url)).text())[1];
  const post = (route, body, context = null) => fetch(app.url + route, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify({ ...body, context }) });
  const source = path.join(base, 'isolated-video.mp4'); await fs.writeFile(source, Buffer.alloc(4096, 3));
  const register = async label => (await (await post('/api/tasks/register', { source, label })).json()).task;
  return { ...app, base, root, source, post, register };
}
const until = async predicate => { const end = performance.now() + 5000; while (performance.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('隔离分析状态等待超时'); };

test('分析来源接口需认证，返回实际任务／校对页而不包含路径、结果或凭据', async t => {
  let now = 0; const app = await fixture(t, { clients: { now: () => now, clientMs: 100 } }); app.state.queue.schedule = () => {};
  const a = await app.register('【隔离验证】对话A'), b = await app.register('【隔离验证】对话B'), other = await app.register('【隔离验证】无关任务');
  const stale = randomUUID(); app.state.clients.heartbeat({ clientId: stale, taskId: a.id }); now = 101;
  const firstPage = randomUUID(), secondPage = randomUUID(); app.state.clients.heartbeat({ clientId: firstPage, taskId: a.id }); app.state.clients.heartbeat({ clientId: secondPage, taskId: b.id, visible: false }); app.state.clients.heartbeat({ clientId: randomUUID(), taskId: other.id });
  const job = await app.state.queue.enqueue({ kind: 'media', key: 'shared-content', owner: a.id }); await app.state.queue.enqueue({ kind: 'media', key: 'shared-content', owner: b.id });
  app.state.queue.jobs.get(job.id).state = 'running'; app.state.queue.jobs.get(job.id).progress = { phase: 'transcribing', percent: 42 };
  const forbidden = await fetch(app.url + '/api/session/activity', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(forbidden.status, 403);
  const activity = await (await app.post('/api/session/activity', {})).json(); assert.equal(activity.items.length, 1); assert.equal(activity.runtimeId, (await (await fetch(app.url + '/api/health')).json()).runtimeId);
  const item = activity.items[0]; assert.deepEqual(item.tasks.map(value => value.id), [a.id, b.id]); assert.deepEqual(item.pages.map(value => value.clientId), [firstPage, secondPage]); assert.equal(item.mediaName, path.basename(app.source)); assert.deepEqual(item.progress, { phase: 'transcribing', percent: 42 });
  assert.equal(JSON.stringify(activity).includes(app.base), false); assert.equal(/resultPath|token|source|leaseId/u.test(JSON.stringify(activity)), false);
  assert.deepEqual((await (await app.post('/api/tasks/list', {})).json()).activity, activity);
});

test('浮动状态只展示当前活动分析，完成／失败／取消不冒充仍在处理', async t => {
  const app = await fixture(t); app.state.queue.schedule = () => {};
  const task = await app.register('【隔离验证】后台自检');
  for (const state of ['completed', 'failed', 'cancelled', 'interrupted']) { const job = await app.state.queue.enqueue({ kind: 'inspection', key: state, owner: task.id }); app.state.queue.jobs.get(job.id).state = state; }
  const queued = await app.state.queue.enqueue({ kind: 'inspection', key: 'queued', owner: task.id });
  const result = await (await app.post('/api/session/activity', {})).json(); assert.equal(result.items.length, 1); assert.equal(result.items[0].id, queued.id); assert.equal(result.items[0].tasks[0].label, '【隔离验证】后台自检'); assert.deepEqual(result.items[0].pages, []); assert.equal(result.items[0].progress, null);
});

test('上传中的来源与进度来自实际归属和字节，旧入口未知来源不编造名称', async t => {
  const app = await fixture(t), task = await app.register('【隔离验证】上传来源'), clientId = randomUUID();
  app.state.clients.heartbeat({ clientId, taskId: task.id });
  const id = await app.state.uploads.start(4096, 16000, { clientId, taskId: task.id }); await app.state.uploads.append(id, 0, Buffer.alloc(2048, 3).toString('base64'));
  const unknown = await app.state.uploads.start(4096, 16000);
  const result = app.state.analysisActivity(); assert.equal(result.items.length, 2);
  assert.equal(result.items[0].state, 'uploading'); assert.equal(result.items[0].progress.percent, 50); assert.equal(result.items[0].mediaName, path.basename(app.source)); assert.equal(result.items[0].pages[0].clientId, clientId);
  assert.equal(result.items[1].id, unknown); assert.equal(result.items[1].mediaName, '来源未登记的媒体'); assert.deepEqual(result.items[1].tasks, []); assert.deepEqual(result.items[1].pages, []);
});

test('真实上传调度时去重队列与上传，转发真实工具阶段；取消只处理自己的任务', async t => {
  const app = await fixture(t), task = await app.register('【隔离验证】正在分析素材'), clientId = randomUUID();
  const claim = await (await app.post('/api/clients/claim', { clientId, taskId: task.id, fingerprint: task.media.fingerprint, takeover: false })).json();
  const context = { clientId, taskId: task.id, leaseId: claim.leaseId }; app.state.clients.heartbeat({ clientId, taskId: task.id });
  app.state.uploads.processMedia = async (job, emit) => { emit({ kind: 'progress', phase: 'transcribing', percent: 37 }); await new Promise((resolve, reject) => { const stop = () => reject(new DOMException('隔离取消', 'AbortError')); job.controller.signal.addEventListener('abort', stop, { once: true }); if (job.controller.signal.aborted) stop(); }); };
  const id = (await (await app.post('/api/media/start', { size: 4096, durationMs: 16000 }, context)).json()).id;
  assert.equal((await app.post('/api/media/append', { id, index: 0, data: Buffer.alloc(4096, 3).toString('base64') }, context)).status, 200);
  const response = await app.post('/api/media/finish', { id }, context); const drain = response.text();
  await until(() => app.state.uploads.jobs.get(id)?.progress?.phase === 'transcribing');
  const items = (await (await app.post('/api/session/activity', {})).json()).items; assert.equal(items.length, 1); assert.equal(items[0].kind, 'browser-upload'); assert.equal(items[0].state, 'running'); assert.equal(items[0].progress.percent, 37); assert.equal(items[0].tasks[0].id, task.id);
  const wrong = await app.post('/api/media/cancel', { id }, { ...context, clientId: randomUUID() }); assert.equal(wrong.status, 409); assert.equal(app.state.uploads.jobs.has(id), true);
  assert.equal((await app.post('/api/media/cancel', { id }, context)).status, 200); await drain;
  assert.equal(app.state.analysisActivity().items.length, 0);
});
