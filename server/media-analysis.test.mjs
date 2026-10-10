import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MediaAnalysisService } from './media-analysis.mjs';

test('本机媒体分片按顺序接收，取消后不留下原媒体', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `review-media-test-${randomBytes(4).toString('hex')}-`));
  const root = path.join(base, 'workspace', 'media-review-desk');
  await fs.mkdir(root, { recursive: true });
  t.after(async () => {
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^review-media-test-[a-f0-9]{8}-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const service = new MediaAnalysisService(root);
  const id = await service.start(6, 1000);
  assert.rejects(service.append(id, 1, Buffer.from('abc').toString('base64')), /顺序/);
  assert.equal(await service.append(id, 0, Buffer.from('abc').toString('base64')), 3);
  assert.equal(await service.append(id, 1, Buffer.from('def').toString('base64')), 6);
  assert.equal(await service.cancel(id), true);
  assert.equal(await service.cancel(id), false);
  const temporary = path.join(base, '.assistant-local', 'extensions', 'media-review-desk');
  assert.deepEqual(await fs.readdir(temporary), []);
  const component = path.join(base, '.assistant-local', 'components', 'component.high-value-video-runtime');
  await fs.mkdir(component, { recursive: true });
  await fs.writeFile(path.join(component, 'runtime-paths.json'), JSON.stringify({ ffmpeg: path.join(base, 'missing-ffmpeg.exe') }));
  const reboundId = await service.start(3, 1000);
  await service.append(reboundId, 0, Buffer.from('abc').toString('base64'));
  const reboundEvents = [];
  await service.finish(reboundId, (event) => reboundEvents.push(event));
  assert.deepEqual(reboundEvents.map((event) => event.kind), ['wave-error', 'transcript-error']);
  assert.match(reboundEvents[0].message, /绑定已失效/);
  assert.deepEqual(await fs.readdir(temporary), []);
});

test('缺少离线工具时只报告当前分析不可用，并清理临时媒体', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `review-media-test-${randomBytes(4).toString('hex')}-`));
  const root = path.join(base, 'workspace', 'media-review-desk');
  await fs.mkdir(root, { recursive: true });
  t.after(async () => {
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^review-media-test-[a-f0-9]{8}-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const service = new MediaAnalysisService(root);
  const id = await service.start(3, 1000);
  await service.append(id, 0, Buffer.from('abc').toString('base64'));
  const events = [];
  await service.finish(id, (event) => events.push(event.kind));
  assert.deepEqual(events, ['wave-error', 'transcript-error']);
  const temporary = path.join(base, '.assistant-local', 'extensions', 'media-review-desk');
  assert.deepEqual(await fs.readdir(temporary), []);
});
