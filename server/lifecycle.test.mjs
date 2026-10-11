import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createReviewServer } from './app.mjs';
import { AnalysisQueue } from './analysis-queue.mjs';
import { ReviewClients } from './review-clients.mjs';
import { contentHash, AnalysisCache } from './analysis-cache.mjs';
import { MediaAnalysisService } from './media-analysis.mjs';
import { tryServiceLock, inspectServiceLock } from './service-lock.mjs';
import { ReviewTasks } from './review-tasks.mjs';
import { enqueueMedia } from './review-workflow.mjs';

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-lifecycle-'));
  const root = path.join(base, 'workspace/media-review-desk');
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>隔离生命周期测试</body></html>');
  const app = await createReviewServer({ rootDir: root, ...options });
  t.after(async () => { await app.close(); await fs.rm(base, { recursive: true, force: true }); });
  const token = /window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]+)"/u.exec(await (await fetch(app.url)).text())[1];
  const post = (route, body, context = null) => fetch(app.url + route, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify({ ...body, ...(context ? { context } : {}) }) });
  return { ...app, base, root, post };
}
const blank = () => ({ id: null, mode: null, kind: 'modify', topic: null, startText: '', endText: '', text: '', rect: null, frameMs: null, reference: null, snapshot: null });
const record = (media, id) => ({ format: 'ai-carry-media-review/v2', media: { name: media.name, size: media.size, type: media.type, fingerprint: media.fingerprint, durationMs: 16000 }, notes: [{ id, kind: 'modify', startMs: 1000, endMs: null, text: `【隔离测试】${id}，不是用户意见`, rect: null, reference: null }] });
const workspace = value => ({ format: 'media-review-workspace/v1', media: value.media, currentMs: 1000, notes: value.notes, baseNotes: [], dirty: true, newDraft: blank(), editDraft: blank(), parked: [], view: { kind: 'new' } });
async function claim(app, task, clientId, takeover = false) {
  const value = await (await app.post('/api/clients/claim', { taskId: task.id, fingerprint: task.media.fingerprint, clientId, takeover })).json();
  return { clientId, taskId: task.id, leaseId: value.leaseId };
}

test('同内容不同对话独立归属，幂等重试不新增任务；陈旧保存与接管都不能覆盖意见', async t => {
  const app = await fixture(t), source = path.join(app.base, 'isolated.mp4');
  await fs.writeFile(source, Buffer.alloc(4096, 3));
  const requestId = randomUUID();
  const taskA = (await (await app.post('/api/tasks/register', { source, requestId, label: '隔离对话A' })).json()).task;
  const retry = (await (await app.post('/api/tasks/register', { source, requestId, label: '隔离对话A' })).json()).task;
  assert.equal(taskA.id, retry.id);
  assert.equal((await app.post('/api/tasks/register', { source, requestId, label: '不同来源' })).status, 409);
  const taskB = (await (await app.post('/api/tasks/register', { source, label: '隔离对话B' })).json()).task;
  assert.notEqual(taskA.id, taskB.id);
  assert.equal((await (await app.post('/api/tasks/list', {})).json()).total, 2);
  const a = await claim(app, taskA, randomUUID()), bClient = randomUUID();
  const viewer = await (await app.post('/api/clients/claim', { taskId: taskA.id, fingerprint: taskA.media.fingerprint, clientId: bClient, takeover: false })).json();
  assert.equal(viewer.editing, false);
  const first = record(taskA.media, 'first-window'), stale = record(taskA.media, 'stale-window');
  assert.equal((await app.post('/api/workspace/save', workspace(first), a)).status, 200);
  const saved = await app.post('/api/reviews/save', { record: first, baseRevision: null }, a);
  assert.equal(saved.status, 200);
  const receipt = await saved.json(); assert.match(receipt.revision, /^[a-f0-9]{64}$/u);
  const b = await claim(app, taskA, bClient, true);
  assert.equal((await app.post('/api/reviews/save', { record: stale, baseRevision: null }, b)).status, 409);
  assert.equal((await app.post('/api/workspace/save', workspace(stale), a)).status, 409);
  assert.equal((await app.post('/api/workspace/save', workspace(stale), b)).status, 200);
  const loaded = await (await app.post('/api/reviews/load', { fingerprint: first.media.fingerprint }, b)).json();
  assert.deepEqual(loaded.record, first);
  const dirA = await app.state.tasks.scope(taskA.id, taskA.media.fingerprint);
  assert.equal((await fs.readdir(path.join(dirA, 'drafts'))).filter(name => name.endsWith('.workspace.json')).length, 2);
  const c = await claim(app, taskB, randomUUID());
  const independent = record(taskB.media, 'independent');
  assert.equal((await app.post('/api/reviews/save', { record: independent, baseRevision: null }, c)).status, 200);
  assert.deepEqual((await (await app.post('/api/reviews/load', { fingerprint: first.media.fingerprint }, b)).json()).record, first);
  assert.equal((await app.post('/api/reviews/save', first, b)).status, 428);
  assert.equal((await app.post('/api/reviews/save', { record: { ...first, media: { ...first.media, name: 'wrong.mp4' } }, baseRevision: loaded.revision }, b)).status, 409);
});

