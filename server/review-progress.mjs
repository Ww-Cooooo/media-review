import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRecord } from './review-record.mjs';
import { ordinaryDirectory, atomicJson, readJson, keyedSerial, documentRevision, ReviewError } from './runtime.mjs';
import { verifyReferences } from './review-reference.mjs';

export const PROGRESS_STATES = ['pending', 'clarify', 'changed', 'confirmed'];
export const noteRevision = note => documentRevision(note);
const fail = message => { throw new ReviewError(message, 'invalid_progress', 400); };
const text = (value, max = 3000) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('说明文字无效或过长');
  return value.trim();
};
const empty = () => ({ format: 'media-review-progress/v1', events: [], acknowledgements: [], checks: [] });

// Agent progress never rewrites user notes. Each event is bound to the exact note
// content it processed; changing that note makes its previous resolution stale.
export class ReviewProgress {
  constructor(tasks) { this.tasks = tasks; this.serial = keyedSerial(); }
  async record(taskId, revision = null) {
    const task = await this.tasks.read(taskId), directory = await this.tasks.scope(taskId, task.media.fingerprint);
    if (revision !== null && !/^[a-f0-9]{64}$/u.test(revision)) fail('意见版本无效');
    const file = revision ? path.join(directory, 'handoffs', revision, `${task.media.fingerprint}.review.json`) : path.join(directory, `${task.media.fingerprint}.review.json`);
    let record = null;
    try { record = validateRecord(await readJson(file), task.media.fingerprint); }
    catch (cause) { if (cause.code !== 'ENOENT' || revision) throw cause; }
    if (revision && documentRevision(record) !== revision) fail('交接快照与版本不符，原内容保留');
    return { task, directory, record, revision: documentRevision(record), recordPath: file.replaceAll('\\', '/') };
  }
  async read(taskId) {
    const file = path.join(await this.tasks.directoryFor(taskId), 'progress.json');
    let value;
    try { value = await readJson(file, 4 * 1024 * 1024); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; value = empty(); }
    if (value.format !== 'media-review-progress/v1' || !Array.isArray(value.events) || !Array.isArray(value.checks) || !Array.isArray(value.acknowledgements)) fail('返修进度格式不可读，原文件保留');
    return { ...value, revision: documentRevision(value) };
  }
  async write(taskId, baseRevision, mutate) {
    return this.serial(taskId, async () => {
      const { revision, ...current } = await this.read(taskId);
      if (baseRevision !== revision) throw new ReviewError('返修进度已更新，请刷新后重试；本次输入保留。', 'progress_conflict');
      if (current.events.length + current.checks.length + current.acknowledgements.length >= 3000) fail('本任务进度记录已达上限；历史保留，请开启下一轮');
      await mutate(current);
      if (Buffer.byteLength(JSON.stringify(current)) > 4 * 1024 * 1024) fail('进度资料过大，请缩短说明');
      await atomicJson(path.join(await this.tasks.directoryFor(taskId), 'progress.json'), current);
      return this.read(taskId);
    });
  }
  async update(body, context, clients) {
    const { taskId, recordRevision, baseRevision, noteId, status, actor = 'agent', targetTaskId = null, targetMs = null } = body;
    if (!PROGRESS_STATES.includes(status) || !['agent', 'user'].includes(actor)) fail('返修状态无效');
    if (actor === 'agent' && status === 'confirmed') fail('Agent 不能代替用户确认');
    if (actor === 'user') {
      if (!context?.taskId) fail('请在当前任务内确认或重新打开');
      const task = await this.tasks.read(context.taskId);
      if (task.status !== 'waiting') fail('请先重开任务再更新进度');
      clients.assert(task.legacy ? `legacy:${task.media.fingerprint}` : `task:${task.id}`, context);
    }
    const current = await this.record(taskId);
    if (current.revision !== recordRevision || !current.record) throw new ReviewError('意见已经变化，请重新读取本轮意见再处理', 'review_conflict');
    const note = current.record.notes.find(item => item.id === noteId);
    if (!note) fail('这条意见已不存在，未改动其他意见');
    const explanation = text(body.text ?? '');
    if (['changed', 'clarify'].includes(status) && !explanation) fail('请写明修改内容或需要澄清的问题');
    if (targetTaskId) {
      const target = await this.tasks.read(targetTaskId);
      if ((target.version?.workId ?? target.id) !== (current.task.version?.workId ?? current.task.id) || target.id === taskId || (target.version?.number ?? 1) <= (current.task.version?.number ?? 1)) fail('返修结果必须关联同一作品的后续版本');
      if (targetMs !== null && (!Number.isSafeInteger(targetMs) || targetMs < 0 || !target.media.durationMs || targetMs > target.media.durationMs)) fail('新版定位超出已核实的媒体时长；可先不填位置');
    } else if (targetMs !== null) fail('填写新版位置前请先关联新版');
    if (status === 'changed' && !targetTaskId) fail('已修改待复核需要关联实际新版');
    return this.write(taskId, baseRevision, data => {
      const previous = [...data.events].reverse().find(event => event.noteId === noteId && event.noteRevision === noteRevision(note));
      if (actor === 'user' && context.taskId !== taskId && (previous?.targetTaskId !== context.taskId || !['confirmed', 'pending'].includes(status))) fail('仅可在原版处理意见或在对应返修版复核');
      if (status === 'confirmed' && previous?.status !== 'changed') fail('请先记录返修结果，再由用户复核确认');
      data.events.push({ id: randomUUID(), noteId, noteRevision: noteRevision(note), recordRevision, status, text: explanation, targetTaskId: targetTaskId ?? previous?.targetTaskId ?? null, targetMs: targetMs ?? previous?.targetMs ?? null, actor, at: new Date().toISOString() });
    });
  }
  async snapshot(taskId, revision) {
    const loaded = await this.record(taskId);
    if (!loaded.record || !revision || revision !== loaded.revision) throw new ReviewError('意见版本已变化，请重新保存后交接', 'review_conflict');
    await verifyReferences(loaded.directory, loaded.record);
    const directory = await ordinaryDirectory(path.join(loaded.directory, 'handoffs', revision));
    const file = path.join(directory, `${loaded.record.media.fingerprint}.review.json`);
    if (await fs.lstat(file).catch(() => null)) {
      if (documentRevision(validateRecord(await readJson(file))) !== revision) fail('已有交接快照不可读，未覆盖');
    } else {
      for (const note of loaded.record.notes) if (note.reference) {
        const refDir = await ordinaryDirectory(path.join(directory, 'references', loaded.record.media.fingerprint));
        try { await fs.copyFile(path.join(loaded.directory, 'references', loaded.record.media.fingerprint, note.reference.fileName), path.join(refDir, note.reference.fileName), fs.constants.COPYFILE_EXCL); }
        catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      }
      await fs.writeFile(file, JSON.stringify(loaded.record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return { taskId, revision, sourceLabel: loaded.task.label || '手选素材', title: loaded.task.title, version: loaded.task.version ?? { workId: taskId, number: 1, parentTaskId: null }, recordPath: file.replaceAll('\\', '/') };
  }
  async acknowledge(body) {
    const round = await this.record(body.taskId, body.recordRevision);
    const agent = text(body.agent, 120), message = text(body.text ?? '');
    if (!agent || !round.record) fail('请提供接手对话的简短名称');
    const clarifications = body.clarifications ?? [];
    if (!Array.isArray(clarifications) || clarifications.some(id => !round.record.notes.some(note => note.id === id))) fail('待澄清意见不属于该轮');
    return this.write(body.taskId, body.baseRevision, data => data.acknowledgements.push({ id: randomUUID(), recordRevision: body.recordRevision, agent, text: message, received: round.record.notes.map(note => note.id), clarifications, at: new Date().toISOString() }));
  }
  async check(body) {
    const task = await this.tasks.read(body.taskId);
    const coverage = body.coverage ?? [], keptNotes = body.keptNotes ?? [];
    if (!Array.isArray(coverage) || !coverage.length || coverage.length > 100 || !Array.isArray(keptNotes) || keptNotes.length > 300) fail('请记录实际检查范围');
    for (const item of coverage) {
      if (!Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) || item.startMs < 0 || item.endMs < item.startMs || !task.media.durationMs || item.endMs > task.media.durationMs || !['checked', 'issue', 'unverified'].includes(item.result)) fail('检查范围或结果无效');
      if (!Array.isArray(item.aspects) || !item.aspects.length || item.aspects.some(value => !['visual', 'audio', 'subtitle', 'pace'].includes(value))) fail('请注明检查的画面、声音、字幕或节奏');
      if (!text(item.detail)) fail('请描述实际观察或未核实原因');
    }
    for (const item of keptNotes) {
      const source = await this.record(item.taskId, item.recordRevision);
      if ((source.task.version?.workId ?? source.task.id) !== (task.version?.workId ?? task.id) || !source.record?.notes.some(note => note.id === item.noteId && note.kind === 'keep') || !['checked', 'issue', 'unverified'].includes(item.result) || !text(item.detail)) fail('保留项核对必须指向同一作品的原意见并写明结果');
    }
    return this.write(body.taskId, body.baseRevision, data => data.checks.push({ id: randomUUID(), origin: 'agent', userApproved: false, coverage, keptNotes, findings: text(body.findings ?? ''), notVerified: text(body.notVerified ?? ''), at: new Date().toISOString() }));
  }
  async bundle(taskId) {
    const current = await this.record(taskId), progress = await this.read(taskId);
    const statuses = Object.fromEntries((current.record?.notes ?? []).map(note => {
      const events = progress.events.filter(event => event.noteId === note.id);
      const valid = events.filter(event => event.noteRevision === noteRevision(note));
      return [note.id, { status: valid.at(-1)?.status ?? (note.kind === 'discuss' ? 'clarify' : 'pending'), latest: valid.at(-1) ?? null, stale: events.length > 0 && !valid.length, history: events }];
    }));
    return { task: this.tasks.headers.get(taskId), record: current.record, recordRevision: current.revision, progress, statuses };
  }
}
