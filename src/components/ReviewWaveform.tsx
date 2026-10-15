import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Button } from 'antd';
import { WavePlot, visibleRms } from './WavePlot';
import { formatTime, KIND_LABEL, type ReviewNote } from '../lib/review';

interface Props {
  peaks: number[]; durationMs: number; currentMs: number; viewStartMs: number; viewEndMs: number;
  selection: { start: number; end: number } | null; pendingStart?: number | null; selecting: boolean; disabled: boolean; large?: boolean; contrast: boolean;
  notes: ReviewNote[]; onSeek: (ms: number) => void; onNote: (note: ReviewNote) => void;
  onRangeChange: (start: number, end: number) => void; onRangeDone: (start: number, end: number) => void;
  onRangeCancel?: () => void;
}
export function ReviewWaveform({ peaks, currentMs, durationMs, viewStartMs, viewEndMs, selection, pendingStart = null, selecting, disabled, large, contrast, notes, onSeek, onNote, onRangeChange, onRangeDone, onRangeCancel }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(320);
  const [hover, setHover] = useState<{ time: number; rms: number } | null>(null);
  const drag = useRef<{ pointer: number; start: number; end: number; handle: string } | null>(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const fit = () => setBarCount(Math.max(1, Math.min(480, Math.floor(node.clientWidth / 3.8))));
    const observer = new ResizeObserver(fit); observer.observe(node); fit();
    return () => observer.disconnect();
  }, []);
  const bars = useMemo(() => visibleRms(peaks, durationMs, viewStartMs, viewEndMs, barCount), [peaks, durationMs, viewStartMs, viewEndMs, barCount]);
  const span = Math.max(1, viewEndMs - viewStartMs);
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms - viewStartMs) / span * 100));
  const at = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.round(viewStartMs + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * span);
  };
  function interval(next: number) {
    const d = drag.current!;
    return d.handle === 'start' ? [Math.min(next, d.end - 1), d.end] : d.handle === 'end' ? [d.start, Math.max(next, d.start + 1)] : [Math.min(next, d.start), Math.max(next, d.start)];
  }
  return <div className={`waveform ${large ? 'large-wave' : ''} ${selecting ? 'is-selecting' : ''}`} ref={element}
    role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label="共同媒体时间轴"
    aria-valuemin={viewStartMs} aria-valuemax={viewEndMs} aria-valuenow={Math.max(viewStartMs, Math.min(currentMs, viewEndMs))} aria-valuetext={formatTime(currentMs)}
    onKeyDown={event => {
      if (disabled || event.target !== event.currentTarget) return;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); onSeek(event.key === 'Home' ? viewStartMs : event.key === 'End' ? viewEndMs : currentMs + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 100));
      }
      if (event.key === 'Escape') { drag.current = null; onRangeCancel?.(); }
    }}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      element.current?.focus({ preventScroll: true });
      if (!selecting) { onSeek(at(event)); return; }
      const handle = (event.target as HTMLElement).dataset.handle ?? 'range';
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, start: handle !== 'range' && selection ? selection.start : at(event), end: selection?.end ?? at(event), handle };
    }}
    onPointerMove={event => {
      const next = at(event);
      setHover({ time: next, rms: bars[Math.min(bars.length - 1, Math.max(0, Math.floor((next - viewStartMs) / span * bars.length)))] ?? 0 });
      if (drag.current?.pointer === event.pointerId && !disabled) {
        const [start, end] = interval(next); if (end > start) onRangeChange(start, end);
      }
    }}
    onPointerUp={event => {
      if (!drag.current || drag.current.pointer !== event.pointerId) return;
      const [start, end] = interval(at(event)); drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!disabled && end > start) { onRangeChange(start, end); onRangeDone(start, end); }
    }}
    onPointerCancel={() => { drag.current = null; onRangeCancel?.(); }} onPointerLeave={() => setHover(null)}>
    <div className="wave-center" /><WavePlot values={bars} contrast={contrast} />
    {selection && selection.end > viewStartMs && selection.start < viewEndMs && <div className="range-shade" style={{ left: `${pct(selection.start)}%`, width: `${pct(selection.end) - pct(selection.start)}%` }}>
      {selecting && <><span className="range-grip start" data-handle="start" /><span className="range-grip end" data-handle="end" /></>}
    </div>}
    {pendingStart !== null && pendingStart >= viewStartMs && pendingStart <= viewEndMs && <div className="range-start-marker" style={{ left: `${pct(pendingStart)}%` }}><span>起点 {formatTime(pendingStart)}</span></div>}
    {currentMs >= viewStartMs && currentMs <= viewEndMs && <div className="playhead" style={{ left: `${pct(currentMs)}%` }} />}
    {notes.filter(note => note.startMs !== null && note.startMs >= viewStartMs && note.startMs <= viewEndMs).map(note => <Button key={note.id} type="text" disabled={disabled} className={`wave-note kind-${note.kind}`}
      aria-label={`${KIND_LABEL[note.kind]}意见：${formatTime(note.startMs!)}`} title={note.text} style={{ left: `${pct(note.startMs!)}%` }} onClick={event => { event.stopPropagation(); onNote(note); }}>●</Button>)}
    {hover && <span className="wave-hover" style={{ left: `${Math.min(78, pct(hover.time))}%` }}>{formatTime(hover.time)} · RMS {hover.rms.toFixed(3)}</span>}
  </div>;
}
