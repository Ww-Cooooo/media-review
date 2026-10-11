import type { ReviewRecord } from './review';
import { verifySaveReceipt, type ReviewSaveReceipt } from './review-handoff.ts';
import type { ReviewWorkspace } from './review-workspace';

declare global {
  interface Window {
    __REVIEW_SESSION_TOKEN__?: string;
  }
}

export const REVIEW_CLIENT_ID = crypto.randomUUID();
export interface ReviewContext { taskId: string | null; clientId: string; leaseId: string | null }
let activeContext: ReviewContext = { taskId: null, clientId: REVIEW_CLIENT_ID, leaseId: null };
export const reviewContext = () => ({ ...activeContext });
export const setReviewContext = (taskId: string | null, leaseId: string | null) => { activeContext = { taskId, clientId: REVIEW_CLIENT_ID, leaseId }; };
export class ReviewAPIError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

export async function request<T>(path: string, payload: unknown, signal?: AbortSignal, context: ReviewContext = reviewContext()): Promise<T> {
  const token = window.__REVIEW_SESSION_TOKEN__;
  if (!token) throw new Error('本机审片服务未连接。请从正式入口重新打开。');
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Review-Token': token,
    },
    body: JSON.stringify({ ...(payload as object), context }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(`本机服务返回了无法读取的结果（${response.status}）。`);
  }
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'message' in result
      ? String(result.message)
      : `本机服务未完成操作（${response.status}）。`;
    throw new ReviewAPIError(message, typeof result === 'object' && result !== null && 'error' in result ? String(result.error) : 'request_failed');
  }
  return result as T;
}

export function loadRecord(fingerprint: string, context?: ReviewContext): Promise<{ found: boolean; record: ReviewRecord | null; recordPath: string | null; revision: string | null }> {
  return request('/api/reviews/load', { fingerprint }, undefined, context);
}

export async function saveRecord(record: ReviewRecord, baseRevision: string | null, context?: ReviewContext): Promise<ReviewSaveReceipt> {
  try {
    const result = await request<ReviewSaveReceipt>('/api/reviews/save', { record, baseRevision }, AbortSignal.timeout(15_000), context);
    if (!/^[a-f0-9]{64}$/u.test(result.revision ?? '')) throw new Error('保存回执缺少意见版本，未清空本页输入，请核对记录');
    return verifySaveReceipt(result, record);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('等待本机保存确认超时。意见仍在页面，请重试核对。');
    }
    throw error;
  }
}

export function saveReference(fingerprint: string, data: string): Promise<{ fileName: string; width: number; height: number }> {
  return request('/api/references/save', { fingerprint, data }, AbortSignal.timeout(15_000));
}

export function loadReference(fingerprint: string, fileName: string): Promise<{ data: string }> {
  return request('/api/references/load', { fingerprint, fileName }, AbortSignal.timeout(10_000));
}

export interface ReviewHistoryItem {
  fingerprint: string; name: string | null; type: string; durationMs: number | null; updatedAt: string;
  savedNotes: number | null; hasDraft: boolean; recordPath: string | null; referencesDirectory: string | null; workspacePath: string | null; errors: string[];
}
export interface ReviewHistory { directory: string; items: ReviewHistoryItem[]; warnings: string[] }
export const loadReviewHistory = () => request<ReviewHistory>('/api/history/list', {}, AbortSignal.timeout(15_000));
export const openReviewLocation = (scope: 'all' | 'record' | 'draft' | 'references', fingerprint?: string) =>
  request<{ requested: boolean; directory: string; selectedFile: string | null }>('/api/history/open-location', scope === 'all' ? { scope } : { scope, fingerprint }, AbortSignal.timeout(5000));

