import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MAX_RECORD_BYTES, RecordValidationError, validateFingerprint, validateRecord } from './review-record.mjs';
import { MAX_WORKSPACE_BYTES, validateWorkspace } from './review-workflow.mjs';
import { readJson } from './runtime.mjs';

const portable = value => value.replaceAll('\\', '/');
async function checkedDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new RecordValidationError('校对资料目录不是普通文件夹，原内容保留');
}
async function entries(directory) {
  try { await checkedDirectory(directory); return await fs.readdir(directory, { withFileTypes: true }); }
  catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
}
const regionsOf = value => value.regions ?? (value.rect ? [{ id: 1, rect: value.rect }] : []);
const hasWork = draft => !!(draft.text.length || draft.mode || regionsOf(draft).length || draft.reference || draft.kind !== 'modify' || draft.topic);
const timeText = ms => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;

export async function listReviewHistory(reviews) {
  const items = new Map(), warnings = [];
  const get = fingerprint => {
    if (!items.has(fingerprint)) items.set(fingerprint, { fingerprint, name: null, type: '', durationMs: null, updatedAt: '', savedNotes: null, hasDraft: false, recordPath: null, referencesDirectory: null, workspacePath: null, errors: [] });
    return items.get(fingerprint);
  };
  const update = (item, media, stat) => {
    item.name ??= media.name; item.type ||= media.type; item.durationMs ??= media.durationMs;
    const date = new Date(stat.mtimeMs).toISOString(); if (date > item.updatedAt) item.updatedAt = date;
  };
  for (const entry of await entries(reviews)) {
    const match = /^([a-f0-9]{64})\.review\.json$/u.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) { warnings.push('有非普通意见文件未读取，原内容保留'); continue; }
    const item = get(match[1]), file = path.join(reviews, entry.name);
    item.recordPath = portable(file);
    try {
      const record = validateRecord(await readJson(file, MAX_RECORD_BYTES), match[1]);
      update(item, record.media, await fs.stat(file)); item.savedNotes = record.notes.length;
      if (record.notes.some(note => note.reference)) item.referencesDirectory = portable(path.join(reviews, 'references', match[1]));
    } catch { item.errors.push('正式意见无法读取，原文件保留'); }
  }
  let drafts = [];
  try { drafts = await entries(path.join(reviews, 'drafts')); }
  catch { warnings.push('恢复资料目录无法读取，原内容保留'); }
  for (const entry of drafts) {
    const match = /^([a-f0-9]{64})\.workspace\.json$/u.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) { warnings.push('有非普通恢复文件未读取，原内容保留'); continue; }
    const item = get(match[1]), file = path.join(reviews, 'drafts', entry.name);
    item.workspacePath = portable(file);
    try {
      const workspace = validateWorkspace(await readJson(file, MAX_WORKSPACE_BYTES));
      if (workspace.media.fingerprint !== match[1]) throw new Error('恢复身份不符');
      update(item, workspace.media, await fs.stat(file));
      if (item.name !== workspace.media.name || item.type !== workspace.media.type || item.durationMs !== workspace.media.durationMs) throw new Error('记录与恢复身份不一致');
      const selected = workspace.notes.find(note => note.id === workspace.view.id);
      const edited = workspace.view.kind === 'edit' && selected && (() => {
        const draft = workspace.editDraft;
        return draft.text !== selected.text || draft.kind !== selected.kind || draft.topic !== (selected.topic ?? null) ||
          draft.startText !== (selected.scope === 'whole' ? '' : timeText(selected.startMs)) || (draft.mode === 'whole') !== (selected.scope === 'whole') || draft.endText !== (selected.endMs === null ? '' : timeText(selected.endMs)) || draft.frameMs !== (selected.reference?.frameMs ?? null) ||
          JSON.stringify(regionsOf(draft)) !== JSON.stringify(regionsOf(selected)) || JSON.stringify(draft.reference) !== JSON.stringify(selected.reference ?? null);
      })();
      item.hasDraft = workspace.dirty || hasWork(workspace.newDraft) || workspace.parked.some(hasWork) || !!edited;
    } catch { item.errors.push('恢复副本无法读取，原文件保留'); }
  }
  return { directory: portable(reviews), items: [...items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.fingerprint.localeCompare(b.fingerprint)), warnings: [...new Set(warnings)] };
}

export function openSystemLocation(directory, selectedFile = null) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const select = process.platform === 'win32' && selectedFile && selectedFile.length < 260;
    const args = select ? [`/select,${selectedFile}`] : [directory];
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new RecordValidationError('未能请求打开文件夹，请复制保存位置到文件资源管理器')));
    child.once('spawn', () => { child.unref(); resolve({ selected: !!select }); });
  });
}

export async function openReviewLocation(reviews, body, opener = openSystemLocation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RecordValidationError('打开位置请求无效');
  const expected = body.scope === 'all' ? 'scope' : 'fingerprint,scope';
  if (Object.keys(body).sort().join(',') !== expected || !['all', 'record', 'draft', 'references'].includes(body.scope)) throw new RecordValidationError('只能打开校对资料的固定位置');
  await checkedDirectory(reviews);
  let directory = reviews, selectedFile = null;
  if (body.scope !== 'all') {
    const fingerprint = validateFingerprint(body.fingerprint);
    if (body.scope === 'references') {
      await checkedDirectory(path.join(reviews, 'references'));
      directory = path.join(reviews, 'references', fingerprint);
    } else {
      directory = body.scope === 'draft' ? path.join(reviews, 'drafts') : reviews;
      await checkedDirectory(directory);
      selectedFile = path.join(directory, `${fingerprint}.${body.scope === 'draft' ? 'workspace' : 'review'}.json`);
      const stat = await fs.lstat(selectedFile).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || await fs.realpath(selectedFile) !== selectedFile) throw new RecordValidationError('这份校对资料已移动或不是普通文件，未打开其他位置');
    }
  }
  await checkedDirectory(directory);
  const opened = await opener(directory, selectedFile);
  return { requested: true, directory: portable(directory), selectedFile: selectedFile && opened?.selected !== false ? path.basename(selectedFile) : null };
}
