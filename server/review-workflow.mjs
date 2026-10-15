import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RecordValidationError, validateRecord, validateFingerprint, COMPLETE_FORMAT } from './review-record.mjs';
import { ordinaryDirectory, readJson, atomicJson, runtimePaths } from './runtime.mjs';

export const MAX_WORKSPACE_BYTES = 24 * 1024 * 1024;
const TYPES = new Map([['.mp4','video/mp4'],['.mov','video/quicktime'],['.webm','video/webm'],['.mkv','video/x-matroska'],['.avi','video/x-msvideo'],['.wav','audio/wav'],['.mp3','audio/mpeg'],['.m4a','audio/mp4'],['.aac','audio/aac'],['.ogg','audio/ogg'],['.flac','audio/flac']]);
const bad = message => { throw new RecordValidationError(message); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

export async function sampledFingerprint(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) bad('媒体不是普通文件');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (['dev', 'ino', 'size', 'mtimeMs'].some(key => opened[key] !== stat[key])) bad('媒体在读取前发生变化');
    const first = Buffer.alloc(Math.min(stat.size, 256 * 1024)), last = Buffer.alloc(first.length), size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(stat.size));
    const a = await handle.read(first, 0, first.length, 0), b = await handle.read(last, 0, last.length, Math.max(0, stat.size - last.length));
    const after = await handle.stat();
    if (a.bytesRead !== first.length || b.bytesRead !== last.length || ['dev', 'ino', 'size', 'mtimeMs'].some(key => after[key] !== stat[key])) bad('媒体在读取期间发生变化');
    return createHash('sha256').update(size).update(first).update(last).digest('hex');
  } finally { await handle.close(); }
}

export async function identifyFile(source) {
  if (typeof source !== 'string' || !path.isAbsolute(source)) bad('请明确指定媒体的绝对路径');
  const requested = path.resolve(source), file = await fs.realpath(requested), stat = await fs.lstat(requested);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(file) !== normalize(requested) || stat.isSymbolicLink()) bad('媒体路径包含链接，请明确指定实际文件');
  if (!stat.isFile() || !TYPES.has(path.extname(file).toLowerCase()) || !stat.size) bad('只接受明确指定的普通音视频文件');
  return { source: file, name: path.basename(file), size: stat.size, type: TYPES.get(path.extname(file).toLowerCase()), mtimeMs: stat.mtimeMs, fingerprint: await sampledFingerprint(file) };
}

export async function enqueueMedia(root, source) {
  const location = await runtimePaths(root); const directory = await ordinaryDirectory(path.join(location.local, 'inbox'));
  const media = await identifyFile(source); const id = randomUUID();
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ format: 'media-review-input/v1', id, createdAt: new Date().toISOString(), ...media }), { flag: 'wx', mode: 0o600 });
  await atomicJson(path.join(directory, 'current.json'), { id });
  return { id, ...media };
}

function validateDraft(draft, media) {
  const multi = draft && Object.hasOwn(draft, 'regions');
  if (!keys(draft, ['id','mode','kind','topic','startText','endText','text',multi ? 'regions' : 'rect','frameMs','reference','snapshot',...(Object.hasOwn(draft ?? {}, 'regionSerial') ? ['regionSerial'] : [])])) bad('恢复草稿字段无效');
  if (!(draft.id === null || typeof draft.id === 'string' && draft.id.length < 100) || ![null,'point','range','frame','whole'].includes(draft.mode) || !['modify','keep','discuss'].includes(draft.kind) || ![null,'visual','subtitle','audio','pace','content','other'].includes(draft.topic)) bad('恢复草稿类型无效');
  if (typeof draft.text !== 'string' || draft.text.length > 2000 || typeof draft.startText !== 'string' || draft.startText.length > 64 || typeof draft.endText !== 'string' || draft.endText.length > 64 || !(draft.frameMs === null || integer(draft.frameMs, media.durationMs))) bad('恢复草稿内容无效');
  if (draft.snapshot !== null && (typeof draft.snapshot !== 'string' || draft.snapshot.length > 3 * 1024 * 1024 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/u.test(draft.snapshot))) bad('恢复参考画面无效');
  validateRecord({ format: COMPLETE_FORMAT, media, notes: [{ id: 'draft-validation', kind: draft.kind, topic: draft.topic, startMs: 0, endMs: null, text: '草稿', ...(multi ? { regions: draft.regions } : { rect: draft.rect }), reference: draft.reference, ...(draft.regionSerial !== undefined ? { regionSerial: draft.regionSerial } : {}) }] });
}
export function validateWorkspace(value) {
  if (!keys(value, ['format','media','currentMs','notes','baseNotes','dirty','newDraft','editDraft','parked','view']) || !['media-review-workspace/v1','media-review-workspace/v2','media-review-workspace/v3','media-review-workspace/v4'].includes(value.format) || typeof value.dirty !== 'boolean' || !integer(value.currentMs, value.media?.durationMs ?? -1)) bad('恢复资料无效');
  for (const notes of [value.notes, value.baseNotes]) validateRecord({ format: COMPLETE_FORMAT, media: value.media, notes });
  if (!Array.isArray(value.parked) || value.parked.length > 8) bad('保留草稿过多，请先保存或处理');
  for (const draft of [value.newDraft, value.editDraft, ...value.parked]) validateDraft(draft, value.media);
  if (!value.view || !['new','detail','edit'].includes(value.view.kind) || !keys(value.view, value.view.kind === 'new' ? ['kind'] : ['kind','id']) || value.view.kind !== 'new' && !value.notes.some(note => note.id === value.view.id)) bad('恢复意见状态无效');
  return value;
}