test('无编辑租约的遗留调用也必须CAS，两个并发同基线只有一个成功', async t => {
  const app = await fixture(t), media = { name: 'legacy.mp4', size: 4096, type: 'video/mp4', fingerprint: 'c'.repeat(64) };
  const responses = await Promise.all(['a', 'b'].map(id => app.post('/api/reviews/save', { record: record(media, id), baseRevision: null })));
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
  const loaded = await (await app.post('/api/reviews/load', { fingerprint: media.fingerprint })).json();
  assert.equal(loaded.record.notes.length, 1);
});

test('待人工任务跨过原4小时仍可接手，只有真正空台才宽限关闭；全局退出需明确确认', async t => {
  let now = 0;
  const app = await fixture(t, { clock: () => now, idleMs: 1000 });
  const source = path.join(app.base, 'waiting.mp4'); await fs.writeFile(source, Buffer.alloc(1024, 2));
  const task = (await (await app.post('/api/tasks/register', { source })).json()).task;
  now = 25 * 60 * 60 * 1000; app.checkIdle();
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
  assert.equal((await app.post('/api/session/close', {})).status, 409);
  await app.post('/api/tasks/status', { taskId: task.id, status: 'closed' });
  app.checkIdle(); now += 1001; app.checkIdle();
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(fetch(app.url + '/api/health'));
});

test('客户端租约使用单调时钟，接管不自动打开更多页面；仅自己的租约可释放', () => {
  let now = 0; const clients = new ReviewClients({ now: () => now, leaseMs: 1000 });
  const a = randomUUID(), b = randomUUID();
  assert.equal(clients.browserClaim().open, true); assert.equal(clients.browserClaim().open, false);
  clients.heartbeat({ clientId: a }); now += 6000; assert.equal(clients.browserClaim().open, false);
  const first = clients.claim('task:a', a); assert.equal(clients.claim('task:a', b).editing, false);
  clients.release(b); clients.assert('task:a', { clientId: a, leaseId: first.leaseId });
  now += 1001; assert.throws(() => clients.assert('task:a', { clientId: a, leaseId: first.leaseId }), /过期/);
});

