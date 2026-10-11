import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRecord, validateFingerprint } from './review-record.mjs';
import { identifyFile, ReviewWorkflow } from './review-workflow.mjs';
import { ordinaryDirectory, readJson, atomicJson, keyedSerial, ReviewError } from './runtime.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export function taskIdentity(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ReviewError('任务身份无效', 'invalid_task', 400);
  return value;
}
function label(value = '', title = false) {
  if (typeof value !== 'string' || value.length > (title ? 255 : 120) || (title ? /\u0000/u : /[\u0000-\u001f]/u).test(value)) throw new ReviewError('任务名称或来源标识无效', 'invalid_task', 400);
  return value;
}
const sameInput = (a, b) => ['name', 'size', 'type', 'fingerprint', 'source', 'mtimeMs'].every(key => a[key] === b[key]);
function publicTask(value) {
  const { source, ...media } = value.media;
  return { id: value.id, title: value.title, label: value.label, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, manual: !source, legacy: !!value.legacy, contentHash: value.contentHash ?? null, media, jobs: value.jobs };
}

export class ReviewTasks {
  constructor(local, legacyReviews, { maxActive = 100, maxRecords = 10_000 } = {}) {
    this.directory = path.join(local, 'tasks'); this.legacyReviews = legacyReviews;
    this.maxActive = maxActive; this.maxRecords = maxRecords;
    this.headers = new Map(); this.serial = keyedSerial(); this.warnings = []; this.recordCount = 0;
  }
  async init() {
    await ordinaryDirectory(this.directory);
    const entries = await fs.opendir(this.directory);
    for await (const entry of entries) {
      if (!UUID.test(entry.name)) continue;
      if (++this.recordCount > this.maxRecords) { this.warnings.push('任务数量达到登记上限；请先整理本机资料。已有文件未删除。'); break; }
      try { this.remember(await this.read(entry.name)); }
      catch { this.warnings.push(`任务 ${entry.name.slice(0, 8)} 暂不可读，原文件保留。`); }
    }
    return this;
  }
  async importLegacyInbox() {
    const marker = path.join(this.directory, 'legacy-inbox-import.json');
    try { if ((await readJson(marker, 1024)).format === 'media-review-legacy-import/v1') return; }
    catch (cause) { if (cause.code !== 'ENOENT') { this.warnings.push('旧交接迁移标记不可读，原资料保留。'); return; } }
    const inbox = path.join(this.directory, '..', 'inbox');
    let entries, currentId = null, complete = true;
    try {
      const stat = await fs.lstat(inbox);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('旧交接目录不是普通目录');
      entries = await fs.opendir(inbox);
    } catch (cause) { if (cause.code === 'ENOENT') return; this.warnings.push('旧交接目录暂不可读，原文件保留。'); return; }
    try { currentId = (await readJson(path.join(inbox, 'current.json'), 1024)).id; }
    catch (cause) { if (cause.code !== 'ENOENT') { complete = false; this.warnings.push('旧版current指针不可读，未猜测正在审的媒体。'); } }
    let count = 0;
    for await (const entry of entries) {
      const id = entry.name.replace(/\.json$/u, '');
      if (!UUID.test(id) || this.headers.has(id)) continue;
      if (++count > this.maxRecords) { complete = false; this.warnings.push('旧交接数量过多，原inbox保留，请先整理。'); break; }
      try {
        const value = await readJson(path.join(inbox, entry.name), 4096);
        if (value.format !== 'media-review-input/v1' || value.id !== id || !path.isAbsolute(value.source) || !Number.isFinite(value.mtimeMs)) throw new Error('旧交接格式无效');
        validateRecord({ format: 'ai-carry-media-review/v2', media: { name: value.name, size: value.size, type: value.type, durationMs: 1, fingerprint: value.fingerprint }, notes: [] });
        await this.create({ source: value.source, name: value.name, size: value.size, type: value.type, mtimeMs: value.mtimeMs, fingerprint: value.fingerprint }, { requestId: id, label: '旧版交接 · 原资料保留', legacy: true, status: id === currentId ? 'waiting' : 'legacy', createdAt: Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : new Date().toISOString() });
      } catch { complete = false; if (this.warnings.length < 10) this.warnings.push(`旧交接 ${id.slice(0, 8)} 未迁移，原文件未改动。`); }
    }
    if (complete) await atomicJson(marker, { format: 'media-review-legacy-import/v1' });
  }
  remember(value) {
    const item = publicTask(value);
    this.headers.set(value.id, item);
  }
  get activeCount() { return [...this.headers.values()].filter(item => item.status === 'waiting').length; }
  async directoryFor(id) {
    const directory = path.join(this.directory, taskIdentity(id)), stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new ReviewError('任务目录已变化，原资料保留');
    return directory;
  }
  async read(id) {
    const value = await readJson(path.join(await this.directoryFor(id), 'task.json'), 16_384);
    if (value.format !== 'media-review-task/v1' || value.id !== id || !['waiting', 'closed', 'legacy'].includes(value.status) || !value.jobs || !value.media) throw new ReviewError('任务登记格式不可读，原内容保留');
    taskIdentity(value.id); validateFingerprint(value.media.fingerprint); label(value.title, true); label(value.label);
    if (value.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(value.contentHash)) throw new ReviewError('任务内容摘要无效，原资料保留');
    return value;
  }
  list({ offset = 0, limit = 20, closed = false } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || typeof closed !== 'boolean') throw new ReviewError('任务分页无效', 'invalid_task', 400);
    const items = [...this.headers.values()].filter(item => closed || item.status === 'waiting').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: items.slice(offset, offset + limit), total: items.length, active: this.activeCount, warnings: this.warnings.slice(0, 10) };
  }
  async registerSource(source, options = {}) {
    const media = await identifyFile(source);
    return this.create(media, options);
  }
  async registerManual(identity, { newTask = false, mtimeMs = 0, ...options } = {}) {
    validateRecord({ format: 'ai-carry-media-review/v2', media: identity, notes: [] });
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0) throw new ReviewError('手选媒体时间无效', 'invalid_task', 400);
    const media = { ...identity, source: null, mtimeMs };
    if (!newTask) {
      const same = [...this.headers.values()].filter(item => item.manual && item.status !== 'closed' && item.media.fingerprint === identity.fingerprint && item.media.name === identity.name && item.media.size === identity.size);
      if (same.length === 1) {
        if (same[0].media.mtimeMs > 0 && mtimeMs > 0 && same[0].media.mtimeMs !== mtimeMs) throw new ReviewError('手选文件的修改时间已变化，未沿用旧任务；请核对原文件，或在任务列表明确新建独立任务', 'media_changed');
        return same[0];
      }
      if (same.length > 1) throw new ReviewError('这份素材有多个独立任务，请在任务列表中选择要继续的任务；不会自动合并意见。', 'choose_task');
    }
    const legacyFile = path.join(this.legacyReviews, `${identity.fingerprint}.review.json`);
    const legacyDraft = path.join(this.legacyReviews, 'drafts', `${identity.fingerprint}.workspace.json`);
    const legacy = !newTask && (!!await fs.lstat(legacyFile).catch(() => null) || !!await fs.lstat(legacyDraft).catch(() => null));
    return this.create(media, { ...options, legacy });
  }
  async create(media, { requestId = randomUUID(), title = media.name, label: origin = '', legacy = false, status = 'waiting', createdAt = new Date().toISOString() } = {}) {
    const id = taskIdentity(requestId); label(title, true); label(origin);
    return this.serial('registry', async () => {
      if (this.headers.has(id)) {
        const existing = await this.read(id);
        if (!sameInput(existing.media, media) || existing.title !== title || existing.label !== origin) throw new ReviewError('同一请求标识已绑定另一份素材或来源，未覆盖原任务', 'task_conflict');
        return publicTask(existing);
      }
      if (status === 'waiting' && this.activeCount >= this.maxActive || this.recordCount >= this.maxRecords) throw new ReviewError('待校对任务或登记总量已达上限，请先结束不再等待的任务；资料不会自动删除。', 'task_capacity', 429);
      const directory = path.join(this.directory, id);
      await fs.mkdir(directory); // 不认领碰撞、未知或损坏的已有目录。
      const at = new Date().toISOString();
      const value = { format: 'media-review-task/v1', id, title, label: origin, createdAt, updatedAt: at, status, legacy, media, jobs: {} };
      await atomicJson(path.join(directory, 'task.json'), value);
      this.recordCount++; this.remember(value); return publicTask(value);
    });
  }
  async patch(id, change) {
    return this.serial('registry', async () => {
      const current = await this.read(taskIdentity(id));
      const next = { ...current, ...change, updatedAt: new Date().toISOString() };
      await atomicJson(path.join(await this.directoryFor(id), 'task.json'), next);
      this.remember(next); return publicTask(next);
    });
  }
  async setJob(id, kind, jobId) {
    return this.serial('registry', async () => {
      const current = await this.read(taskIdentity(id));
      current.jobs[kind] = taskIdentity(jobId); current.updatedAt = new Date().toISOString();
      await atomicJson(path.join(await this.directoryFor(id), 'task.json'), current); this.remember(current);
    });
  }
  async changeStatus(id, status) {
    if (!['waiting', 'closed'].includes(status)) throw new ReviewError('任务状态无效', 'invalid_task', 400);
    if (status === 'waiting' && this.headers.get(id)?.status !== 'waiting' && this.activeCount >= this.maxActive) throw new ReviewError('待校对任务已满，请先结束另一任务', 'task_capacity', 429);
    return this.patch(id, { status });
  }
  async scope(id, fingerprint) {
    if (id === null || id === undefined) return this.legacyReviews;
    const value = await this.read(taskIdentity(id));
    if (fingerprint && value.media.fingerprint !== fingerprint) throw new ReviewError('任务与媒体身份不匹配，未读写另一任务', 'task_conflict');
    return value.legacy ? this.legacyReviews : ordinaryDirectory(path.join(await this.directoryFor(id), 'reviews'));
  }
  async bindContent(id, hash) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new ReviewError('媒体完整摘要无效', 'media_changed');
    return this.serial('registry', async () => {
      const task = await this.read(taskIdentity(id));
      if (task.contentHash && task.contentHash !== hash) throw new ReviewError('媒体完整内容与本任务绑定的版本不同，请登记新任务；原意见未迁移', 'media_changed');
      if (task.contentHash) return;
      task.contentHash = hash;
      await atomicJson(path.join(await this.directoryFor(id), 'task.json'), task); this.remember(task);
    });
  }
  async setDuration(id, durationMs) {
    return this.serial('registry', async () => {
      const task = await this.read(taskIdentity(id));
      if (task.media.durationMs === durationMs) return;
      task.media.durationMs = durationMs;
      await atomicJson(path.join(await this.directoryFor(id), 'task.json'), task); this.remember(task);
    });
  }
  async source(id) {
    const task = await this.read(taskIdentity(id));
    if (!task.media.source) throw new ReviewError('这是手选素材，请重新选择同一文件；不会扫描电脑寻找替代品', 'media_manual');
    let actual;
    try { actual = await identifyFile(task.media.source); }
    catch (cause) {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') throw new ReviewError('原媒体已移动或不存在，请手选同一版本继续；不会扫描电脑猜测替代文件，原意见保留', 'media_missing', 404);
      throw new ReviewError('原媒体暂不可读取或路径身份已变化，请核对原文件；原意见保留', 'media_unavailable');
    }
    if (!sameInput(actual, task.media)) throw new ReviewError('原媒体已变化，请登记为新任务；原意见与坐标未迁移', 'media_changed');
    return actual;
  }
  async workflow(root, id, fingerprint) {
    return new ReviewWorkflow(root, await this.scope(id, fingerprint));
  }
}
