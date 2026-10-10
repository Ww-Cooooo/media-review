import { PictureOutlined, StopOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../lib/review';
import './FrameStrip.css';

export interface Frame {
  timeMs: number;
  image: string;
}

export interface FrameStripProps {
  /** The blob: URL already owned by the parent media player. */
  url: string;
  durationMs: number;
  currentMs: number;
  onSeek: (timeMs: number) => void;
  viewStartMs: number;
  viewEndMs: number;
  onFrames?: (url: string, frames: readonly Frame[]) => void;
}

const FRAME_COUNT = 16;
const TOTAL_TIMEOUT_MS = 18_000;
const FRAME_TIMEOUT_MS = 2_300;

function cancelled(): DOMException {
  return new DOMException('已停止生成', 'AbortError');
}

function waitForMedia(
  video: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'seeked',
  signal: AbortSignal,
  timeoutMs: number,
  start: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }

    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error('浏览器无法解码这段视频。'));
    const onAbort = () => finish(cancelled());
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('读取画面超时。')), timeoutMs);
    try { start(); }
    catch (error) { finish(error instanceof Error ? error : new Error('无法读取画面。')); }
  });
}

function drawFrame(video: HTMLVideoElement, timeMs: number): Frame {
  if (!video.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error('这一帧尚未解码。');
  }
  const longestSide = Math.max(video.videoWidth, video.videoHeight);
  const scale = Math.min(1, 200 / longestSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成画面索引。');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { timeMs, image: canvas.toDataURL('image/jpeg', 0.76) };
}

export default function FrameStrip({ url, durationMs, currentMs, onSeek, viewStartMs, viewEndMs, onFrames }: FrameStripProps) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const available = url.startsWith('blob:') && Number.isFinite(durationMs) && durationMs > 0;
  const visibleFrames = frames.filter((frame) => frame.timeMs >= viewStartMs && frame.timeMs <= viewEndMs);

  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setFrames([]);
    onFrames?.(url, []);
    setStatus('idle');
    setProgress(0);
    setNotice('');
    return () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, [url, durationMs]);

  async function generate(automatic = false): Promise<void> {
    if (!available || (status === 'loading' && !automatic)) return;
    controller.current?.abort();
    const task = new AbortController();
    controller.current = task;
    const taskId = ++generation.current;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let didTimeout = false;
    const deadline = setTimeout(() => { didTimeout = true; task.abort(); }, TOTAL_TIMEOUT_MS);
    const collected: Frame[] = [];
    setFrames([]);
    onFrames?.(url, []);
    setProgress(0);
    setNotice('');
    setStatus('loading');

    try {
      await waitForMedia(video, 'loadedmetadata', task.signal, 6_000, () => {
        video.src = url;
        video.load();
      });
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error('这段视频没有可用的时长信息。');
      }
      const actualDurationMs = video.duration * 1000;
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (task.signal.aborted) throw cancelled();
        const timeMs = Math.round(Math.min(
          Math.max(0, actualDurationMs - 120),
          actualDurationMs * ((index + 0.5) / FRAME_COUNT),
        ));
        try {
          await waitForMedia(video, 'seeked', task.signal, FRAME_TIMEOUT_MS, () => {
            video.currentTime = timeMs / 1000;
          });
          collected.push(drawFrame(video, timeMs));
          if (taskId === generation.current && !task.signal.aborted) {
            setFrames([...collected]);
            onFrames?.(url, [...collected]);
          }
        } catch (error) {
          if (task.signal.aborted) throw error;
          if (video.error) throw new Error('浏览器无法继续解码这段视频。');
          // An unseekable frame does not invalidate the frames already decoded.
        }
        if (taskId === generation.current) setProgress(index + 1);
      }
      if (collected.length === 0) throw new Error('没有取得可用画面；请直接使用播放器时间轴定位。');
      if (taskId === generation.current) {
        setStatus('done');
        setNotice(collected.length < FRAME_COUNT ? `已生成 ${collected.length} 帧，个别位置无法读取。` : `已生成 ${collected.length} 帧。`);
      }
    } catch (error) {
      if (taskId !== generation.current) return;
      if (task.signal.aborted) {
        setStatus(collected.length ? 'done' : 'idle');
        setNotice(didTimeout
          ? collected.length ? `读取超时，保留已生成的 ${collected.length} 帧。` : '读取超时，请使用播放器时间轴定位。'
          : collected.length ? `已停止，保留已生成的 ${collected.length} 帧。` : '已停止生成。');
      } else {
        setStatus(collected.length ? 'done' : 'error');
        setNotice(error instanceof Error ? error.message : '无法生成画面索引。');
      }
    } finally {
      clearTimeout(deadline);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (controller.current === task) controller.current = null;
    }
  }

  useEffect(() => {
    if (!available) return;
    const timer = window.setTimeout(() => { void generate(true); }, 0);
    return () => window.clearTimeout(timer);
  }, [url, durationMs]);

  return <section className="frame-strip" aria-label="视频画面索引">
    <div className="frame-strip__head">
      <div>
        <strong>画面索引</strong>
        <span>快速找到要回看的位置</span>
      </div>
      {status === 'loading'
        ? <Button icon={<StopOutlined />} onClick={() => controller.current?.abort()}>停止生成</Button>
        : <Button icon={<PictureOutlined />} disabled={!available} onClick={() => void generate()}>{frames.length ? '重新生成' : '生成画面索引'}</Button>}
    </div>
    {status === 'loading' && <p className="frame-strip__message" role="status">正在读取画面 {progress}/{FRAME_COUNT}，可随时停止</p>}
    {status !== 'loading' && (notice || !available) && <p className={`frame-strip__message ${status === 'error' ? 'is-error' : ''}`} role="status">{notice || '本机视频加载完成后可生成索引。'}</p>}
    {frames.length > 0 && <div className="frame-strip__list" aria-label="当前时间轴视野内可跳转的画面">
      {visibleFrames.map((frame) => {
        const selected = Math.abs(currentMs - frame.timeMs) <= durationMs / (FRAME_COUNT * 2);
        return <button className={`frame-strip__frame ${selected ? 'is-current' : ''}`} key={`${frame.timeMs}-${frame.image.length}`} type="button" style={{ left: `${Math.max(5, Math.min(95, ((frame.timeMs - viewStartMs) / Math.max(1, viewEndMs - viewStartMs)) * 100))}%` }} aria-label={`跳转到 ${formatTime(frame.timeMs, false)} 附近的画面`} aria-pressed={selected} onClick={() => onSeek(frame.timeMs)}>
          <img src={frame.image} alt="" width="124" height="76" />
          <span>{formatTime(frame.timeMs, false)}</span>
        </button>;
      })}
      {visibleFrames.length === 0 && <div className="frame-strip__empty">这段没有索引帧；仍可在下方波形精确选段。</div>}
    </div>}
    {frames.length > 0 && <p className="frame-strip__hint">缩略帧只帮你定位；具体画面请在上方播放器确认。</p>}
  </section>;
}