test('全局单重任务、共享请求、取消一个归属不伤另一任务、容量与低内存回执', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-queue-')); let active = 0, maximum = 0, memory = 1024 ** 3;
  const releases = new Map();
  const until = async predicate => {
    const deadline = performance.now() + 5000;
    while (!await predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(await predicate(), '队列必须在有界等待内进入真实预期状态');
  };
  const queue = await new AnalysisQueue(base, async (job, signal) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise((resolve, reject) => { releases.set(job.id, resolve); signal.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }); }); return { observed: job.kind }; }
    finally { active--; }
  }, { maxPending: 3, freeMemory: () => memory }).init();
  t.after(async () => { await queue.close(); await fs.rm(base, { recursive: true, force: true }); });
  const a = randomUUID(), b = randomUUID();
  const first = await queue.enqueue({ kind: 'inspection', key: 'same', owner: a });
  const shared = await queue.enqueue({ kind: 'inspection', key: 'same', owner: b }); assert.equal(first.id, shared.id);
  await until(() => releases.has(first.id));
  const second = await queue.enqueue({ kind: 'media', key: 'second', owner: a });
  const third = await queue.enqueue({ kind: 'inspection', key: 'third', owner: a });
  await assert.rejects(queue.enqueue({ kind: 'media', key: 'full' }), /已满/);
  await until(() => active === 1); assert.equal(active, 1);
  assert.equal((await queue.cancel(first.id, a)).detached, true); assert.equal(active, 1);
  releases.get(first.id)(); assert.equal((await queue.wait(first.id)).observed, 'inspection');
  await until(() => active === 1); assert.equal(active, 1);
  await queue.cancel(second.id, a); memory = 0;
  await until(async () => (await queue.read(third.id)).state === 'waiting-resources');
  assert.equal((await queue.read(third.id)).state, 'waiting-resources'); assert.equal(maximum, 1);
  await queue.pumpDone; memory = 1024 ** 3; const pumping = queue.pump();
  await until(() => releases.has(third.id)); releases.get(third.id)(); await pumping;
});

test('共享归属登记与开始运行交错时，落盘同时保留最新状态和所有归属', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-queue-write-'));
  const a = randomUUID(), b = randomUUID();
  let release, entered, started;
  const writing = new Promise(resolve => { entered = resolve; });
  const executing = new Promise(resolve => { started = resolve; });
  const queue = await new AnalysisQueue(base, async () => {
    started(); await new Promise(resolve => { release = resolve; }); return { synthetic: true };
  }, { freeMemory: () => 1024 ** 3 }).init();
  queue.schedule = () => {};
  t.after(async () => { release?.(); await queue.close(); await fs.rm(base, { recursive: true, force: true }); });
  const first = await queue.enqueue({ kind: 'inspection', key: 'shared-write', owner: a });
  const persist = queue.persist.bind(queue);
  queue.persist = async job => { if (job.owners.includes(b)) entered(); return persist(job); };
  const joining = queue.enqueue({ kind: 'inspection', key: 'shared-write', owner: b });
  await writing;
  const pumping = queue.pump();
  await joining; await executing;
  const disk = JSON.parse(await fs.readFile(path.join(base, 'jobs', `${first.id}.json`), 'utf8'));
  assert.equal(disk.state, 'running'); assert.deepEqual(disk.owners, [a, b]); assert.deepEqual(disk.requesters, [a, b]);
  release(); await pumping;
});

test('上传闲置自身过期、并发分片有序收尾，不依赖关闭全局服务', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-upload-')), root = path.join(base, 'workspace/media-review-desk'); let now = 0;
  const service = new MediaAnalysisService(root, { now: () => now, uploadIdleMs: 1000, maxUploads: 2 });
  t.after(async () => { await service.close(); await fs.rm(base, { recursive: true, force: true }); });
  const id = await service.start(3, 1000), newer = await service.start(3, 1000);
  await assert.rejects(service.start(3, 1000), /槽已满/);
  now = 1100; await service.expireUploads(); assert.equal(service.jobs.size, 0);
  assert.equal(await service.cancel(id), false); assert.equal(await service.cancel(newer), false);
  const next = await service.start(3, 1000);
  const duplicates = await Promise.allSettled([service.append(next, 0, 'YWJj'), service.append(next, 0, 'YWJj')]);
  assert.equal(duplicates.filter(value => value.status === 'fulfilled').length, 1);
  await service.cancel(next);
});

