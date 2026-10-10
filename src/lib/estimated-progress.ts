import { useEffect, useRef, useState } from 'react';
import type { AnalysisProgress } from './api';

export function estimateProgress(real: number, elapsedSinceReport: number): number {
  const start = Math.max(0, Math.min(99, real));
  const ceiling = Math.min(99, start + Math.max(1, (100 - start) * .075));
  return start + (ceiling - start) * (1 - Math.exp(-Math.max(0, elapsedSinceReport) / 24_000));
}

export function useEstimatedProgress(progress: AnalysisProgress, running: boolean, mediaKey: string) {
  const [shown, setShown] = useState<{ mediaKey: string; phase: AnalysisProgress['phase']; display: number | null; silentMs: number }>({ mediaKey, phase: progress.phase, display: null, silentMs: 0 });
  const sample = useRef({ progress, at: Date.now(), display: 0, mediaKey });
  useEffect(() => {
    const previous = sample.current;
    const samePhase = previous.mediaKey === mediaKey && previous.progress.phase === progress.phase;
    sample.current = { progress, at: Date.now(), display: samePhase ? Math.max(previous.display, Math.min(99, progress.percent ?? 0)) : Math.min(99, progress.percent ?? 0), mediaKey };
    setShown({ mediaKey, phase: progress.phase, display: progress.percent === null ? null : sample.current.display, silentMs: 0 });
  }, [progress, mediaKey]);
  useEffect(() => {
    if (!running) return;
    const update = () => {
      const value = sample.current;
      const elapsed = Date.now() - value.at;
      if (value.progress.percent !== null) value.display = Math.max(value.display, estimateProgress(value.progress.percent, elapsed));
      setShown({ mediaKey: value.mediaKey, phase: value.progress.phase, display: value.progress.percent === null ? null : value.display, silentMs: elapsed });
    };
    const timer = window.setInterval(update, 350);
    return () => clearInterval(timer);
  }, [running, mediaKey]);
  // 新阶段首次渲染就屏蔽旧阶段估算，不等待 effect 后才更正。
  const matches = shown.mediaKey === mediaKey && shown.phase === progress.phase;
  const real = progress.percent === null ? null : Math.max(0, Math.min(99, progress.percent));
  return { display: real === null ? null : Math.max(real, matches ? shown.display ?? real : real), silentMs: matches ? shown.silentMs : 0 };
}
