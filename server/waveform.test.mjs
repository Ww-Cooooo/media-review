import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { waveRms } from './media-analysis.mjs';
import { visibleRms } from '../src/lib/waveform.ts';

async function wav(t, samples, trailing = false) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'review-wave-rms-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + samples.length * 2, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length * 2, 40);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(value, i * 2));
  const file = path.join(folder, 'fixture.wav');
  await fs.writeFile(file, Buffer.concat([header, data, ...(trailing ? [Buffer.alloc(20, 127)] : [])]));
  return file;
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .0002, `${actual} != ${expected}`);

test('RMS保留强弱比例、静音为零，WAV尾部非音频字节不参与', async t => {
  const levels = [10000, 1000, 0, 5000];
  const file = await wav(t, levels.flatMap(level => Array(320).fill(level)), true);
  assert.deepEqual(await waveRms(file), [1, .1, 0, .5]);
});

test('RMS不会把仅一个瞬态的窗口画得与持续强音一样高', async t => {
  const samples = [...Array(320).fill(10000), 10000, ...Array(319).fill(0)];
  const values = await waveRms(await wav(t, samples));
  assert.equal(values[0], 1);
  close(values[1], Math.sqrt(1 / 320));
});

test('恒定音量不伪造起伏，短片与末窗没有空白尾柱', async t => {
  assert.deepEqual(await waveRms(await wav(t, Array(643).fill(2500))), [1, 1, 1]);
  assert.deepEqual(await waveRms(await wav(t, [0, 0, 0])), [0]);
  assert.deepEqual(await waveRms(await wav(t, [3000])), [1]);
});

test('跨读取块和长媒体点数上限不改变恒定声音', async t => {
  const result = await waveRms(await wav(t, Array(130001).fill(9000)), 40000);
  assert.equal(result.length, 36000);
  assert.ok(result.every(value => value === 1));
});

test('可见RMS用能量聚合，不取峰值也不重新归一化', () => {
  const result = visibleRms([1, 0, .1, .1], 4000, 0, 4000, 2);
  close(result[0], Math.sqrt(.5)); close(result[1], .1);
  const quiet = visibleRms([1, 0, .1, .1], 4000, 2000, 4000, 2);
  assert.deepEqual(quiet, [.1, .1]);
});

test('缩放和非整窗视野边界保持实际时间权重', () => {
  const result = visibleRms([1, 0, .5], 3000, 500, 1500, 1);
  close(result[0], Math.sqrt(.5));
  assert.deepEqual(visibleRms([1, 0, .5], 3000, 1000, 2000, 100), [0]);
  assert.deepEqual(visibleRms([], 3000, 0, 3000, 100), []);
  assert.deepEqual(visibleRms([1], 3000, 1000, 1000, 100), []);
});
