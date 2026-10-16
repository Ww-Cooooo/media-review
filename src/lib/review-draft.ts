import { formatTime, parseTime, regionsOf, type FrameReference, type FrameRegion, type Rect, type ReviewKind, type ReviewNote, type ReviewTopic } from './review.ts';

export type TargetMode = 'point' | 'range' | 'frame' | 'whole';
export interface ReviewDraft {
  id: string | null;
  mode: TargetMode | null;
  kind: ReviewKind;
  topic: ReviewTopic | null;
  startText: string;
  endText: string;
  text: string;
  rect?: Rect | null;
  regions?: FrameRegion[];
  regionSerial?: number;
  frameMs: number | null;
  reference: FrameReference | null;
  snapshot: string | null;
}

export function emptyDraft(): ReviewDraft {
  return { id: null, mode: null, kind: 'modify', topic: null, startText: '', endText: '', text: '', rect: null, frameMs: null, reference: null, snapshot: null };
}

export function draftMarks(draft: ReviewDraft) {
  const { mode, startText, endText, frameMs, reference, snapshot, regionSerial } = draft;
  return { mode, startText, endText, frameMs, reference, snapshot, regionSerial, rect: null, regions: regionsOf(draft) };
}

// Clearing a range keeps any independently captured frame. Clearing all marks
// leaves the opinion text, type, topic and stable region numbering intact.
export function clearedDraftMarks(draft: ReviewDraft, timeOnly = false): ReturnType<typeof draftMarks> {
  if (timeOnly && draft.frameMs !== null && regionsOf(draft).length) {
    return { ...draftMarks(draft), mode: 'frame', startText: formatTime(draft.frameMs), endText: '' };
  }
  return { mode: null, startText: '', endText: '', frameMs: null, reference: null, snapshot: null, rect: null, regions: [], regionSerial: draft.regionSerial };
}

export function hasDraftWork(draft: ReviewDraft): boolean {
  return !!(draft.text.length || draft.mode || regionsOf(draft).length || draft.reference || draft.kind !== 'modify' || draft.topic);
}

export function draftSignature(draft: ReviewDraft): string {
  const { snapshot: _snapshot, ...data } = draft;
  return JSON.stringify(data);
}

export function draftProblem(draft: ReviewDraft, durationMs: number, selecting = false): string {
  if (selecting) return '当前选取还没有完成，请完成选取或先取消。';
  const blank = missingRegionComment(draft);
  if (blank) return `请填写框 ${blank.id} 的意见，或删除此框。`;
  if (!draft.text.trim() && !regionsOf(draft).some(region => region.text?.trim())) return '先写下这条意见。';
  if (!draft.mode) return '请选择整片意见、时间点、时间段或画面位置。';
  const start = parseTime(draft.startText);
  if (draft.mode !== 'whole' && (start === null || start > durationMs)) return '开始时间无效或超出媒体长度。';
  if (draft.mode === 'range') {
    const end = parseTime(draft.endText);
    if (end === null || end <= start! || end > durationMs) return '请完成时间段：结束须晚于开始，且不超出媒体长度。';
  }
  if (draft.mode === 'frame' && (!regionsOf(draft).length || draft.frameMs === null || (!draft.snapshot && !draft.reference))) return '请完成画面框选并取得参考画面。';
  if (regionsOf(draft).length && draft.frameMs !== null && !draft.snapshot && !draft.reference) return '参考画面尚未取得，请重新框选；时间和文字仍保留。';
  if (draft.text.length > 2000) return '单条意见最多2000字，请拆成两条。';
  if (regionsOf(draft).some(region => (region.text?.length ?? 0) > 2000)) return '每个框的意见最多2000字，请缩短或拆成两条。';
  return '';
}

export function missingRegionComment(draft: ReviewDraft) {
  // Old records may use a shared opinion with no per-region text field. Preserve
  // that meaning. New boxes explicitly start with text: '' and must be filled.
  return regionsOf(draft).find(region => !region.text?.trim() && (region.text !== undefined || !draft.text.trim()));
}

export function draftToNote(draft: ReviewDraft, durationMs: number): ReviewNote {
  const problem = draftProblem(draft, durationMs);
  if (problem) throw new Error(problem);
  return {
    id: draft.id ?? crypto.randomUUID(), kind: draft.kind, topic: draft.topic,
    startMs: draft.mode === 'whole' ? null : parseTime(draft.startText)!, endMs: draft.mode === 'range' ? parseTime(draft.endText)! : null,
    ...(draft.mode === 'whole' ? { scope: 'whole' as const } : {}),
    ...(draft.regionSerial !== undefined ? { regionSerial: draft.regionSerial } : {}),
    text: draft.text.trim() || '见各编号区域说明', regions: regionsOf(draft), reference: draft.reference,
  };
}