export const exportRecord = (fingerprint: string) => request<{ exported: boolean; directory: string }>('/api/reviews/export', { fingerprint }, AbortSignal.timeout(30_000));
export interface ReviewTask {
  id: string; title: string; label: string; status: 'waiting' | 'closed' | 'legacy'; createdAt: string; updatedAt: string;
  manual: boolean; legacy: boolean; contentHash?: string | null; jobStates?: Record<string, string>; media: Omit<WorkflowMedia, 'id'> & { durationMs?: number }; jobs: Record<string, string>;
}
export interface ServiceSummary { windows: number; unsavedWindows: number; pendingTasks: number; uploads: number; analysis: { running: number; queued: number; limit: number } }
export interface TaskList { items: ReviewTask[]; total: number; active: number; warnings: string[]; service: ServiceSummary }
export interface AnalysisJob { id: string; kind: string; state: 'queued' | 'waiting-resources' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'expired'; message: string; partialReady: boolean; progress: { phase: Exclude<AnalysisPhase, 'preparing' | 'uploading'>; percent: number | null } | null; result?: { events: MediaAnalysisEvent[] }; owners: string[] }
export const listTasks = (offset = 0, closed = false) => request<TaskList>('/api/tasks/list', { offset, limit: 8, closed }, AbortSignal.timeout(8000));
export const getTask = (taskId: string) => request<{ task: ReviewTask }>('/api/tasks/get', { taskId });
export const registerManualTask = (media: ReviewRecord['media'], requestId: string, mtimeMs = 0, newTask = false) => request<{ task: ReviewTask }>('/api/tasks/manual', { media, requestId, mtimeMs, newTask });
export const claimEditing = (task: ReviewTask, takeover = false) => request<{ editing: boolean; leaseId: string | null }>('/api/clients/claim', { clientId: REVIEW_CLIENT_ID, taskId: task.id, fingerprint: task.media.fingerprint, takeover });
export const heartbeat = (taskId: string | null, dirty: boolean) => request<{ connected: boolean; primary: boolean; taskStatus: ReviewTask['status'] | null; editing: boolean; leaseId: string | null }>('/api/clients/heartbeat', { clientId: REVIEW_CLIENT_ID, taskId, dirty, visible: !document.hidden }, AbortSignal.timeout(8000));
export const releaseClient = () => request('/api/clients/release', { clientId: REVIEW_CLIENT_ID });
export const changeTaskStatus = (taskId: string, status: 'waiting' | 'closed', confirmOtherWindows = false) => request<{ task: ReviewTask }>('/api/tasks/status', { taskId, status, confirmOtherWindows });
export const openTaskLocation = (taskId: string) => request<{ requested: boolean; directory: string }>('/api/tasks/open-location', { taskId });
export const serviceSummary = () => request<ServiceSummary>('/api/session/summary', {});
export const closeService = (runtimeId: string, discardUnsaved = false) => request<{ closing: boolean }>('/api/session/close', { runtimeId, confirm: true, discardUnsaved });

export interface WorkflowMedia { id: string; name: string; size: number; type: string; mtimeMs: number; fingerprint: string }
export const currentWorkflowMedia = () => request<{ media: WorkflowMedia | null }>('/api/workflow/current', {}, AbortSignal.timeout(5000));
export const latestWorkspace = () => request<{ workspace: ReviewWorkspace | null }>('/api/workspace/latest', {}, AbortSignal.timeout(5000));
export const loadWorkspace = (fingerprint: string, context?: ReviewContext) => request<{ workspace: ReviewWorkspace | null; at: number }>('/api/workspace/load', { fingerprint }, AbortSignal.timeout(5000), context);
export const archiveWorkspace = (workspace: ReviewWorkspace, context?: ReviewContext) => request<{ archived: boolean }>('/api/workspace/archive', workspace, AbortSignal.timeout(15_000), context);
export const saveWorkspace = (workspace: ReviewWorkspace, context?: ReviewContext) => request<{ saved: boolean }>('/api/workspace/save', workspace, AbortSignal.timeout(10_000), context);
export async function workflowFile(media: WorkflowMedia, readOnly = false, context = reviewContext()): Promise<File> {
  const token = window.__REVIEW_SESSION_TOKEN__;
  if (!token) throw new Error('本机服务未连接');
  const response = await fetch('/api/workflow/media', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify({ id: media.id, readOnly, context }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new ReviewAPIError(result?.message ?? 'Agent交接的媒体未能带入，请重试或手动选择；原意见不变', result?.error ?? 'media_unavailable');
  }
  const blob = await response.blob();
  if (blob.size !== media.size) throw new Error('媒体带入不完整，请重试');
  const file = new File([blob], media.name, { type: media.type, lastModified: media.mtimeMs });
  return file;
}

export type AnalysisPhase = 'preparing' | 'queued' | 'waiting-resources' | 'uploading' | 'decoding' | 'waveform' | 'loading-model' | 'transcribing' | 'finalizing';
export interface AnalysisProgress { phase: AnalysisPhase; percent: number | null }

export type MediaAnalysisEvent =
  | { kind: 'progress'; phase: Exclude<AnalysisPhase, 'preparing' | 'uploading'>; percent: number | null }
  | { kind: 'wave'; metric?: 'rms'; peaks: number[] }
  | { kind: 'transcript'; srt: string }
  | { kind: 'wave-error' | 'transcript-error' | 'cleanup-warning' | 'error'; message: string };

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function analyzeTask(taskId: string, durationMs: number, onEvent: (event: MediaAnalysisEvent) => void, signal: AbortSignal, onJob: (id: string) => void) {
  const context = reviewContext();
  let { job } = await request<{ job: AnalysisJob }>('/api/jobs/enqueue', { taskId, kind: 'media', durationMs }, AbortSignal.timeout(15_000), context);
  onJob(job.id); let partialReceived = false;
  while (true) {
    signal.throwIfAborted();
    if (job.state === 'completed' || job.state === 'running' && job.partialReady && !partialReceived) {
      const response = await request<{ job: AnalysisJob }>('/api/jobs/status', { id: job.id, result: true }, signal, context);
      if (!['running', 'completed'].includes(response.job.state)) throw new Error(response.job.message || '分析结果已中断或缓存已回收，请明确重试');
      const events = response.job.result?.events;
      if (!Array.isArray(events)) throw new Error('分析结果未完整读回，请重试；原意见保留');
      if (response.job.state === 'completed' && (!events.some(event => ['wave', 'wave-error', 'error'].includes(event.kind)) || !events.some(event => ['transcript', 'transcript-error', 'error'].includes(event.kind)))) throw new Error('分析缺少终态结果，未确认完成；原意见保留');
      for (const event of events) onEvent(event);
      partialReceived = true;
      if (response.job.state === 'completed') return;
    } else if (!['queued', 'running', 'waiting-resources'].includes(job.state)) throw new Error(job.message || '分析已中断，请明确重试；原意见保留');
    if (job.state === 'queued' || job.state === 'waiting-resources') onEvent({ kind: 'progress', phase: job.state, percent: null });
    else if (job.progress) onEvent({ kind: 'progress', ...job.progress });
    await pause(document.hidden ? 5000 : 1200, signal);
    ({ job } = await request<{ job: AnalysisJob }>('/api/jobs/status', { id: job.id }, AbortSignal.any([signal, AbortSignal.timeout(8000)]), context));
  }
}
export const cancelTaskAnalysis = (taskId: string, id: string) => request('/api/jobs/cancel', { taskId, id });

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

let analysisTail: Promise<void> = Promise.resolve();

/** 同页换片／重试先等待旧任务取消清理，不能并发挤占本机分析。 */
export async function analyzeMedia(
  file: File, durationMs: number, onEvent: (event: MediaAnalysisEvent) => void,
  onUploadProgress: (ratio: number) => void, signal: AbortSignal,
): Promise<void> {
  const previous = analysisTail;
  let release!: () => void;
  analysisTail = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    await performAnalysis(file, durationMs, onEvent, onUploadProgress, signal);
  } finally { release(); }
}

