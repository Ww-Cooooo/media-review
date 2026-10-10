import { parseTime, type FrameReference, type Rect, type ReviewKind, type ReviewNote, type ReviewTopic } from './review.ts';

export type TargetMode = 'point' | 'range' | 'frame';
export interface ReviewDraft {
  id: string | null;
  mode: TargetMode | null;
  kind: ReviewKind;
  topic: ReviewTopic | null;
  startText: string;
  endText: string;
  text: string;
  rect: Rect | null;
  frameMs: number | null;
  reference: FrameReference | null;
  snapshot: string | null;
}

export function emptyDraft(): ReviewDraft {
  return { id: null, mode: null, kind: 'modify', topic: null, startText: '', endText: '', text: '', rect: null, frameMs: null, reference: null, snapshot: null };
}

export function hasDraftWork(draft: ReviewDraft): boolean {
  return !!(draft.text.length || draft.mode || draft.rect || draft.reference || draft.kind !== 'modify' || draft.topic);
}

export function draftSignature(draft: ReviewDraft): string {
  const { snapshot: _snapshot, ...data } = draft;
  return JSON.stringify(data);
}

export function draftProblem(draft: ReviewDraft, durationMs: number, selecting = false): string {
  if (selecting) return '当前选取还没有完成，请完成选取或先取消。';
  if (!draft.text.trim()) return '先写下这条意见。';
  if (!draft.mode) return '请给这条意见选一个时间点、时间段或画面位置。';
  const start = parseTime(draft.startText);
  if (start === null || start > durationMs) return '开始时间无效或超出媒体长度。';
  if (draft.mode === 'range') {
    const end = parseTime(draft.endText);
    if (end === null || end <= start || end > durationMs) return '请完成时间段：结束须晚于开始，且不超出媒体长度。';
  }
  if (draft.mode === 'frame' && (!draft.rect || draft.frameMs === null || (!draft.snapshot && !draft.reference))) return '请完成画面框选并取得参考画面。';
  if (draft.text.length > 2000) return '单条意见最多2000字，请拆成两条。';
  return '';
}

export function draftToNote(draft: ReviewDraft, durationMs: number): ReviewNote {
  const problem = draftProblem(draft, durationMs);
  if (problem) throw new Error(problem);
  return {
    id: draft.id ?? crypto.randomUUID(), kind: draft.kind, topic: draft.topic,
    startMs: parseTime(draft.startText)!, endMs: draft.mode === 'range' ? parseTime(draft.endText)! : null,
    text: draft.text.trim(), rect: draft.rect, reference: draft.reference,
  };
}
