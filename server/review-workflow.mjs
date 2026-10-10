import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RecordValidationError, validateRecord, validateFingerprint } from './review-record.mjs';
import { ordinaryDirectory, readJson, atomicJson, runtimePaths } from './runtime.mjs';

export const MAX_WORKSPACE_BYTES = 24 * 1024 * 1024;
const TYPES = new Map([['.mp4','video/mp4'],['.mov','video/quicktime'],['.webm','video/webm'],['.mkv','video/x-matroska'],['.avi','video/x-msvideo'],['.wav','audio/wav'],['.mp3','audio/mpeg'],['.m4a','audio/mp4'],['.aac','audio/aac'],['.ogg','audio/ogg'],['.flac','audio/flac']]);
const bad = message => { throw new RecordValidationError(message); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

export async function identifyFile(source) {
  const file = path.resolve(source), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !TYPES.has(path.extname(file).toLowerCase()) || !stat.size) throw new Error('只接受明确指定的普通音视频文件');
  if (await fs.realpath(file) !== file) throw new Error('媒体路径包含链接，请明确指定实际文件');
  const handle = await fs.open(file, 'r');
  try {
    const first = Buffer.alloc(Math.min(stat.size, 256 * 1024)), last = Buffer.alloc(first.length), size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(stat.size)); await handle.read(first, 0, first.length, 0); await handle.read(last, 0, last.length, Math.max(0, stat.size - last.length));
    return { source: file, name: path.basename(file), size: stat.size, type: TYPES.get(path.extname(file).toLowerCase()), mtimeMs: stat.mtimeMs, fingerprint: createHash('sha256').update(size).update(first).update(last).digest('hex') };
  } finally { await handle.close(); }
}

export async function enqueueMedia(root, source) {
  const location = await runtimePaths(root); const directory = await ordinaryDirectory(path.join(location.local, 'inbox'));
  const media = await identifyFile(source); const id = randomUUID();
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ format: 'media-review-input/v1', id, createdAt: new Date().toISOString(), ...media }), { flag: 'wx', mode: 0o600 });
  await atomicJson(path.join(directory, 'current.json'), { id });
  return { id, ...media };
}

function validateDraft(draft, media) {
  if (!keys(draft, ['id','mode','kind','topic','startText','endText','text','rect','frameMs','reference','snapshot'])) bad('恢复草稿字段无效');
  if (!(draft.id === null || typeof draft.id === 'string' && draft.id.length < 100) || ![null,'point','range','frame'].includes(draft.mode) || !['modify','keep','discuss'].includes(draft.kind) || ![null,'visual','subtitle','audio','pace','content','other'].includes(draft.topic)) bad('恢复草稿类型无效');
  if (typeof draft.text !== 'string' || draft.text.length > 2000 || typeof draft.startText !== 'string' || draft.startText.length > 64 || typeof draft.endText !== 'string' || draft.endText.length > 64 || !(draft.frameMs === null || integer(draft.frameMs, media.durationMs))) bad('恢复草稿内容无效');
  if (draft.snapshot !== null && (typeof draft.snapshot !== 'string' || draft.snapshot.length > 3 * 1024 * 1024 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/u.test(draft.snapshot))) bad('恢复参考画面无效');
  validateRecord({ format: 'ai-carry-media-review/v2', media, notes: [{ id: 'draft-validation', kind: draft.kind, topic: draft.topic, startMs: 0, endMs: null, text: '草稿', rect: draft.rect, reference: draft.reference }] });
}
export function validateWorkspace(value) {
  if (!keys(value, ['format','media','currentMs','notes','baseNotes','dirty','newDraft','editDraft','parked','view']) || value.format !== 'media-review-workspace/v1' || typeof value.dirty !== 'boolean' || !integer(value.currentMs, value.media?.durationMs ?? -1)) bad('恢复资料无效');
  for (const notes of [value.notes, value.baseNotes]) validateRecord({ format: 'ai-carry-media-review/v2', media: value.media, notes });
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
  async load(fingerprint) {
    validateFingerprint(fingerprint);
    try { return validateWorkspace(await readJson(path.join(this.reviews, 'drafts', `${fingerprint}.workspace.json`), MAX_WORKSPACE_BYTES)); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw new RecordValidationError('恢复资料无法读取，原文件保留；不会覆盖它'); }
  }
  async save(value) {
    validateWorkspace(value);
    const directory = await ordinaryDirectory(path.join(this.reviews, 'drafts'));
    // 已损坏的恢复文件不能被下一次自动保存悄悄替换。
    await this.load(value.media.fingerprint);
    await atomicJson(path.join(directory, `${value.media.fingerprint}.workspace.json`), value);
    await atomicJson(path.join(directory, 'latest.json'), { fingerprint: value.media.fingerprint, name: value.media.name });
    return { saved: true };
  }
  async latest() {
    try { const pointer = await readJson(path.join(this.reviews, 'drafts/latest.json'), 1024); return await this.load(pointer.fingerprint); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  }
}
