import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
export const say = message => console.error(`[Media Review] ${message}`);
export function dataRoot() {
  const root = process.env.MEDIA_REVIEW_DATA_DIR || path.join(os.homedir(), '.media-review-desk');
  if (!path.isAbsolute(root)) throw new Error('MEDIA_REVIEW_DATA_DIR 必须是绝对路径；未改动原资料。');
  return path.resolve(root);
}
export async function ordinaryDirectory(directory) {
  const full = path.resolve(directory), parsed = path.parse(full);
  let current = parsed.root;
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error('准备目录含链接或不是普通目录，原内容保留。');
  }
  return full;
}
export async function ordinaryFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const stat = await fs.lstat(file).catch(() => null);
  return !!stat?.isFile() && !stat.isSymbolicLink() && (await fs.realpath(file)).toLowerCase() === path.resolve(file).toLowerCase();
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function readObject(file) {
  if (!await ordinaryFile(file)) throw new Error('配置不是普通文件，原内容保留。');
  const stat = await fs.stat(file);
  if (stat.size > 1024 * 1024) throw new Error('配置大小异常，原内容保留。');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置格式不正确，原内容保留。');
  return value;
}
export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const old = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (old && !await ordinaryFile(file)) throw new Error('配置不是普通文件，原内容保留。');
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function findCommand(name, usable = async () => true) {
  try {
    const { stdout } = await execute(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/where.exe'), [name], { windowsHide: true, timeout: 5000 });
    for (const file of stdout.trim().split(/\r?\n/u)) if (await ordinaryFile(file) && await usable(file)) return file;
  } catch { /* Only the explicit PATH is inspected, never the whole disk. */ }
  return null;
}
export async function removeOwned(directory, parent, prefix) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith(prefix)) throw new Error('临时目录边界不匹配，未删除。');
  const stat = await fs.lstat(resolved).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('临时目录身份异常，未删除。');
  await fs.rm(resolved, { recursive: true });
}
export async function download(url, file, { sha256, bytes, label = '文件' } = {}) {
  if (!url.startsWith('https://')) throw new Error('下载只允许 HTTPS。');
  const partial = `${file}.${randomUUID()}.part`;
  say(`正在下载${label}${bytes ? `（约 ${Math.ceil(bytes / 1024 ** 2)} MB）` : ''}。`);
  let lastReported = Date.now();
  const timer = setInterval(async () => {
    const stat = await fs.stat(partial).catch(() => null);
    if (stat && Date.now() - lastReported >= 15_000) { say(`${label}已下载 ${Math.floor(stat.size / 1024 ** 2)} MB。`); lastReported = Date.now(); }
  }, 15_000); timer.unref();
  try {
    await execute(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/curl.exe'), [
      '--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '30', '--max-time', '1800', '--speed-limit', '8192', '--speed-time', '45', '--retry', '2', '--retry-all-errors', '--retry-max-time', '1800',
      '--max-filesize', String(bytes ?? 100 * 1024 ** 2), '--output', partial, url,
    ], { windowsHide: true, timeout: 1900_000, maxBuffer: 8192 });
    if (bytes && (await fs.stat(partial)).size !== bytes) throw new Error('长度不符');
    if (sha256 && await hashFile(partial) !== sha256) throw new Error('校验不符');
    // Never overwrite a previous unrelated file with the result of a network operation.
    await fs.copyFile(partial, file, (await import('node:fs')).constants.COPYFILE_EXCL);
  } catch { throw new Error(`${label}下载或校验失败，未执行未验证文件；检查网络后重新运行同一入口，已完成工具会复用。`); }
  finally { clearInterval(timer); await fs.unlink(partial).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function safeArchiveEntry(name) {
  const normalized = name.replaceAll('\\', '/');
  return !/^(?:\/|[a-z]:)/iu.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes(':');
}
export async function extractZip(file, destination) {
  const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/tar.exe');
  const { stdout } = await execute(tar, ['-tf', file], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 ** 2 });
  if (stdout.split(/\r?\n/u).filter(Boolean).some(name => !safeArchiveEntry(name))) throw new Error('下载包包含越界路径，未解压。');
  await execute(tar, ['-xf', file, '-C', destination], { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 });
  async function check(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('下载包包含链接，未执行。');
      if (item.isDirectory()) await check(path.join(dir, item.name));
    }
  }
  await check(destination);
}
export async function provision(id, spec, runtime) {
  const target = path.join(runtime, `${id}-${spec.version}`), entry = path.join(target, spec.entry);
  if (await ordinaryFile(entry)) return entry;
  await ordinaryDirectory(runtime);
  const stage = await fs.mkdtemp(path.join(runtime, '.prepare-'));
  try {
    const archive = path.join(stage, id === 'model' ? spec.entry : 'download.zip');
    await download(spec.url, archive, { ...spec, label: id === 'model' ? '中文语音模型' : id });
    if (id !== 'model') { await extractZip(archive, stage); await fs.unlink(archive); }
    if (!await ordinaryFile(path.join(stage, spec.entry))) throw new Error(`${id}下载包缺少约定入口，未采用。`);
    await atomicJson(path.join(stage, 'media-review-managed.json'), { id, version: spec.version, sha256: spec.sha256 });
    // A partial or user-modified target is retained, never recursively replaced.
    await fs.rename(stage, target).catch(() => { throw new Error(`${id}的目标目录已有未完成或不同内容，原样保留；请 Agent 核对该目录后恢复。`); });
    return entry;
  } finally { await removeOwned(stage, runtime, '.prepare-'); }
}
export async function validatePackage(root, version) {
  const manifest = await readObject(path.join(root, 'skill-package.json'));
  if (manifest.name !== 'media-review' || manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length > 1000) throw new Error('完整包身份或版本不匹配。');
  for (const item of manifest.files) {
    if (!safeArchiveEntry(item.path) || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error('完整包清单无效。');
    const file = path.join(root, item.path);
    if (!await ordinaryFile(file) || await hashFile(file) !== item.sha256) throw new Error('完整包内容不完整或有本机修改，原样保留；未覆盖。');
  }
  return manifest;
}
export async function resolvePackage(skillRoot, version, acquire = false) {
  if (await ordinaryFile(path.join(skillRoot, 'skill-package.json'))) return skillRoot;
  const packages = path.join(dataRoot(), 'runtime/packages'), target = path.join(packages, `media-review-${version}`);
  if (await ordinaryFile(path.join(target, 'skill-package.json'))) { await validatePackage(target, version); return target; }
  if (!acquire) throw new Error('首次使用尚未准备完成；请 Agent 运行本 Skill 的 scripts/first-use.cmd。');
  await ordinaryDirectory(packages);
  const stage = await fs.mkdtemp(path.join(packages, '.package-'));
  try {
    const name = `media-review-${version}-windows.zip`, base = `https://github.com/Ww-Cooooo/media-review/releases/download/v${version}`;
    const sums = path.join(stage, 'SHA256SUMS.txt');
    await download(`${base}/SHA256SUMS.txt`, sums, { label: '公开包校验清单' });
    const line = (await fs.readFile(sums, 'utf8')).split(/\r?\n/u).find(value => value.trim().endsWith(` ${name}`));
    const digest = line?.trim().split(/\s+/u)[0];
    if (!/^[a-f0-9]{64}$/u.test(digest ?? '')) throw new Error('公开包校验清单未找到本版安装包。');
    const archive = path.join(stage, name), extracted = path.join(stage, 'package');
    await download(`${base}/${name}`, archive, { sha256: digest, label: 'Media Review 完整运行包' });
    await fs.mkdir(extracted); await extractZip(archive, extracted);
    await validatePackage(extracted, version); await fs.rename(extracted, target);
    return target;
  } finally { await removeOwned(stage, packages, '.package-'); }
}
