import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const windows = process.platform === 'win32';
const quote = s => "'" + s.replaceAll("'", "''") + "'";
test('Windows desktop entry: repeat, copies, concurrency, versions and separate libraries', { skip: !windows, timeout: 120_000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-review-desktop-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const desktop = path.join(base, 'desktop'); await fs.mkdir(desktop);
  const env = { ...process.env }; delete env.MEDIA_REVIEW_DATA_DIR;
  async function pack(name, version) {
    const root = path.join(base, name), files = [];
    const contents = {
      'scripts/install.ps1': await fs.readFile(new URL('../skill/scripts/install.ps1', import.meta.url)),
      'scripts/desktop-entry.ps1': await fs.readFile(new URL('../skill/scripts/desktop-entry.ps1', import.meta.url)),
      'scripts/setup.mjs': Buffer.from('// isolated installer fixture; not a media runtime'),
      'app/dist/brand/media-review-launcher.ico': Buffer.from('fixture'),
    };
    for (const [relative, bytes] of Object.entries(contents)) {
      const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
      files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
    await fs.writeFile(path.join(root, 'skill-package.json'), JSON.stringify({ name: 'media-review', skill_id: 'fixture-media-review', version, files }));
    return root;
  }
  const a = await pack('Agent A', '0.3.0-beta.10'), b = await pack('Agent B', '0.3.0-beta.10');
  async function install(root, { dir = desktop, data, name } = {}) {
    return execute('pwsh', ['-NoProfile', '-File', path.join(root, 'scripts/install.ps1'), '-InitializeOnly', '-SkipPageLauncher', '-DesktopDirectory', dir, ...(name ? ['-DesktopName', name] : [])], { windowsHide: true, timeout: 45_000, env: { ...env, ...(data ? { MEDIA_REVIEW_DATA_DIR: data } : {}) } });
  }
  async function links(dir = desktop) {
    const { stdout } = await execute('pwsh', ['-NoProfile', '-Command', `$s=New-Object -ComObject WScript.Shell; $result=@(Get-ChildItem -LiteralPath ${quote(dir)} -Filter '*.lnk' | ForEach-Object { $l=$s.CreateShortcut($_.FullName); [pscustomobject]@{name=$_.Name;args=$l.Arguments;target=$l.TargetPath} }); ConvertTo-Json -InputObject $result -Compress`], { windowsHide: true });
    return JSON.parse(stdout);
  }
  await install(a);
  const file = path.join(desktop, 'Media Review.lnk'), first = await fs.readFile(file), stamp = (await fs.stat(file)).mtimeMs;
  await install(a); await install(b);
  assert.deepEqual(await fs.readFile(file), first); assert.equal((await fs.stat(file)).mtimeMs, stamp);
  assert.equal((await links()).length, 1); assert.ok((await links())[0].args.includes(a));
  // A different startup-only flag also reuses the entry.
  const helper = path.join(base, 'flag.ps1');
  await fs.writeFile(helper, `. ${quote(path.join(a, 'scripts/install.ps1'))} -InitializeOnly -SkipPageLauncher -DesktopDirectory ${quote(desktop)}\nSet-ReviewDesktopEntry -Target ${quote(b)} -Node ${quote(process.execPath)} -DesktopDirectory ${quote(desktop)} -DataRoot (Join-Path $HOME '.media-review-desk')\n`);
  await execute('pwsh', ['-NoProfile', '-File', helper], { windowsHide: true, env });
  assert.deepEqual(await fs.readFile(file), first);
  const cold = path.join(base, 'concurrent'); await fs.mkdir(cold);
  await Promise.all(Array.from({ length: 6 }, (_, i) => install(i % 2 ? a : b, { dir: cold })));
  assert.equal((await links(cold)).length, 1);
  const next = await pack('new version', '0.3.0-beta.11');
  await install(next); assert.ok((await links())[0].args.includes(next));
  await install(a); assert.ok((await links())[0].args.includes(next), 'older caller cannot downgrade');
  await fs.rename(next, next + '-moved');
  await install(b); assert.ok((await links())[0].args.includes(b), 'missing runtime repairs the same entry');
  await fs.rm(path.join(b, 'app/dist/brand/media-review-launcher.ico'));
  await install(a); assert.ok((await links())[0].args.includes(a), 'partly deleted same-version runtime is not reused');
  await fs.writeFile(path.join(b, 'app/dist/brand/media-review-launcher.ico'), 'fixture');
  const custom = path.join(base, 'private library'); await fs.mkdir(custom); await fs.writeFile(path.join(custom, 'keep.txt'), 'user data');
  await install(a, { data: custom }); assert.equal((await links()).length, 1);
  await install(a, { data: custom, name: 'Media Review - Project' });
  await install(b, { data: custom, name: 'Media Review - Project' });
  assert.equal((await links()).length, 2); assert.ok((await links()).find(x => x.name.includes('Project')).args.includes(custom));
  await assert.rejects(install(a, { data: path.join(base, 'other library'), name: 'Media Review - Project' }));
  await assert.rejects(install(a, { data: custom, name: 'Media Review' }));
  assert.equal(await fs.readFile(path.join(custom, 'keep.txt'), 'utf8'), 'user data');
  const unrelated = path.join(base, 'unrelated'); await fs.mkdir(unrelated);
  await execute('pwsh', ['-NoProfile', '-Command', `$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut(${quote(path.join(unrelated, 'Media Review.lnk'))}); $l.TargetPath=${quote(process.execPath)}; $l.Arguments='--version'; $l.Save()`], { windowsHide: true });
  const original = await fs.readFile(path.join(unrelated, 'Media Review.lnk'));
  await assert.rejects(install(a, { dir: unrelated }));
  assert.deepEqual(await fs.readFile(path.join(unrelated, 'Media Review.lnk')), original);
  assert.equal((await links(unrelated)).length, 1);
});