export class ReviewWorkflow {
  constructor(root, reviews) { this.root = root; this.reviews = reviews; this.handles = new Map(); }
  async current() {
    const location = await runtimePaths(this.root); const directory = path.join(location.local, 'inbox');
    try {
      const { id } = await readJson(path.join(directory, 'current.json'), 1024);
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id)) throw new Error('成片交接身份无效');
      const value = await readJson(path.join(directory, `${id}.json`), 4096);
      if (value.id !== id || value.format !== 'media-review-input/v1') throw new Error('成片交接格式无效');
      const known = this.handles.get(id);
      const stat = known ? await fs.lstat(known.source) : null;
      const current = known && stat?.isFile() && !stat.isSymbolicLink() && stat.size === known.size && stat.mtimeMs === known.mtimeMs ? known : await identifyFile(value.source);
      if (current.fingerprint !== value.fingerprint || current.size !== value.size || current.mtimeMs !== value.mtimeMs) throw new Error('交接的源文件已经改变，请重新交接；不会用它覆盖旧意见');
      this.handles.set(id, current);
      return { id, name: current.name, size: current.size, type: current.type, mtimeMs: current.mtimeMs, fingerprint: current.fingerprint };
    } catch (cause) { if (cause.code === 'ENOENT') return null; throw new RecordValidationError(cause.message); }
  }
  async media(id) {
    if (!this.handles.has(id)) bad('本次会话没有授权此媒体');
    const expected = this.handles.get(id), stat = await fs.lstat(expected.source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs) bad('原媒体已变化，请重新交接');
    if (stat.size > 1024 * 1024 * 1024) bad('自动带入上限1GB；请手动选择更大的媒体');
    const handle = await fs.open(expected.source, 'r');
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs) { await handle.close(); bad('原媒体在读取前发生变化'); }
    return { ...expected, handle };
  }
  workspaceFile(fingerprint, clientId = null) {
    validateFingerprint(fingerprint);
    if (clientId !== null && !/^[a-f0-9-]{36}$/u.test(clientId)) bad('恢复窗口身份无效');
    return path.join(this.reviews, 'drafts', `${fingerprint}${clientId ? `.${clientId}` : ''}.workspace.json`);
  }
  async load(fingerprint, clientId = null) {
    let file = this.workspaceFile(fingerprint, clientId);
    try {
      if (clientId && !await fs.lstat(file).catch(() => null)) {
        const archived = [];
        try {
          let count = 0;
          for await (const entry of await fs.opendir(path.join(this.reviews, 'drafts', 'archive'))) {
            if (++count > 1024) break;
            if (!entry.name.startsWith(`${fingerprint}.${clientId}.`) || !entry.name.endsWith('.workspace.json')) continue;
            const candidate = path.join(this.reviews, 'drafts', 'archive', entry.name), stat = await fs.lstat(candidate);
            if (stat.isFile() && !stat.isSymbolicLink()) archived.push({ candidate, at: stat.mtimeMs });
          }
        } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        archived.sort((a, b) => b.at - a.at);
        if (archived.length) file = archived[0].candidate;
        else {
          const pointer = await readJson(path.join(this.reviews, 'drafts', `${fingerprint}.latest.json`), 1024).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
          file = this.workspaceFile(fingerprint, pointer?.clientId ?? null);
        }
      }
      const workspace = validateWorkspace(await readJson(file, MAX_WORKSPACE_BYTES));
      this.loadedAt = (await fs.stat(file)).mtimeMs;
      return workspace;
    } catch (cause) { if (cause.code === 'ENOENT') return null; throw new RecordValidationError('恢复资料无法读取，原文件保留；不会覆盖它'); }
  }
  async save(value, clientId = null) {
    validateWorkspace(value);
    if (Buffer.byteLength(`${JSON.stringify(value)}\n`) > MAX_WORKSPACE_BYTES) bad('恢复资料超出容量，本页输入保留');
    const directory = await ordinaryDirectory(path.join(this.reviews, 'drafts'));
    const file = this.workspaceFile(value.media.fingerprint, clientId);
    if (clientId && !await fs.lstat(file).catch(() => null)) {
      const existing = (await fs.readdir(directory)).filter(name => name.startsWith(`${value.media.fingerprint}.`) && name.endsWith('.workspace.json'));
      if (existing.length >= 8) {
        const candidates = await Promise.all(existing.map(async name => ({ name, stat: await fs.lstat(path.join(directory, name)) })));
        const oldest = candidates.filter(item => item.stat.isFile() && !item.stat.isSymbolicLink() && item.stat.size <= MAX_WORKSPACE_BYTES).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)[0];
        if (!oldest) bad('旧窗口恢复副本身份不明，原资料保留，请查看任务资料');
        const source = path.join(directory, oldest.name), bytes = await fs.readFile(source);
        validateWorkspace(await readJson(source, MAX_WORKSPACE_BYTES));
        const archive = await ordinaryDirectory(path.join(directory, 'archive'));
        let count = 0, total = 0;
        for await (const entry of await fs.opendir(archive)) {
          if (++count > 1024) break;
          const stat = await fs.lstat(path.join(archive, entry.name)); total += stat.size;
        }
        if (count >= 1024 || total + bytes.length > 256 * 1024 * 1024) bad('恢复归档已达1024份或256MiB，请先整理drafts/archive；旧资料未删除，本页输入保留');
        const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const archived = path.join(archive, `${oldest.name.slice(0, -15)}.${digest}.workspace.json`);
        try { await fs.copyFile(source, archived, fs.constants.COPYFILE_EXCL); }
        catch (cause) {
          if (cause.code !== 'EEXIST') throw cause;
          const stat = await fs.lstat(archived);
          if (!stat.isFile() || stat.isSymbolicLink() || !(await fs.readFile(archived)).equals(bytes)) bad('恢复归档身份冲突，未替换旧文件');
        }
        const current = await fs.lstat(source);
        if (['dev', 'ino', 'size', 'mtimeMs'].some(key => current[key] !== oldest.stat[key])) bad('旧窗口副本在归档期间变化，两个位置均保留');
        await fs.unlink(source); // 旧字节已独立保留在archive，不作为可重建缓存删除。
      }
    }
    // 每个窗口独立恢复副本，接管或陈旧自动保存不能覆盖另一窗口的输入。
    try { validateWorkspace(await readJson(file, MAX_WORKSPACE_BYTES)); } catch (cause) { if (cause.code !== 'ENOENT') bad('恢复资料无法读取，原文件保留；不会覆盖它'); }
    await atomicJson(file, value);
    await atomicJson(path.join(directory, `${value.media.fingerprint}.latest.json`), { clientId });
    await atomicJson(path.join(directory, 'latest.json'), { fingerprint: value.media.fingerprint, name: value.media.name, clientId });
    return { saved: true };
  }
  async archive(value, clientId) {
    validateWorkspace(value); this.workspaceFile(value.media.fingerprint, clientId);
    const directory = await ordinaryDirectory(path.join(this.reviews, 'drafts', 'archive'));
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > MAX_WORKSPACE_BYTES) bad('恢复副本超出容量，原输入保留');
    let count = 0, total = 0;
    for await (const entry of await fs.opendir(directory)) {
      if (++count > 1024) break;
      total += (await fs.lstat(path.join(directory, entry.name))).size;
    }
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const file = path.join(directory, `${value.media.fingerprint}.${clientId}.${digest}.workspace.json`);
    const existing = await fs.lstat(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null; });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length || !(await fs.readFile(file)).equals(bytes)) bad('恢复归档身份冲突，未覆盖');
    } else {
      if (count >= 1024 || total + bytes.length > 256 * 1024 * 1024) bad('恢复归档容量已满，请先整理drafts/archive；旧资料和本页输入保留');
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    if (!(await fs.readFile(file)).equals(bytes)) bad('恢复归档未读回确认，本页输入保留');
    return { archived: true };
  }
  async latest() {
    try { const pointer = await readJson(path.join(this.reviews, 'drafts/latest.json'), 1024); return await this.load(pointer.fingerprint, pointer.clientId ?? null); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  }
}
