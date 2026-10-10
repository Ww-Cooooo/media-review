import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReviewServer } from './app.mjs';
import { writeReference, readReference } from './review-reference.mjs';
import { validateRecord, REFERENCE_FORMAT } from './review-record.mjs';
import { emptyDraft, draftProblem, draftSignature } from '../src/lib/review-draft.ts';
import { estimateProgress } from '../src/lib/estimated-progress.ts';

const fingerprint = 'b'.repeat(64);
// 结构化JPEG头用于存储边界测试；实际图片解码由浏览器截帧测试覆盖。
const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,2,0,3,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9]);
const data = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-carry-reference-test-'));
  await fs.mkdir(path.join(root, 'dist')); await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>隔离测试</body></html>');
  const app = await createReviewServer({ rootDir: root, idleMs: 10_000, maxLifetimeMs: 60_000 });
  t.after(async () => { await app.close(); if (!path.basename(root).startsWith('ai-carry-reference-test-') || path.dirname(root) !== path.resolve(os.tmpdir())) throw Error('拒绝清理其他目录'); await fs.rm(root, { recursive: true, force: true }); });
  const html = await (await fetch(app.url)).text(); const token = /window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]{64})"/u.exec(html)?.[1]; assert.ok(token);
  const post = (route, body, extra = {}) => fetch(`${app.url}${route}`, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Review-Token': token, ...extra }, body: JSON.stringify(body) });
  return { root, post, ...app };
}
function record(reference = undefined) {
  return { format: reference === undefined ? 'ai-carry-media-review/v1' : REFERENCE_FORMAT,
    media: { name: '隔离试片.mp4', size: 100, type: 'video/mp4', durationMs: 16000, fingerprint },
    notes: [{ id: 'original-id', kind: 'modify', text: '【隔离测试】原意见', startMs: 4000, endMs: 9000, rect: { x: .2, y: .3, width: .5, height: .25 }, ...(reference === undefined ? {} : { reference }) }] };
}

test('v1只读不迁移；用户保存v2时保留原字节，独立参考帧和图片真实回读', async t => {
  const app = await fixture(t); const old = record();
  assert.equal((await app.post('/api/reviews/save', old)).status, 200);
  const file = path.join(app.root, 'reviews', `${fingerprint}.review.json`); const original = await fs.readFile(file);
  await app.post('/api/reviews/load', { fingerprint }); assert.deepEqual(await fs.readFile(file), original);
  const image = await (await app.post('/api/references/save', { fingerprint, data })).json();
  assert.deepEqual(image, { fileName: `${createHash('sha256').update(jpeg).digest('hex')}.jpg`, width: 3, height: 2 });
  const current = record({ ...image, frameMs: 8000 });
  const response = await app.post('/api/reviews/save', current); assert.equal(response.status, 200); assert.deepEqual((await response.json()).record, current);
  const backups = (await fs.readdir(path.join(app.root, 'reviews'))).filter(name => name.endsWith('.v1.backup.json'));
  assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(app.root, 'reviews', backups[0])), original);
  assert.deepEqual((await (await app.post('/api/reviews/load', { fingerprint })).json()).record, current);
  assert.equal((await (await app.post('/api/references/load', { fingerprint, fileName: image.fileName })).json()).data, data);
  const refused = await app.post('/api/reviews/save', old); assert.equal(refused.status, 400); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), current);
});

test('参考图接口不泄露到GET，拒绝来源、会话、路径、错误编码和内容漂移', async t => {
  const app = await fixture(t); const reviews = path.join(app.root, 'reviews');
  assert.equal((await fetch(`${app.url}/api/references/load`)).status, 405);
  assert.equal((await app.post('/api/references/save', { fingerprint, data }, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await app.post('/api/references/save', { fingerprint, data }, { 'X-Review-Token': 'wrong' })).status, 403);
  assert.equal((await app.post('/api/references/load', { fingerprint, fileName: '../not-allowed.jpg' })).status, 400);
  assert.equal((await app.post('/api/references/save', { fingerprint, data: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  const image = await writeReference(reviews, fingerprint, data); const duplicate = await writeReference(reviews, fingerprint, data); assert.deepEqual(image, duplicate);
  await fs.writeFile(path.join(reviews, 'references', fingerprint, image.fileName), 'broken');
  await assert.rejects(readReference(reviews, fingerprint, image.fileName));
  const response = await app.post('/api/reviews/save', record({ ...image, frameMs: 8000 })); assert.equal(response.status, 400);
  await assert.rejects(fs.access(path.join(reviews, `${fingerprint}.review.json`)));
});

test('不接受未来格式、越界参考时间、错误尺寸；旧记录不伪补参考信息', () => {
  const legacy = record(); assert.deepEqual(validateRecord(legacy), legacy); assert.equal(Object.hasOwn(legacy.notes[0], 'reference'), false);
  assert.throws(() => validateRecord({ ...legacy, format: 'ai-carry-media-review/v999' }));
  for (const reference of [{ frameMs: 16001, fileName: 'a'.repeat(64)+'.jpg', width: 3, height: 2 }, { frameMs: 8000, fileName: 'a'.repeat(64)+'.jpg', width: 5000, height: 2 }]) assert.throws(() => validateRecord(record(reference)));
});

test('草稿目标完整性与截图显示隔离；预计值有限、单调且不提前完成', () => {
  const draft = { ...emptyDraft(), text: '【隔离测试】意见' };
  assert.ok(draftProblem(draft, 16000)); draft.mode = 'range'; draft.startText = '00:04.000'; assert.ok(draftProblem(draft, 16000));
  draft.endText = '00:09.000'; assert.equal(draftProblem(draft, 16000), ''); assert.ok(draftProblem(draft, 16000, true));
  assert.equal(draftSignature(draft), draftSignature({ ...draft, snapshot: data }));
  for (const real of [0, 9, 14, 98, 100]) {
    let previous = -1;
    for (const elapsed of [0, 500, 10000, 90000, 100000000]) { const value = estimateProgress(real, elapsed); assert.ok(value >= previous && value < 100); assert.ok(value <= Math.min(99, real + 7.5)); previous = value; }
  }
});
