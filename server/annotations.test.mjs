import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReviewServer } from './app.mjs';
import { validateRecord, REGIONS_FORMAT } from './review-record.mjs';
import { validateWorkspace } from './review-workflow.mjs';
import { exportReview } from './review-export.mjs';
import { emptyDraft, draftMarks, clearedDraftMarks, draftProblem, draftToNote } from '../src/lib/review-draft.ts';
import { regionsOf } from '../src/lib/review.ts';

const fingerprint = 'c'.repeat(64);
const media = { name: 'annotation-fixture.mp4', size: 100, type: 'video/mp4', durationMs: 16000, fingerprint };
const regions = [1, 2, 3].map(id => ({ id, rect: { x: .1 * id, y: .12 * id, width: .2, height: .15 } }));
const reference = { frameMs: 7000, fileName: 'a'.repeat(64) + '.jpg', width: 3, height: 2 };
const note = { id: 'three-regions', kind: 'modify', startMs: 2000, endMs: 10000, text: '1：字幕；2：人物；3：背景', regions, reference };

test('清空时间保留独立画面；清空全部仅移除本条标记，恢复不覆盖新写的文字', () => {
  const draft = { ...emptyDraft(), id: 'editing-existing', mode: 'range', startText: '00:02.000', endText: '00:10.000', text: note.text, topic: 'visual', regions, regionSerial: 3, frameMs: 7000, reference };
  const frameOnly = { ...draft, ...clearedDraftMarks(draft, true) };
  assert.equal(draftProblem(frameOnly, 16000), '');
  assert.deepEqual([frameOnly.mode, frameOnly.startText, frameOnly.endText], ['frame', '00:07.000', '']);
  assert.deepEqual(frameOnly.regions, regions);
  assert.deepEqual(frameOnly.reference, reference);
  const cleared = { ...draft, ...clearedDraftMarks(draft) };
  assert.deepEqual([cleared.id, cleared.text, cleared.topic, cleared.regionSerial], [draft.id, draft.text, draft.topic, 3]);
  assert.deepEqual([cleared.mode, cleared.startText, cleared.endText, cleared.frameMs, cleared.reference, cleared.snapshot, cleared.regions], [null, '', '', null, null, null, []]);
  const restored = { ...cleared, text: '清空后继续写的意见', ...draftMarks(draft) };
  assert.equal(restored.text, '清空后继续写的意见');
  assert.deepEqual(restored.regions, regions);
  assert.equal(restored.startText, draft.startText);
  for (const endText of ['', '00:10.000']) {
    const range = { ...draft, regions: [], frameMs: null, reference: null, endText };
    const result = { ...range, ...clearedDraftMarks(range, true) };
    assert.equal(result.mode, null);
    assert.equal(result.startText, '');
    assert.equal(result.text, note.text);
  }
});

test('时间段与独立参考帧、三个区域同时成立；起点未闭合不能误保存', () => {
  const { rect: _rect, ...base } = emptyDraft();
  const draft = { ...base, mode: 'range', startText: '00:02.000', endText: '', text: note.text, regions, frameMs: 7000, reference };
  assert.match(draftProblem(draft, 16000), /结束/);
  draft.endText = '00:10.000';
  assert.equal(draftProblem(draft, 16000), '');
  const saved = draftToNote(draft, 16000);
  assert.deepEqual([saved.startMs, saved.endMs, saved.reference.frameMs], [2000, 10000, 7000]);
  assert.deepEqual(saved.regions, regions);
  assert.deepEqual(validateRecord({ format: REGIONS_FORMAT, media, notes: [saved] }).notes[0], saved);
});

test('多区域保留编号和坐标，拒绝重复编号、越界、双重几何字段', () => {
  const record = { format: REGIONS_FORMAT, media, notes: [note] };
  assert.deepEqual(validateRecord(record), record);
  for (const change of [
    { regions: [regions[0], regions[0]] },
    { regions: [{ id: 1, rect: { x: .9, y: 0, width: .5, height: .1 } }] },
    { regions: [{ ...regions[0], id: 0 }] },
    { rect: regions[0].rect },
  ]) assert.throws(() => validateRecord({ ...record, notes: [{ ...note, ...change }] }));
  assert.deepEqual(regionsOf({ rect: regions[0].rect }), [{ id: 1, rect: regions[0].rect }]);
});

