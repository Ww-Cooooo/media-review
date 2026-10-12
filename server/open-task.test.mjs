import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createReviewServer } from './app.mjs';
import { openReview } from './open.mjs';
import { runAgentCLI } from '../scripts/review-agent.mjs';
import { runtimePaths, atomicJson } from './runtime.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-task-entry-'));
  const root = path.join(base, 'workspace/media-review-desk');
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>隔离任务入口验证</body></html>');
  const app = await createReviewServer({ rootDir: root });
  const location = await runtimePaths(root);
  await atomicJson(location.session, { ...app.identity, url: app.url, runtimeRoot: await fs.realpath(root) });
  t.after(async () => { await app.close(); await fs.rm(base, { recursive: true, force: true }); });
  const source = path.join(base, 'isolated.mp4'); await fs.writeFile(source, Buffer.alloc(2048, 3));
  return { app, root, source };
}

test('多个对话的专属入口保持任务身份；重开旧任务不登记新任务、不排分析、不改变前页租约', async t => {
  const { app, root, source } = await fixture(t);
  const a = await openReview({ rootDir: root, media: source, requestId: randomUUID(), label: '隔离对话A', browser: false });
  const client = randomUUID(), lease = app.state.clients.claim(`task:${a.task.id}`, client);
  const b = await openReview({ rootDir: root, media: source, requestId: randomUUID(), label: '隔离对话B', browser: false });
  assert.notEqual(a.task.id, b.task.id);
  assert.equal(new URL(a.taskUrl).searchParams.get('task'), a.task.id);
  assert.equal(new URL(b.taskUrl).searchParams.get('task'), b.task.id);
  const reopened = await openReview({ rootDir: root, taskId: a.task.id, browser: false });
  assert.equal(reopened.task.id, a.task.id); assert.equal(reopened.taskUrl, a.taskUrl);
  assert.equal(reopened.reused, true); assert.equal(app.state.tasks.headers.size, 2);
  assert.equal(app.state.queue.jobs.size, 0);
  app.state.clients.assert(`task:${a.task.id}`, { clientId: client, leaseId: lease.leaseId });
  await assert.rejects(openReview({ rootDir: root, taskId: randomUUID(), browser: false }));
  await assert.rejects(openReview({ rootDir: root, taskId: a.task.id, media: source, browser: false }), /不能同时指定/u);
  assert.equal(app.state.tasks.headers.size, 2);
});

test('CLI open --task打开已有任务并返回其定位网址，不落回全局最新任务', async t => {
  const { app, root, source } = await fixture(t);
  const a = await app.state.tasks.registerSource(source, { label: '隔离CLI任务A' });
  await app.state.tasks.registerSource(source, { label: '隔离CLI任务B' });
  const log = console.log, output = [];
  try { console.log = value => output.push(JSON.parse(value)); await runAgentCLI(['open', '--task', a.id, '--no-browser'], root); }
  finally { console.log = log; }
  assert.equal(output.length, 1); assert.equal(output[0].task.id, a.id);
  assert.equal(new URL(output[0].taskUrl).searchParams.get('task'), a.id);
  assert.equal(app.state.tasks.headers.size, 2); assert.equal(app.state.queue.jobs.size, 0);
});
