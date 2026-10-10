import type { ReviewRecord } from './review';
import { verifySaveReceipt, type ReviewSaveReceipt } from './review-handoff.ts';
import type { ReviewWorkspace } from './review-workspace';

declare global {
  interface Window {
    __REVIEW_SESSION_TOKEN__?: string;
  }
}

async function request<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const token = window.__REVIEW_SESSION_TOKEN__;
  if (!token) throw new Error('本机审片服务未连接。请从正式入口重新打开。');
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Review-Token': token,
    },
    body: JSON.stringify(payload),
    signal,
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
    throw new Error(message);
  }
  return result as T;
}

export function loadRecord(fingerprint: string): Promise<{ found: boolean; record: ReviewRecord | null; recordPath: string | null }> {
  return request('/api/reviews/load', { fingerprint });
}

export async function saveRecord(record: ReviewRecord): Promise<ReviewSaveReceipt> {
  try {
    const result = await request<ReviewSaveReceipt>('/api/reviews/save', record, AbortSignal.timeout(15_000));
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
export interface WorkflowMedia { id: string; name: string; size: number; type: string; mtimeMs: number; fingerprint: string }
export const currentWorkflowMedia = () => request<{ media: WorkflowMedia | null }>('/api/workflow/current', {}, AbortSignal.timeout(5000));
export const latestWorkspace = () => request<{ workspace: ReviewWorkspace | null }>('/api/workspace/latest', {}, AbortSignal.timeout(5000));
export const loadWorkspace = (fingerprint: string) => request<{ workspace: ReviewWorkspace | null; at: number }>('/api/workspace/load', { fingerprint }, AbortSignal.timeout(5000));
export const saveWorkspace = (workspace: ReviewWorkspace) => request<{ saved: boolean }>('/api/workspace/save', workspace, AbortSignal.timeout(10_000));
export async function workflowFile(media: WorkflowMedia): Promise<File> {
  const token = window.__REVIEW_SESSION_TOKEN__;
  if (!token) throw new Error('本机服务未连接');
  const response = await fetch('/api/workflow/media', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify({ id: media.id }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Agent交接的媒体未能带入，请重试或手动选择；原意见不变');
  const blob = await response.blob();
  if (blob.size !== media.size) throw new Error('媒体带入不完整，请重试');
  const file = new File([blob], media.name, { type: media.type, lastModified: media.mtimeMs });
  return file;
}

export type AnalysisPhase = 'preparing' | 'uploading' | 'decoding' | 'waveform' | 'loading-model' | 'transcribing' | 'finalizing';
export interface AnalysisProgress { phase: AnalysisPhase; percent: number | null }

export type MediaAnalysisEvent =
  | { kind: 'progress'; phase: Exclude<AnalysisPhase, 'preparing' | 'uploading'>; percent: number | null }
  | { kind: 'wave'; metric?: 'rms'; peaks: number[] }
  | { kind: 'transcript'; srt: string }
  | { kind: 'wave-error' | 'transcript-error' | 'cleanup-warning' | 'error'; message: string };

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
  try {
    ({ id } = await request<{ id: string }>('/api/media/start', { size: file.size, durationMs }, AbortSignal.timeout(15_000)));
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const chunkSize = 2 * 1024 * 1024;
    for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index += 1) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
      await request('/api/media/append', { id, index, data: toBase64(bytes) }, signal);
      onUploadProgress(Math.min(1, (offset + bytes.length) / file.size));
    }
    const token = window.__REVIEW_SESSION_TOKEN__;
    if (!token) throw new Error('本机审片服务未连接。请从正式入口重新打开。');
    const response = await fetch('/api/media/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-Review-Token': token },
      body: JSON.stringify({ id }),
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
      try { await request('/api/media/cancel', { id }, AbortSignal.timeout(15_000)); } catch { /* Session expiry is reported by the caller. */ }
    }
  }
}