test('完整摘要区分同大小同首尾的不同中部，缓存按内容／配置分开且只清可重建缓存', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-cache-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = path.join(base, 'a.mp4'), b = path.join(base, 'b.mp4'), bytes = Buffer.alloc(800_000, 1);
  await fs.writeFile(a, bytes); bytes[400_000] = 2; await fs.writeFile(b, bytes);
  const hashA = await contentHash(a), hashB = await contentHash(b); assert.notEqual(hashA, hashB);
  const cache = await new AnalysisCache(base, { maxFiles: 1 }).init();
  const first = cache.key('media', hashA, 'config-a'), second = cache.key('media', hashA, 'config-b'); assert.notEqual(first, second);
  await cache.put(first, { evidence: 1 }); await cache.put(second, { evidence: 2 });
  assert.equal(await cache.get(first), null); assert.deepEqual(await cache.get(second), { evidence: 2 });
  assert.deepEqual(await fs.readFile(a), Buffer.alloc(800_000, 1));
});

test('旧inbox只将current登记为等待，其他保留待选择；旧字节不变且重启不重开已结束任务', async t => {
  const app = await fixture(t), source = path.join(app.base, 'legacy-source.mp4');
  await fs.writeFile(source, Buffer.alloc(4096, 4));
  const a = await enqueueMedia(app.root, source), b = await enqueueMedia(app.root, source);
  const inbox = path.join(app.state.local, 'inbox');
  const before = await Promise.all(['current.json', `${a.id}.json`, `${b.id}.json`].map(name => fs.readFile(path.join(inbox, name))));
  await app.state.tasks.importLegacyInbox();
  assert.equal((await app.state.tasks.read(a.id)).status, 'legacy');
  assert.equal((await app.state.tasks.read(b.id)).status, 'waiting');
  assert.equal(app.state.tasks.activeCount, 1);
  await app.state.tasks.changeStatus(b.id, 'closed');
  const restored = await new ReviewTasks(app.state.local, app.state.tasks.legacyReviews).init();
  await restored.importLegacyInbox(); assert.equal(restored.activeCount, 0);
  for (const [index, name] of ['current.json', `${a.id}.json`, `${b.id}.json`].entries()) assert.deepEqual(await fs.readFile(path.join(inbox, name)), before[index]);
});

test('源文件带入绑定完整内容，移动后明确报缺失；旧意见和服务仍保留', async t => {
  const app = await fixture(t), source = path.join(app.base, 'bound.mp4');
  await fs.writeFile(source, Buffer.alloc(800_000, 5));
  const task = (await (await app.post('/api/tasks/register', { source })).json()).task, context = await claim(app, task, randomUUID());
  const response = await app.post('/api/workflow/media', { id: task.id }, context);
  assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, task.media.size);
  const hash = await contentHash(source); assert.equal((await app.state.tasks.read(task.id)).contentHash, hash);
  await assert.rejects(app.state.tasks.bindContent(task.id, '0'.repeat(64)), /完整内容/);
  await fs.rename(source, `${source}.moved`);
  const missing = await app.post('/api/workflow/media', { id: task.id }, context);
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error, 'media_missing');
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
});

test('第9个窗口的恢复副本可继续写入，旧副本归档并可按原窗口读回', async t => {
  const app = await fixture(t), source = path.join(app.base, 'archive.mp4'); await fs.writeFile(source, Buffer.alloc(4096, 6));
  const task = (await (await app.post('/api/tasks/register', { source })).json()).task;
  let firstContext, firstBytes;
  const directory = await app.state.tasks.scope(task.id, task.media.fingerprint);
  for (let index = 0; index < 9; index++) {
    const context = await claim(app, task, randomUUID(), index > 0);
    const value = workspace(record(task.media, `window-${index}`));
    assert.equal((await app.post('/api/workspace/save', value, context)).status, 200);
    if (index === 0) { firstContext = context; firstBytes = await fs.readFile(path.join(directory, 'drafts', `${task.media.fingerprint}.${context.clientId}.workspace.json`)); }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal((await fs.readdir(path.join(directory, 'drafts'))).filter(name => name.endsWith('.workspace.json')).length, 8);
  const archive = path.join(directory, 'drafts/archive'), archived = await fs.readdir(archive); assert.equal(archived.length, 1);
  assert.deepEqual(await fs.readFile(path.join(archive, archived[0])), firstBytes);
  const restored = await (await app.post('/api/workspace/load', { fingerprint: task.media.fingerprint }, firstContext)).json();
  assert.equal(restored.workspace.notes[0].id, 'window-0');
});

test('结束任务前核对其他使用窗口，不默认中断未保存的编辑', async t => {
  const app = await fixture(t), source = path.join(app.base, 'shared-window.mp4'); await fs.writeFile(source, Buffer.alloc(4096, 7));
  const task = (await (await app.post('/api/tasks/register', { source })).json()).task;
  await app.post('/api/clients/heartbeat', { clientId: randomUUID(), taskId: task.id, dirty: true });
  const blocked = await app.post('/api/tasks/status', { taskId: task.id, status: 'closed' });
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, 'task_in_use');
  assert.equal((await app.state.tasks.read(task.id)).status, 'waiting');
  assert.equal((await app.post('/api/tasks/status', { taskId: task.id, status: 'closed', confirmOtherWindows: true })).status, 200);
});

