import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createReviewServer } from './app.mjs';
import { validateRecord, COMPLETE_FORMAT } from './review-record.mjs';
import { validateWorkspace } from './review-workflow.mjs';
import { emptyDraft, draftToNote } from '../src/lib/review-draft.ts';
import { createReviewHandoff } from '../src/lib/review-handoff.ts';

const media = { name: 'isolated.mp4', size: 100, type: 'video/mp4', durationMs: 12000, fingerprint: 'e'.repeat(64) };
const note = { id: 'issue-1', kind: 'modify', startMs: 2000, endMs: 4000, text: '字幕被遮住', regions: [{ id: 2, rect: { x: .1, y: .2, width: .4, height: .2 }, text: '第 2 处上移' }], regionSerial: 3, reference: null };
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-complete-'));
  const root = path.join(temporary, 'workspace', 'app');
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>isolated test</body></html>');
  const server = await createReviewServer({ rootDir: root, idleMs: 10000, maxLifetimeMs: 60000 });
  t.after(async () => { await server.close(); assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('media-review-complete-')); await fs.rm(temporary, { recursive: true, force: true }); });
  const token = /window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]{64})"/u.exec(await (await fetch(server.url)).text())[1];
  let context = null;
  const post = async (route, body, expected = 200) => {
    const response = await fetch(server.url + route, { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify({ ...body, ...(context ? { context } : {}) }) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  };
  async function task(previousTaskId = null) { return (await post('/api/tasks/manual', { media, requestId: randomUUID(), newTask: true, previousTaskId })).task; }
  async function claim(task) { const clientId = randomUUID(); const lease = await post('/api/clients/claim', { taskId: task.id, fingerprint: media.fingerprint, clientId, takeover: true }); context = { taskId: task.id, clientId, leaseId: lease.leaseId }; }
  return { post, task, claim, root, temporary, clear: () => { context = null; } };
}

test('v5 编号说明独立保存与恢复；v4 不冒认新字段，整条可仅写分框说明', () => {
  const record = { format: COMPLETE_FORMAT, media, notes: [note] };
  assert.deepEqual(validateRecord(record), record);
  assert.throws(() => validateRecord({ ...record, format: 'ai-carry-media-review/v4' }));
  const draft = { ...emptyDraft(), mode: 'point', startText: '00:02.000', regions: note.regions }; delete draft.rect;
  assert.equal(draftToNote(draft, media.durationMs).text, '见各编号区域说明');
  const workspace = { format: 'media-review-workspace/v4', media, currentMs: 2000, notes: [note], baseNotes: [note], dirty: true, newDraft: draft, editDraft: emptyDraft(), parked: [], view: { kind: 'new' } };
  assert.deepEqual(validateWorkspace(workspace), workspace);
});

test('版本链独立保存；固定交接、接手回执、返修、用户确认、重开与陈旧状态失效', async t => {
  const f = await fixture(t), v1 = await f.task(), v2 = await f.task(v1.id), unrelated = await f.task();
  assert.equal(v2.version.workId, v1.id); assert.equal(v2.version.number, 2);
  await f.claim(v1);
  const record = { format: COMPLETE_FORMAT, media, notes: [note] };
  const saved = await f.post('/api/reviews/save', { record, baseRevision: null });
  const round = await f.post('/api/handoff/create', { taskId: v1.id, revision: saved.revision });
  assert.equal(round.revision, saved.revision);
  const handoff = createReviewHandoff(saved, round).text;
  assert.ok(handoff.includes(v1.id) && handoff.includes(saved.revision));
  assert.ok(handoff.includes(round.recordPath));
  let bundle = await f.post('/api/progress/load', { taskId: v1.id });
  await f.post('/api/progress/acknowledge', { taskId: v1.id, baseRevision: bundle.progress.revision, recordRevision: saved.revision, agent: '隔离验证对话', clarifications: [], text: '收到 1 条修改意见' });
  bundle = await f.post('/api/progress/load', { taskId: v1.id });
  const update = { taskId: v1.id, baseRevision: bundle.progress.revision, recordRevision: saved.revision, noteId: note.id, actor: 'agent', status: 'changed', text: '字幕上移', targetTaskId: v2.id, targetMs: 3000 };
  await f.post('/api/progress/update', { ...update, targetTaskId: unrelated.id }, 400);
  await f.post('/api/progress/update', { ...update, actor: 'agent', status: 'confirmed' }, 400);
  await f.post('/api/progress/update', update);
  await f.post('/api/progress/update', update, 409);
  bundle = await f.post('/api/progress/load', { taskId: v1.id }); assert.equal(bundle.statuses[note.id].status, 'changed');
  await f.claim(v2);
  await f.post('/api/progress/update', { ...update, baseRevision: bundle.progress.revision, status: 'confirmed', actor: 'user', text: '新版复核通过' });
  bundle = await f.post('/api/progress/load', { taskId: v1.id }); assert.equal(bundle.statuses[note.id].status, 'confirmed');
  await f.post('/api/progress/update', { ...update, baseRevision: bundle.progress.revision, status: 'pending', actor: 'user', text: '仍需上移' });
  await f.claim(v1);
  await f.post('/api/reviews/save', { record: { ...record, notes: [{ ...note, text: '字幕还需再上移' }] }, baseRevision: saved.revision });
  bundle = await f.post('/api/progress/load', { taskId: v1.id });
  assert.equal(bundle.statuses[note.id].status, 'pending'); assert.equal(bundle.statuses[note.id].stale, true);
  assert.equal((await f.post('/api/handoff/read', { taskId: v1.id, revision: saved.revision })).record.notes[0].text, note.text);
  assert.equal((await f.post('/api/progress/load', { taskId: v2.id })).record, null);
  assert.equal((await f.post('/api/tasks/versions', { taskId: v2.id })).versions.length, 2);
});

test('任务归档可恢复，打开中的任务不会被批量归档，重命名和最近打开顺序真实持久', async t => {
  const f = await fixture(t), a = await f.task(), b = await f.task();
  await f.claim(a);
  let result = await f.post('/api/tasks/organize', { taskIds: [a.id, b.id], action: 'archive' });
  assert.equal(result.results[0].ok, false); assert.equal(result.results[1].ok, true);
  assert.equal((await f.post('/api/tasks/list', { filter: 'archived' })).items[0].id, b.id);
  await f.post('/api/tasks/organize', { taskIds: [b.id], action: 'restore' });
  assert.equal((await f.post('/api/tasks/list', { filter: 'archived' })).total, 0);
  await f.post('/api/tasks/organize', { taskIds: [a.id], action: 'rename', title: '准确的作品名' });
  await f.post('/api/tasks/organize', { taskIds: [a.id], action: 'opened' });
  result = await f.post('/api/tasks/list', { filter: 'all', sort: 'opened' });
  assert.equal(result.items[0].id, a.id); assert.equal(result.items[0].title, '准确的作品名');
  assert.equal((await f.post('/api/tasks/get', { taskId: b.id })).task.status, 'closed');
});

test('字幕导入跟随任务保存；异任务写入拒绝，自检明确范围并校验保留项归属', async t => {
  const f = await fixture(t), a = await f.task(), b = await f.task(a.id);
  await f.claim(a);
  const cues = [{ startMs: 1000, endMs: 2000, text: '这是一句测试台词' }];
  await f.post('/api/transcript/save', { taskId: a.id, name: '台词.srt', cues });
  assert.deepEqual((await f.post('/api/transcript/load', { taskId: a.id })).transcript.cues, cues);
  await f.post('/api/transcript/save', { taskId: b.id, name: '台词.srt', cues }, 409);
  const saved = await f.post('/api/reviews/save', { record: { format: COMPLETE_FORMAT, media, notes: [{ ...note, kind: 'keep' }] }, baseRevision: null });
  await f.post('/api/handoff/create', { taskId: a.id, revision: saved.revision });
  const bundle = await f.post('/api/progress/load', { taskId: b.id });
  await f.post('/api/progress/check', { taskId: b.id, baseRevision: bundle.progress.revision, coverage: [{ startMs: 1000, endMs: 2000, aspects: ['visual'], result: 'checked', detail: '隔离测试记录，非实际成片自检' }], keptNotes: [{ taskId: a.id, recordRevision: saved.revision, noteId: note.id, result: 'unverified', detail: '未检查动态和声音' }], findings: '', notVerified: '声音、字幕和节奏未核实' });
  const check = (await f.post('/api/progress/load', { taskId: b.id })).progress.checks[0];
  assert.equal(check.userApproved, false); assert.equal(check.keptNotes[0].result, 'unverified');
});

test('真实 HTTP v4 升级 v5 原字节保留，编号图片与离线清单不含原媒体，HTML 文本不执行', async t => {
  const f = await fixture(t), task = await f.task(); await f.claim(task);
  const old = { format: 'ai-carry-media-review/v4', media, notes: [{ ...note, regions: note.regions.map(({ text, ...region }) => region) }] };
  const first = await f.post('/api/reviews/save', { record: old, baseRevision: null });
  const before = await fs.readFile(first.recordPath);
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,2,0,3,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9]);
  const image = await f.post('/api/references/save', { fingerprint: media.fingerprint, data: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const record = { format: COMPLETE_FORMAT, media, notes: [{ ...note, text: '<script>bad()</script>', reference: { ...image, frameMs: 3000 } }] };
  const second = await f.post('/api/reviews/save', { record, baseRevision: first.revision });
  const directory = path.dirname(first.recordPath), backup = (await fs.readdir(directory)).find(file => file.endsWith('.v4.backup.json'));
  assert.deepEqual(await fs.readFile(path.join(directory, backup)), before);
  await f.post('/api/reviews/save', { record: old, baseRevision: second.revision }, 400);
  const result = await f.post('/api/reviews/export', { fingerprint: media.fingerprint });
  const svg = await fs.readFile(path.join(result.directory, 'annotated/note-1.svg'), 'utf8');
  assert.match(svg, /data:image\/jpeg;base64/); assert.match(svg, />2<\/text>/);
  const html = await fs.readFile(path.join(result.directory, '返修清单.html'), 'utf8');
  assert.match(html, /&lt;script&gt;bad/); assert.ok(!html.includes('<script>bad'));
  assert.match(html, /第 2 处上移/); assert.ok(html.includes(task.id));
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'references', media.fingerprint, image.fileName)), jpeg);
});
