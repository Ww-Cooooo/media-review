import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mergedTools, subtitleCheck } from '../skill/scripts/setup.mjs';
import { safeArchiveEntry, ordinaryDirectory, atomicJson, readObject, removeOwned, download } from '../skill/scripts/setup-support.mjs';

test('first-use retains custom settings and distinguishes valid captions from mere tool presence', () => {
  const original = { model: 'custom.bin', custom: { keep: true } };
  const merged = mergedTools(original, { ffmpeg: 'ffmpeg.exe' });
  assert.equal(merged.model, 'custom.bin'); assert.deepEqual(merged.custom, { keep: true });
  assert.deepEqual(original, { model: 'custom.bin', custom: { keep: true } });
  assert.throws(() => mergedTools([], {}));
  const valid = '1\n00:00:00,000 --> 00:00:02,500\n这是字幕测试。\n';
  assert.equal(subtitleCheck(valid, 3000), 1);
  assert.throws(() => subtitleCheck('', 3000));
  assert.throws(() => subtitleCheck(valid.replace('02,500', '12,500'), 3000));
  assert.throws(() => subtitleCheck(valid.replace('这是字幕测试。', 'unrelated words'), 3000));
});
test('first-use rejects archive traversal, wrong cleanup boundaries and non-HTTPS downloads', async () => {
  for (const name of ['../outside', '/absolute', 'C:/escape', 'safe/../escape', 'safe\\..\\escape', 'safe:stream']) assert.equal(safeArchiveEntry(name), false);
  assert.equal(safeArchiveEntry('Release/whisper-cli.exe'), true);
  await assert.rejects(download('http://example.invalid/a', 'not-written'), /HTTPS/u);
  await assert.rejects(removeOwned(path.join(os.tmpdir(), 'wrong'), os.tmpdir(), 'owned-'), /边界/u);
});
test('first-use preserves unreadable configuration and refuses linked preparation directories', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-setup-test-'));
  try {
    const directory = await ordinaryDirectory(path.join(parent, 'data'));
    const file = path.join(directory, 'tools.json');
    await fs.writeFile(file, '{broken', 'utf8');
    await assert.rejects(readObject(file)); assert.equal(await fs.readFile(file, 'utf8'), '{broken');
    await atomicJson(path.join(directory, 'receipt.json'), { ready: true });
    assert.equal((await readObject(path.join(directory, 'receipt.json'))).ready, true);
    const link = path.join(parent, 'link');
    await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(ordinaryDirectory(link), /链接/u);
    await fs.unlink(link);
  } finally { await removeOwned(parent, os.tmpdir(), 'media-review-setup-test-'); }
});
test('bootstrap Node pin and release metadata match the maintained source version', async () => {
  const pins = JSON.parse(await fs.readFile(new URL('../skill/scripts/setup-dependencies.json', import.meta.url), 'utf8'));
  const bootstrap = await fs.readFile(new URL('../skill/scripts/first-use.cmd', import.meta.url), 'utf8');
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pins.release, pkg.version);
  const { UI_REVISION } = await import('./runtime.mjs');
  const client = await fs.readFile(new URL('../src/lib/use-service-status.ts', import.meta.url), 'utf8');
  const page = await fs.readFile(new URL('../src/review-desk.tsx', import.meta.url), 'utf8');
  assert.equal(client.match(/const UI_REVISION = '([^']+)'/u)?.[1], UI_REVISION, 'new installs must pass the browser/server version handshake');
  assert.equal(page.match(/data-ui-revision="([^"]+)"/u)?.[1], UI_REVISION);
  assert.equal(UI_REVISION, `review-${pkg.version.replaceAll('.', '-')}`);
  assert.ok(bootstrap.includes(pins.node.url)); assert.ok(bootstrap.includes(pins.node.sha256));
  assert.ok(bootstrap.includes(pins.node.fallbackUrl)); assert.ok(bootstrap.includes(pins.node.fallbackSha256));
});