/** 媒体只传给当前同机服务；开始握手必须拿到ID才能可靠取消。 */
async function performAnalysis(
  file: File,
  durationMs: number,
  onEvent: (event: MediaAnalysisEvent) => void,
  onUploadProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<void> {
  let id: string | null = null;
  let complete = false;
  const context = reviewContext();
  try {
    while (!id) {
      signal.throwIfAborted();
      try { ({ id } = await request<{ id: string }>('/api/media/start', { size: file.size, durationMs }, AbortSignal.timeout(15_000), context)); }
      catch (cause) {
        if (!(cause instanceof ReviewAPIError) || !cause.message.includes('仍在分析')) throw cause;
        onEvent({ kind: 'progress', phase: 'queued', percent: null }); await pause(1500, signal);
      }
    }
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const chunkSize = 2 * 1024 * 1024;
    for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index += 1) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
      await request('/api/media/append', { id, index, data: toBase64(bytes) }, signal, context);
      onUploadProgress(Math.min(1, (offset + bytes.length) / file.size));
    }
    const token = window.__REVIEW_SESSION_TOKEN__;
    if (!token) throw new Error('本机审片服务未连接。请从正式入口重新打开。');
    const response = await fetch('/api/media/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-Review-Token': token },
      body: JSON.stringify({ id, context }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error('本机媒体分析没有启动，请重新打开工具。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let waveFinished = false;
    let transcriptFinished = false;
    const receive = (line: string) => {
      let event: MediaAnalysisEvent;
      try { event = JSON.parse(line) as MediaAnalysisEvent; }
      catch { throw new Error('本机分析结果未能读取，可重试；原媒体和意见不变。'); }
      if (event.kind === 'wave' || event.kind === 'wave-error' || event.kind === 'error') waveFinished = true;
      if (event.kind === 'transcript' || event.kind === 'transcript-error' || event.kind === 'error') transcriptFinished = true;
      onEvent(event);
    };
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) receive(line);
      }
      if (done) break;
    }
    if (pending.trim()) receive(pending);
    if (!waveFinished) onEvent({ kind: 'wave-error', message: '分析已结束但未返回波形，可重试；仍可按时间标记。' });
    if (!transcriptFinished) onEvent({ kind: 'transcript-error', message: '识别已结束但未返回台词，可重试；不会一直等待。' });
    complete = true;
  } finally {
    if (id && !complete) {
      try { await request('/api/media/cancel', { id }, AbortSignal.timeout(15_000), context); } catch { /* Session expiry is reported by the caller. */ }
    }
  }
}
