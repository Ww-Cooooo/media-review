import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export const UI_REVISION = 'history-20261009-r2';
export async function runtimePaths(root) {
  const marker = path.join(root, 'standalone.json');
  const markerStat = await fs.lstat(marker).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null; });
  if (markerStat && (!markerStat.isFile() || markerStat.isSymbolicLink())) throw new Error('独立版身份文件无效');
  const standalone = !!markerStat;
  if (standalone && (await readJson(marker, 1024)).format !== 'media-review-standalone/v1') throw new Error('独立版身份不匹配，未改用户数据');
  const local = standalone
    ? path.join(process.env.MEDIA_REVIEW_DATA_DIR || path.join(os.homedir(), '.media-review-desk'), 'data')
    : path.resolve(root, '../../.assistant-local/extensions/media-review-desk');
  return { standalone, local, reviews: standalone ? path.join(local, 'reviews') : path.join(root, 'reviews'), session: path.join(local, 'session.json') };
}

export async function ordinaryDirectory(directory) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error('数据目录不是普通目录，原内容保留');
  }
  return absolute;
}

export async function readJson(file, maxBytes = 24 * 1024 * 1024) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('本机资料不是可读取的普通文件，原内容保留');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function atomicJson(file, value) {
  const temporary = path.join(path.dirname(file), `.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    const old = await fs.lstat(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null; });
    if (old && (!old.isFile() || old.isSymbolicLink())) throw new Error('目标不是普通文件，拒绝覆盖');
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally { if (handle) await handle.close(); await fs.unlink(temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause; }); }
}
