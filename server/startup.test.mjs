import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SERVICE_PROTOCOL, UI_REVISION, pathIdentity } from './runtime.mjs';

const execute = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
test('10个独立进程跨两个安装副本并发冷启动，只启动1个有效服务并登记全部任务', { timeout: 90_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-startup-'));
  const previous = process.env.MEDIA_REVIEW_DATA_DIR; process.env.MEDIA_REVIEW_DATA_DIR = path.join(base, 'private-data');
  const pids = new Set(); let endpoint = null;
  t.after(async () => {
    if (endpoint) {
      const health = await (await fetch(endpoint + '/api/health')).json();
      assert.equal(health.dataId, pathIdentity(path.join(base, 'private-data/data')));
      const bootstrap = await (await fetch(endpoint + '/api/session/bootstrap')).json();
      await fetch(endpoint + '/api/session/close', { method: 'POST', headers: { Origin: endpoint, 'Content-Type': 'application/json', 'X-Review-Token': bootstrap.token }, body: JSON.stringify({ confirm: true, runtimeId: health.runtimeId }) });
      for (let n = 0; n < 50; n++) { try { await fetch(endpoint + '/api/health', { signal: AbortSignal.timeout(300) }); } catch { break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (previous === undefined) delete process.env.MEDIA_REVIEW_DATA_DIR; else process.env.MEDIA_REVIEW_DATA_DIR = previous;
    await fs.rm(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  async function copy(name) {
    const root = path.join(base, name); await fs.mkdir(path.join(root, 'server'), { recursive: true });
    for (const entry of await fs.readdir(source)) if (entry.endsWith('.mjs') && !entry.endsWith('.test.mjs')) await fs.copyFile(path.join(source, entry), path.join(root, 'server', entry));
    await fs.mkdir(path.join(root, 'dist')); await fs.writeFile(path.join(root, 'dist/index.html'), '<html><head></head><body>并发启动隔离测试</body></html>');
    await fs.writeFile(path.join(root, 'standalone.json'), JSON.stringify({ format: 'media-review-standalone/v1' }));
    return root;
  }
  const roots = [await copy('app-a'), await copy('app-b')];
  const helper = path.join(base, 'invoke.cjs');
  await fs.writeFile(helper, `const cp=require('node:child_process');const {syncBuiltinESMExports}=require('node:module');const {pathToFileURL}=require('node:url');const original=cp.spawn,pids=[];cp.spawn=function(...args){const child=original.apply(this,args);if(child.pid)pids.push(child.pid);return child;};syncBuiltinESMExports();(async()=>{const {openReview}=await import(pathToFileURL(process.argv[2]+'/server/open.mjs').href);const opened=await openReview({rootDir:process.argv[2],media:process.argv[3],browser:false});console.log(JSON.stringify({opened,pids}));})().catch(error=>{console.error(error.message);process.exitCode=1});`);
  const files = [];
  for (let n = 0; n < 10; n++) { const file = path.join(base, `isolated-${n}.mp4`); await fs.writeFile(file, Buffer.alloc(4096, n + 1)); files.push(file); }
  const invoke = async (root, file) => {
    const { stdout } = await execute(process.execPath, [helper, root, file], { windowsHide: true, timeout: 45_000 });
    const result = JSON.parse(stdout.trim()); for (const pid of result.pids) pids.add(pid); endpoint ??= result.opened.url;
    return result;
  };
  const results = await Promise.all(files.map((file, index) => invoke(roots[index % 2], file)));
  assert.equal(pids.size, 1, '启动检查到登记由跨进程门闩保护，不是仅网址碰巧相同');
  assert.equal(new Set(results.map(item => item.opened.url)).size, 1);
  assert.equal(new Set(results.map(item => item.opened.task.id)).size, 10);
  const health = await (await fetch(endpoint + '/api/health')).json();
  assert.equal(health.protocol, SERVICE_PROTOCOL); assert.equal(health.uiRevision, UI_REVISION);
  assert.ok(roots.map(pathIdentity).includes(health.rootId));
  const bootstrap = await (await fetch(endpoint + '/api/session/bootstrap')).json();
  const tasks = await (await fetch(endpoint + '/api/tasks/list', { method: 'POST', headers: { Origin: endpoint, 'Content-Type': 'application/json', 'X-Review-Token': bootstrap.token }, body: '{}' })).json();
  assert.equal(tasks.total, 10);
  if (process.platform === 'win32') {
    const { stdout } = await execute('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const listeners = stdout.split(/\r?\n/u).map(line => line.trim().split(/\s+/u)).filter(parts => parts[0] === 'TCP' && parts[2] === '0.0.0.0:0' && pids.has(Number(parts[4])));
    assert.equal(listeners.length, 1, '用原生端点核对本测试自己启动的服务');
  }
  for (const root of [roots[1], roots[0], roots[1]]) assert.equal((await invoke(root, files[0])).opened.reused, true);
  assert.equal(pids.size, 1);
});
