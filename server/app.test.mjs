import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReviewServer } from './app.mjs';
import { REVIEW_FORMAT } from './review-record.mjs';

const fingerprint = 'a'.repeat(64);

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), `ai-carry-review-test-${randomBytes(4).toString('hex')}-`);
  const root = await fs.mkdtemp(prefix);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist', 'index.html'),
    '<!doctype html><html><head></head><body><main>审片</main></body></html>', 'utf8');
  const app = await createReviewServer({ rootDir: root, idleMs: 10_000, maxLifetimeMs: 60_000 });
  t.after(async () => {
    await app.close();
    const resolved = path.resolve(root);
    if (!path.basename(resolved).startsWith('ai-carry-review-test-') ||
        path.dirname(resolved) !== path.resolve(os.tmpdir())) {
      throw new Error('拒绝清理非本次隔离测试目录');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const token = /window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]{64})"/u.exec(html)?.[1];
  assert.ok(token);
  return { ...app, root, token };
}

async function post(app, route, body, options = {}) {
  return fetch(`${app.url}${route}`, {
    method: 'POST',
    headers: {
      Origin: app.url,
      'Content-Type': 'application/json',
      'X-Review-Token': app.token,
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

function sampleRecord() {
  return {
    format: REVIEW_FORMAT,
    media: {
      name: '试片.mp4',
      size: 1234,
      type: 'video/mp4',
      durationMs: 18_500,
      fingerprint,
    },
    notes: [
      {
        id: 'note_1',
        kind: 'modify',
        topic: 'subtitle',
        startMs: 1210,
        endMs: 2440,
        text: '这里的字幕太小',
        rect: { x: 0.2, y: 0.7, width: 0.4, height: 0.1 },
      },
      {
        id: 'note_2',
        kind: 'keep',
        startMs: 4500,
        endMs: null,
        text: '这个转场保留',
        rect: null,
      },
    ],
  };
}

test('保存、回读与损坏旧记录保护', async (t) => {
  const app = await fixture(t);
  const record = sampleRecord();
  const saved = await post(app, '/api/reviews/save', record);
  assert.equal(saved.status, 200);
  const receipt = await saved.json();
  const recordPath = path.join(app.root, 'reviews', `${fingerprint}.review.json`).replaceAll('\\', '/');
  assert.ok(Number.isFinite(Date.parse(receipt.savedAt)));
  assert.deepEqual(receipt, {
    saved: true,
    fileName: `${fingerprint}.review.json`,
    recordPath,
    savedAt: receipt.savedAt,
    record,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(recordPath, 'utf8')), receipt.record);
  const loaded = await post(app, '/api/reviews/load', { fingerprint });
  assert.deepEqual(await loaded.json(), { found: true, record, recordPath });

  const invalidTopic = structuredClone(record);
  invalidTopic.notes[0].topic = 'not-a-topic';
  assert.equal((await post(app, '/api/reviews/save', invalidTopic)).status, 400);

  const file = path.join(app.root, 'reviews', `${fingerprint}.review.json`);
  const original = await fs.readFile(file, 'utf8');
  const differentMedia = structuredClone(record);
  differentMedia.media.size += 1;
  const identityConflict = await post(app, '/api/reviews/save', differentMedia);
  assert.equal(identityConflict.status, 409);
  assert.equal(await fs.readFile(file, 'utf8'), original);

  await fs.writeFile(file, '{broken', 'utf8');
  const refused = await post(app, '/api/reviews/save', record);
  assert.equal(refused.status, 409);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('主机、来源、令牌、数据边界只局部拒绝', async (t) => {
  const app = await fixture(t);
  const record = sampleRecord();
  assert.equal((await post(app, '/api/reviews/save', record, {
    headers: { Origin: 'http://outside.example' },
  })).status, 403);
  assert.equal((await post(app, '/api/reviews/save', record, {
    headers: { 'X-Review-Token': 'incorrect' },
  })).status, 403);
  assert.equal((await post(app, '/api/reviews/save', record, {
    headers: { 'Content-Type': 'text/plain' },
  })).status, 415);
  const badRecord = structuredClone(record);
  badRecord.notes[0].rect.x = 0.9;
  assert.equal((await post(app, '/api/reviews/save', badRecord)).status, 400);
  const missing = await post(app, '/api/reviews/load', { fingerprint });
  assert.deepEqual(await missing.json(), { found: false, record: null, recordPath: null });
  const health = await fetch(`${app.url}/api/health`);
  assert.equal(health.status, 200);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const url = new URL(app.url);
    const req = httpRequest({
      hostname: '127.0.0.1', port: Number(url.port), path: '/api/health',
      headers: { Host: 'outside.example' },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(wrongHostStatus, 403);
  const privateDirectory = await fetch(`${app.url}/reviews/${fingerprint}.review.json`);
  assert.equal(privateDirectory.status, 404);
});
