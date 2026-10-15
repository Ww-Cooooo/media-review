import { useCallback, useEffect, useState } from 'react';
import { request, type ReviewTask } from './api';
import type { ReviewRecord } from './review';
import type { TranscriptCue } from '../components/TranscriptPanel';

export const STATUS_LABEL = { pending: '待处理', clarify: '待澄清', changed: '已修改待复核', confirmed: '用户确认' };
export type RepairState = keyof typeof STATUS_LABEL;
export interface RepairEvent { id: string; noteId: string; noteRevision: string; status: RepairState; text: string; targetTaskId: string | null; targetMs: number | null; actor: string; at: string }
export interface NoteStatus { status: RepairState; latest: RepairEvent | null; stale: boolean; history: RepairEvent[] }
export interface ProgressData { revision: string; events: RepairEvent[]; acknowledgements: { id: string; agent: string; recordRevision: string; received: string[]; clarifications: string[]; text: string; at: string }[]; checks: { id: string; coverage: { startMs: number; endMs: number; aspects: string[]; result: string; detail: string }[]; findings: string; notVerified: string; keptNotes: { noteId: string; result: string; detail: string }[]; at: string }[] }
export interface ProgressBundle { task: ReviewTask; record: ReviewRecord | null; recordRevision: string | null; progress: ProgressData; statuses: Record<string, NoteStatus>; unavailable?: boolean; message?: string }
export const loadProgress = (taskId: string) => request<ProgressBundle>('/api/progress/load', { taskId });
export const loadVersions = (taskId: string) => request<{ versions: ProgressBundle[] }>('/api/tasks/versions', { taskId });
export const updateProgress = (bundle: ProgressBundle, noteId: string, status: RepairState, text: string, targetTaskId: string | null = null, targetMs: number | null = null) => request('/api/progress/update', { taskId: bundle.task.id, recordRevision: bundle.recordRevision, baseRevision: bundle.progress.revision, noteId, status, text, targetTaskId, targetMs, actor: 'user' });
export interface HandoffRound { taskId: string; revision: string; sourceLabel: string; title: string; version: ReviewTask['version']; recordPath: string }
export const createHandoffRound = (taskId: string, revision: string) => request<HandoffRound>('/api/handoff/create', { taskId, revision });
export interface ImportedTranscript { name: string; cues: TranscriptCue[]; at: string }
export const loadImportedTranscript = (taskId: string) => request<{ transcript: ImportedTranscript | null }>('/api/transcript/load', { taskId });
export const saveImportedTranscript = (taskId: string, name: string, cues: TranscriptCue[]) => request<{ transcript: ImportedTranscript }>('/api/transcript/save', { taskId, name, cues });
export const organizeTasks = (taskIds: string[], action: 'archive' | 'restore' | 'rename' | 'opened', title?: string) => request<{ results: { id: string; ok: boolean; message?: string; task?: ReviewTask }[] }>('/api/tasks/organize', { taskIds, action, title });

export function useReviewProgress(taskId: string | undefined, online: boolean, recordRevision: string | null) {
  const [bundle, setBundle] = useState<ProgressBundle | null>(null), [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!taskId || !online) return;
    const result = await loadProgress(taskId); setBundle(result); setError('');
  }, [taskId, online]);
  useEffect(() => {
    setBundle(null); setError('');
    if (!taskId || !online) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try { const data = await loadProgress(taskId); if (!stopped) { setBundle(data); setError(''); } }
      catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : '返修进度未能读取'); }
      if (!stopped) timer = setTimeout(run, document.hidden ? 15000 : 6000);
    };
    void run(); return () => { stopped = true; clearTimeout(timer); };
  }, [taskId, online, recordRevision]);
  return { bundle: bundle?.task.id === taskId ? bundle : null, error, refresh };
}
