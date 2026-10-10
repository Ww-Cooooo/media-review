import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { progressDecoder } from './analysis-progress.mjs';
import { MediaAnalysisService } from './media-analysis.mjs';
import { analyzeMedia } from '../src/lib/api.ts';

test('真实工具进度解析跨chunk、只增不减且不转发原话', () => {
  const decodeEvents = [];
  const decode = progressDecoder('decoding', 2000, event => decodeEvents.push(event));
  decode(Buffer.from('out_time_')); decode(Buffer.from('us=500000\nout_time_us=250000\nprogress=end\n'));
  assert.deepEqual(decodeEvents.map(e => e.percent), [25, 100]);
  const events = [];
  const whisper = progressDecoder('transcribing', 0, event => events.push(event));
  whisper(Buffer.from('main: processing 32000 samples\nwhisper_print_progress_callback: pro'));
  whisper(Buffer.from('gress = 40%\n这里是识别的原话，不是进度\nprogress = 20%\nprogress = 100%\n'));
  assert.deepEqual(events.map(e => e.percent), [0, 40, 100]);
  assert.ok(events.every(e => Object.keys(e).sort().join(',') === 'kind,percent,phase'));
});

test('异步开始准备期间拒绝第二个任务，取消后清理完成再返回', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'review-progress-cancel-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const service = new MediaAnalysisService(path.join(base, 'workspace/media-review-desk'));
  const pending = service.start(3, 1000);
  await assert.rejects(service.start(3, 1000), /仍在分析/);
  const id = await pending;
  assert.equal(await service.cancel(id), true);
  assert.equal(service.job, null);
  assert.deepEqual(await fs.readdir(path.join(base, '.assistant-local/extensions/media-review-desk')), []);
  const next = await service.start(3, 1000);
  await service.cancel(next);
});

test('开始握手期间取消仍取得ID并清理，再串行启动新分析；空结果不一直加载', async t => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { __REVIEW_SESSION_TOKEN__: 'isolated-test-token' };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
  let releaseStart;
  let calls = 0;
  const operations = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/start')) {
      calls++;
      const n = calls; operations.push(`start-${n}`);
      if (n === 1) await new Promise(resolve => { releaseStart = resolve; });
      return new Response(JSON.stringify({ id: `job-${n}` }));
    }
    if (url.endsWith('/cancel')) { operations.push(`cancel-${body.id}`); return new Response(JSON.stringify({ cancelled: true })); }
    if (url.endsWith('/append')) return new Response(JSON.stringify({ written: 3 }));
    return new Response('');
  };
  const file = new File(['abc'], 'test.wav');
  const controller = new AbortController();
  const first = analyzeMedia(file, 1000, () => {}, () => {}, controller.signal);
  while (!releaseStart) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const events = [];
  const second = analyzeMedia(file, 1000, e => events.push(e), () => {}, new AbortController().signal);
  releaseStart();
  await assert.rejects(first, { name: 'AbortError' });
  await second;
  assert.deepEqual(operations, ['start-1', 'cancel-job-1', 'start-2']);
  assert.deepEqual(events.map(e => e.kind), ['wave-error', 'transcript-error']);
});
