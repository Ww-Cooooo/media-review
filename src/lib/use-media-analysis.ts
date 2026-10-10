import { useEffect, useRef, useState } from 'react';
import { analyzeMedia, type AnalysisProgress } from './api';
import { parseTranscriptText, type TranscriptCue } from '../components/TranscriptPanel';

export function useMediaAnalysis(file: File | null, durationMs: number) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const [cues, setCues] = useState<TranscriptCue[]>([]);
  const [waveError, setWaveError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('unavailable');
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progress, setProgress] = useState<AnalysisProgress>({ phase: 'preparing', percent: null });
  const [attempt, setAttempt] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);
  useEffect(() => { setPeaks([]); setCues([]); setWaveError(''); setError(''); }, [file]);
  useEffect(() => {
    if (!file || !durationMs) return;
    const controller = new AbortController();
    abort.current = controller; started.current = Date.now();
    setRunning(true); setStatus('loading'); setError(''); setWaveError(''); setElapsedMs(0);
    setProgress({ phase: 'preparing', percent: null });
    void analyzeMedia(file, durationMs, event => {
      if (controller.signal.aborted) return;
      if (event.kind === 'progress') setProgress({ phase: event.phase, percent: event.percent });
      else if (event.kind === 'wave') setPeaks(event.peaks);
      else if (event.kind === 'wave-error') setWaveError(event.message);
      else if (event.kind === 'transcript') {
        try { setCues(parseTranscriptText(event.srt, 'srt')); setStatus('ready'); }
        catch { setStatus('unavailable'); setError('识别没有返回可用时间码，仍可按时间标记。'); }
      } else if (event.kind === 'transcript-error' || event.kind === 'error') { setStatus('unavailable'); setError(event.message); }
      else if (event.kind === 'cleanup-warning') setWaveError(event.message);
    }, ratio => {
      if (!controller.signal.aborted) setProgress({ phase: 'uploading', percent: Math.floor(ratio * 100) });
    }, controller.signal).catch(cause => {
      if (!controller.signal.aborted) { setStatus('unavailable'); setError(cause instanceof Error ? cause.message : '分析中断，可重试。'); }
    }).finally(() => {
      if (!controller.signal.aborted) { setRunning(false); setElapsedMs(Date.now() - started.current); }
    });
    return () => controller.abort();
  }, [file, durationMs, attempt]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - started.current), 1000);
    return () => clearInterval(timer);
  }, [running]);
  function stop() {
    abort.current?.abort(); setRunning(false); setStatus('unavailable'); setError('已停止识别，仍可播放和写意见。');
  }
  return { peaks, cues, waveError, error, status, running, elapsedMs, progress, stop, retry: () => { if (!running) setAttempt(value => value + 1); } };
}