test('新旧恢复副本均可读；未完成起点与多个框不会因恢复丢失', () => {
  const old = { format: 'media-review-workspace/v1', media, currentMs: 3000, notes: [], baseNotes: [], dirty: false, newDraft: emptyDraft(), editDraft: emptyDraft(), parked: [], view: { kind: 'new' } };
  assert.deepEqual(validateWorkspace(old), old);
  const { rect: _rect, ...base } = emptyDraft();
  const current = { ...old, format: 'media-review-workspace/v2', notes: [note], baseNotes: [note], newDraft: { ...base, mode: 'range', startText: '00:02.000', endText: '', regions, frameMs: 7000, reference } };
  assert.deepEqual(validateWorkspace(current), current);
});

test('v2升级v3保存、重读与导出保留全部区域和原字节；旧版写入不能降级覆盖', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'media-annotations-test-'));
  const root = path.join(temporary, 'workspace/media-review-desk');
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>isolated</body></html>');
  const app = await createReviewServer({ rootDir: root, idleMs: 10000, maxLifetimeMs: 60000 });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('media-annotations-test-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const token = /window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]{64})"/u.exec(await (await fetch(app.url)).text())[1];
  const post = async (route, value) => fetch(app.url + route, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify(value) });
  const oldNote = { id: 'old', kind: 'keep', startMs: 1000, endMs: null, text: '旧版单框', rect: regions[0].rect, reference: null };
  const old = { format: 'ai-carry-media-review/v2', media, notes: [oldNote] };
  const first = await (await post('/api/reviews/save', { record: old, baseRevision: null })).json();
  const file = path.join(root, 'reviews', fingerprint + '.review.json'), bytes = await fs.readFile(file);
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,2,0,3,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9]);
  const image = await (await post('/api/references/save', { fingerprint, data: 'data:image/jpeg;base64,' + jpeg.toString('base64') })).json();
  const current = { format: REGIONS_FORMAT, media, notes: [oldNote, { ...note, reference: { ...image, frameMs: 7000 } }] };
  const response = await post('/api/reviews/save', { record: current, baseRevision: first.revision });
  assert.equal(response.status, 200); const saved = await response.json();
  assert.deepEqual(saved.record, current);
  assert.deepEqual((await (await post('/api/reviews/load', { fingerprint })).json()).record, current);
  const { rect: _rect, ...base } = emptyDraft();
  const editDraft = { ...base, id: note.id, mode: 'range', startText: '00:02.000', endText: '00:10.000', text: note.text, regions, frameMs: 7000, reference: current.notes[1].reference };
  const workspace = { format: 'media-review-workspace/v2', media, currentMs: 7000, notes: current.notes, baseNotes: current.notes, dirty: false, newDraft: emptyDraft(), editDraft, parked: [], view: { kind: 'edit', id: note.id } };
  assert.equal((await post('/api/workspace/save', workspace)).status, 200);
  assert.equal((await (await post('/api/history/list', {})).json()).items[0].hasDraft, false);
  workspace.editDraft = { ...editDraft, regions: regions.slice(0, 2) };
  assert.equal((await post('/api/workspace/save', workspace)).status, 200);
  assert.equal((await (await post('/api/history/list', {})).json()).items[0].hasDraft, true);
  assert.deepEqual((await (await post('/api/reviews/load', { fingerprint })).json()).record, current);
  const backups = (await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.v2.backup.json'));
  assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(path.dirname(file), backups[0])), bytes);
  const out = path.join(temporary, 'export'); await exportReview(root, fingerprint, out);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'review.json'), 'utf8')), current);
  const checklist = await fs.readFile(path.join(out, '返修清单.md'), 'utf8');
  for (const id of [1, 2, 3]) assert.match(checklist, new RegExp('画面区域 ' + id));
  assert.equal((await post('/api/reviews/save', { record: old, baseRevision: saved.revision })).status, 400);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), current);
});