test('分析缓存有上界且不回收inspection证据；落盘失败不逃逸pump或阻止取消收尾', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-bounded-results-'));
  const queue = await new AnalysisQueue(base, async job => ({ actual: job.key }), { maxResultFiles: 1 }).init();
  t.after(async () => { await queue.close(); await fs.rm(base, { recursive: true, force: true }); });
  const first = await queue.enqueue({ kind: 'media', key: 'first' }); await queue.wait(first.id);
  const evidence = await queue.enqueue({ kind: 'inspection', key: 'evidence' }); await queue.wait(evidence.id);
  const second = await queue.enqueue({ kind: 'media', key: 'second' }); await queue.wait(second.id); await queue.pruneResults();
  assert.equal((await queue.read(first.id)).state, 'expired');
  assert.equal((await queue.read(evidence.id, true)).result.actual, 'evidence');
  const third = await queue.enqueue({ kind: 'media', key: 'disk-error' });
  queue.freeMemory = () => 0; queue.persist = async () => { throw new Error('隔离模拟磁盘失败'); };
  await queue.pump(); assert.equal((await queue.read(third.id)).state, 'failed');
  await queue.close(); assert.equal(queue.activeCount, 0); assert.ok(queue.warnings.length);
});

test('上传归属登记到同一分析队列，从任务取消能传到处理器并清掉自身暂存', async t => {
  const app = await fixture(t), source = path.join(app.base, 'cancel-upload.mp4'); await fs.writeFile(source, Buffer.from('abc'));
  const task = (await (await app.post('/api/tasks/register', { source })).json()).task, context = await claim(app, task, randomUUID());
  let processing = false, aborted = false;
  app.state.uploads.processMedia = async job => {
    processing = true;
    await new Promise((resolve, reject) => {
      const abort = () => { aborted = true; reject(new DOMException('隔离取消', 'AbortError')); };
      job.controller.signal.addEventListener('abort', abort, { once: true }); if (job.controller.signal.aborted) abort();
    });
  };
  const { id } = await (await app.post('/api/media/start', { size: 3, durationMs: 1000 }, context)).json();
  await app.post('/api/media/append', { id, index: 0, data: 'YWJj' }, context);
  const finished = app.post('/api/media/finish', { id }, context).then(response => response.text());
  const deadline = performance.now() + 5000;
  while (!processing && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(processing, true);
  const jobId = (await app.state.tasks.read(task.id)).jobs.media; assert.ok(jobId);
  assert.equal((await app.post('/api/jobs/cancel', { taskId: task.id, id: jobId })).status, 200);
  await finished; assert.equal(aborted, true); assert.equal(app.state.uploads.jobs.size, 0);
  assert.equal((await app.state.queue.read(jobId)).state, 'cancelled');
});

test('内核门闩互斥，释放后可重新取得；不依赖PID或陈旧时间戳', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-lock-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const first = await tryServiceLock(base, 'runtime', { state: 'owned' }); assert.ok(first);
  try { assert.equal(await tryServiceLock(base, 'runtime'), null); assert.equal((await inspectServiceLock(base, 'runtime')).state, 'owned'); }
  finally { await first.close(); }
  const next = await tryServiceLock(base, 'runtime'); assert.ok(next); await next.close();
});
