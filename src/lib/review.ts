export const REVIEW_FORMAT = 'ai-carry-media-review/v1' as const;
export const REFERENCE_FORMAT = 'ai-carry-media-review/v2' as const;
export const REGIONS_FORMAT = 'ai-carry-media-review/v3' as const;
export const FLOW_FORMAT = 'ai-carry-media-review/v4' as const;
export const COMPLETE_FORMAT = 'ai-carry-media-review/v5' as const;

export type ReviewKind = 'modify' | 'keep' | 'discuss';
export type ReviewMode = 'point' | 'range';
export type ReviewTopic = 'visual' | 'subtitle' | 'audio' | 'pace' | 'content' | 'other';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameRegion { id: number; rect: Rect; text?: string }
// Older notes and recovery drafts retain their original single-rectangle data.
export function regionsOf(value: { regions?: FrameRegion[]; rect?: Rect | null }): FrameRegion[] {
  return value.regions ?? (value.rect ? [{ id: 1, rect: value.rect }] : []);
}

export interface MediaIdentity {
  name: string;
  size: number;
  type: string;
  durationMs: number;
  fingerprint: string;
}

export interface FrameReference {
  frameMs: number;
  fileName: string;
  width: number;
  height: number;
}

export interface ReviewNote {
  id: string;
  kind: ReviewKind;
  startMs: number | null;
  scope?: 'whole';
  regionSerial?: number;
  endMs: number | null;
  text: string;
  rect?: Rect | null;
  regions?: FrameRegion[];
  topic?: ReviewTopic | null;
  reference?: FrameReference | null;
}

export interface ReviewRecord {
  format: typeof REVIEW_FORMAT | typeof REFERENCE_FORMAT | typeof REGIONS_FORMAT | typeof FLOW_FORMAT | typeof COMPLETE_FORMAT;
  media: MediaIdentity;
  notes: ReviewNote[];
  completion?: { outcome: 'no-changes' | 'with-notes'; completedAt: string } | null;
}

export const KIND_LABEL: Record<ReviewKind, string> = {
  modify: '修改',
  keep: '保留',
  discuss: '待讨论',
};

export const TOPIC_LABEL: Record<ReviewTopic, string> = {
  visual: '画面／动效',
  subtitle: '字幕／文字',
  audio: '声音',
  pace: '节奏／时长',
  content: '内容／证据',
  other: '其他',
};

export function formatTime(ms: number, showMs = true): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const tail = showMs ? `.${String(safe % 1000).padStart(3, '0')}` : '';
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${tail}`;
}

export function parseTime(value: string): number | null {
  const text = value.trim();
  const match = text.match(/^(?:(\d{1,4}):)?(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2]);
  if (seconds > 59) return null;
  const millis = Number((match[3] ?? '').padEnd(3, '0'));
  return minutes * 60_000 + seconds * 1000 + millis;
}

export function clampMs(value: number, durationMs: number): number {
  return Math.min(Math.max(0, Math.round(value)), Math.max(0, durationMs));
}

export function sortedNotes(notes: ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => (a.startMs ?? -1) - (b.startMs ?? -1) || a.id.localeCompare(b.id));
}

export async function fingerprintFile(file: File): Promise<string> {
  const sampleLength = 256 * 1024;
  const first = new Uint8Array(await file.slice(0, sampleLength).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(0, file.size - sampleLength)).arrayBuffer());
  const combined = new Uint8Array(8 + first.length + last.length);
  new DataView(combined.buffer).setBigUint64(0, BigInt(file.size), false);
  combined.set(first, 8);
  combined.set(last, 8 + first.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
