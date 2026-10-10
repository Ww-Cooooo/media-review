import { useEffect, useRef, useState, type ChangeEvent, type SyntheticEvent } from 'react';
import { InputNumber, Switch } from 'antd';
import { MotionButton as Button } from './MotionButton';
import { useReducedMotion } from '../lib/review-motion';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { PauseOutlined, PlayCircleOutlined, UploadOutlined } from '@ant-design/icons';
import { formatTime } from '../lib/review';
import './AudioCompare.css';

type Side = 'current' | 'other';

interface OtherAudio {
  name: string;
  url: string;
  durationMs: number | null;
}

export interface AudioCompareProps {
  sourceUrl: string;
  sourceDurationMs: number;
  currentMs: number;
  onPauseSource: () => void;
  onSeekSource: (timeMs: number) => void;
  sourceName?: string;
  sourcePlaying?: boolean;
}

const EXCERPT_MS = 8_000;

export function AudioCompare({ sourceUrl, sourceDurationMs, currentMs, onPauseSource, onSeekSource, sourceName, sourcePlaying }: AudioCompareProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const otherAudioRef = useRef<HTMLAudioElement | null>(null);
  const otherUrlRef = useRef<string | null>(null);
  const playRequest = useRef(0);
  const [other, setOther] = useState<OtherAudio | null>(null);
  const [startMs, setStartMs] = useState(0);
  const [activeSide, setActiveSide] = useState<Side | null>(null);
  const [heardMs, setHeardMs] = useState<number | null>(null);
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();

  useGSAP(() => {
    if (!activeSide || reduced) return;
    const file = rootRef.current?.querySelector('.audio-compare__file.is-listening');
    if (file) gsap.fromTo(file, { backgroundColor: '#c7e6d3' },
      { backgroundColor: '#e9f4ed', duration: 0.4, ease: 'power2.out', clearProps: 'backgroundColor' });
  }, { scope: rootRef, dependencies: [activeSide, sourceUrl, reduced], revertOnUpdate: true });

  useEffect(() => {
    setOther(null);
    setStartMs(0);
    setActiveSide(null);
    setHeardMs(null);
    setError(null);
    return () => {
      playRequest.current += 1;
      currentAudioRef.current?.pause();
      otherAudioRef.current?.pause();
      if (otherUrlRef.current) URL.revokeObjectURL(otherUrlRef.current);
      otherUrlRef.current = null;
    };
  }, [sourceUrl]);

  useEffect(() => {
    if (!sourcePlaying) return;
    playRequest.current += 1;
    currentAudioRef.current?.pause();
    otherAudioRef.current?.pause();
    setActiveSide(null);
  }, [sourcePlaying]);

  const commonDurationMs = Math.min(sourceDurationMs, other?.durationMs ?? 0);
  const endMs = Math.min(startMs + EXCERPT_MS, commonDurationMs);
  const canListen = !!other && other.durationMs !== null && endMs - startMs >= 500;
  const differenceMs = other?.durationMs === null || !other ? null : other.durationMs - sourceDurationMs;

  function stop(): void {
    playRequest.current += 1;
    currentAudioRef.current?.pause();
    otherAudioRef.current?.pause();
    setActiveSide(null);
  }

  function chooseOther(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(m4a|mp3|wav|aac|ogg|flac)$/i.test(file.name)) {
      setError('请选择音频文件。');
      return;
    }
    stop();
    setError(null);
    const url = URL.createObjectURL(file);
    if (otherUrlRef.current) URL.revokeObjectURL(otherUrlRef.current);
    otherUrlRef.current = url;
    setOther({ name: file.name, url, durationMs: null });
    setStartMs(Math.max(0, currentMs - 1_000));
    setHeardMs(null);
  }

  function onOtherMetadata(event: SyntheticEvent<HTMLAudioElement>): void {
    const duration = event.currentTarget.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      setError('另一版音频无法读取时长，暂时不能对照试听。');
      return;
    }
    const url = event.currentTarget.currentSrc;
    setOther((previous) => previous?.url === url ? { ...previous, durationMs: Math.round(duration * 1000) } : previous);
  }

  async function play(side: Side): Promise<void> {
    const element = side === 'current' ? currentAudioRef.current : otherAudioRef.current;
    if (!canListen || !element) return;
    const request = ++playRequest.current;
    currentAudioRef.current?.pause();
    otherAudioRef.current?.pause();
    setActiveSide(null);
    setError(null);
    try {
      onPauseSource();
      onSeekSource(startMs);
      element.currentTime = startMs / 1000;
      await element.play();
      if (request !== playRequest.current) {
        element.pause();
        return;
      }
      setHeardMs(startMs);
      setActiveSide(side);
    } catch {
      if (request === playRequest.current) setError('浏览器无法播放这份音频；请换常见格式再试。');
    }
  }

  function onTimeUpdate(side: Side, event: SyntheticEvent<HTMLAudioElement>): void {
    if (activeSide !== side) return;
    const element = event.currentTarget;
    const positionMs = Math.round(element.currentTime * 1000);
    if (positionMs >= endMs - 60) {
      if (loop && canListen) {
        element.currentTime = startMs / 1000;
        setHeardMs(startMs);
      } else {
        element.pause();
        setActiveSide(null);
        setHeardMs(endMs);
      }
      return;
    }
    setHeardMs(positionMs);
  }

  function onEnded(side: Side): void {
    if (activeSide !== side) return;
    const element = side === 'current' ? currentAudioRef.current : otherAudioRef.current;
    if (loop && canListen && element) {
      element.currentTime = startMs / 1000;
      void element.play().catch(() => {
        setActiveSide(null);
        setError('循环试听未能继续播放。');
      });
    } else setActiveSide(null);
  }

  function changeStart(seconds: number | null): void {
    if (seconds === null || !Number.isFinite(seconds)) return;
    stop();
    const maximum = Math.max(0, commonDurationMs - 500);
    setStartMs(Math.min(maximum, Math.max(0, Math.round(seconds * 1000))));
    setHeardMs(null);
  }

  return <section ref={rootRef} className="audio-compare" aria-labelledby="audio-compare-title">
    <div className="audio-compare__head">
      <div>
        <span className="audio-compare__eyebrow">可选 · 声音对照</span>
        <h3 id="audio-compare-title">同一段，听听两版的区别</h3>
      </div>
      <Button icon={<UploadOutlined />} onClick={() => inputRef.current?.click()}>选另一版音频</Button>
      <input ref={inputRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.flac" hidden onChange={chooseOther} />
    </div>

    <div className="audio-compare__files">
      <div className={`audio-compare__file ${activeSide === 'current' ? 'is-listening' : ''}`}>
        <span className="audio-compare__badge">A</span>
        <div><strong>当前音频</strong><span title={sourceName}>{sourceName || '当前打开的文件'}</span></div>
        <time>{formatTime(sourceDurationMs, false)}</time>
      </div>
      <div className={`audio-compare__file ${activeSide === 'other' ? 'is-listening' : ''}`}>
        <span className="audio-compare__badge audio-compare__badge--other">B</span>
        <div><strong>另一版</strong><span title={other?.name}>{other?.name || '选择本机音频后可试听'}</span></div>
        {other?.durationMs !== null && other ? <time>{formatTime(other.durationMs, false)}</time> : null}
      </div>
    </div>

    {other && <>
      <div className="audio-compare__range">
        <label htmlFor="audio-compare-start">从</label>
        <InputNumber id="audio-compare-start" min={0} max={Math.max(0, (commonDurationMs - 500) / 1000)} step={0.1} precision={1}
          value={Number((startMs / 1000).toFixed(1))} onChange={changeStart} addonAfter="秒" />
        <span>开始，最多听 8 秒</span>
        <Button type="link" onClick={() => changeStart(Math.max(0, currentMs - 1_000) / 1000)}>用当前播放点</Button>
      </div>
      <div className="audio-compare__transport">
        <Button aria-pressed={activeSide === 'current'} type={activeSide === 'current' ? 'primary' : 'default'} icon={<PlayCircleOutlined />} disabled={!canListen}
          onClick={() => { void play('current'); }}>试听 A</Button>
        <Button aria-pressed={activeSide === 'other'} type={activeSide === 'other' ? 'primary' : 'default'} icon={<PlayCircleOutlined />} disabled={!canListen}
          onClick={() => { void play('other'); }}>试听 B</Button>
        <Button icon={<PauseOutlined />} disabled={!activeSide} onClick={stop}>暂停</Button>
        <label className="audio-compare__loop"><Switch size="small" checked={loop} onChange={setLoop} />循环这段</label>
      </div>
      <div className="audio-compare__status" role="status" aria-live="polite">
        {activeSide ? `正在听 ${activeSide === 'current' ? 'A' : 'B'} · ${formatTime(heardMs ?? startMs)} / ${formatTime(endMs)}`
          : canListen ? `试听区间 ${formatTime(startMs)}—${formatTime(endMs)}；切换 A/B 都从这里开始。`
            : '这个位置超出了另一版的时长，请把开始位置往前移。'}
      </div>
      {differenceMs !== null && <p className="audio-compare__difference">
        两版相差 {Math.abs(differenceMs / 1000).toFixed(1)} 秒{Math.abs(differenceMs) >= 250 ? '，相同时间点可能不是同一句话。' : '；仍要听一遍确认是同一句话。'}
      </p>}
    </>}
    {error && <p className="audio-compare__error" role="alert">{error}</p>}
    <p className="audio-compare__caution">只在本机试听；这里不处理音频，也没有自动校准响度。声音更大不一定更清楚。</p>
    <audio ref={currentAudioRef} src={sourceUrl} preload="metadata" onTimeUpdate={(event) => onTimeUpdate('current', event)}
      onEnded={() => onEnded('current')} onError={() => setError('当前音频无法在浏览器里播放。')} />
    {other && <audio ref={otherAudioRef} src={other.url} preload="metadata" onLoadedMetadata={onOtherMetadata}
      onTimeUpdate={(event) => onTimeUpdate('other', event)} onEnded={() => onEnded('other')}
      onError={(event) => { if (event.currentTarget.currentSrc === otherUrlRef.current) setError('另一版音频无法在浏览器里播放。'); }} />}
  </section>;
}
