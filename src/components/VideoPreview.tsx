import { useEffect, useRef, type RefObject } from 'react';
import './VideoPreview.css';

interface Props {
  videoRef: RefObject<HTMLMediaElement | null>;
  sourceKey: string;
  active: boolean;
}

/** Display only: the original video remains the playback clock and capture source. */
export function VideoPreview({ videoRef, sourceKey, active }: Props) {
  const display = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const media = videoRef.current;
    const element = display.current;
    if (!(media instanceof HTMLVideoElement) || !element || !active) return;
    const container = element.parentElement;
    if (!container) return;
    const video: HTMLVideoElement = media;
    const canvas: HTMLCanvasElement = element;
    const host: HTMLElement = container;

    const frame = document.createElement('canvas');
    let frameContext: CanvasRenderingContext2D | null;
    let displayContext: CanvasRenderingContext2D | null;
    try {
      frameContext = frame.getContext('2d');
      displayContext = canvas.getContext('2d');
    } catch { return; }
    if (!frameContext || !displayContext) return;
    const raw = frameContext, output = displayContext;
    let disposed = false, failed = false, downsampling = false;
    let pending: number | null = null;
    let settledPaint: number | null = null;
    const videoFrames = typeof video.requestVideoFrameCallback === 'function';
    const hide = () => { canvas.dataset.previewReady = 'false'; };

    function cancelFrame() {
      if (pending === null) return;
      if (videoFrames) video.cancelVideoFrameCallback(pending);
      else cancelAnimationFrame(pending);
      pending = null;
    }

    function paint() {
      if (disposed || failed || !downsampling || document.hidden || video.seeking || video.readyState < 2) {
        hide();
        return;
      }
      try {
        if (frame.width !== video.videoWidth || frame.height !== video.videoHeight) {
          frame.width = video.videoWidth;
          frame.height = video.videoHeight;
        }
        // A direct video-to-small-canvas draw still used the rough scaling path in the observed browser.
        // Resolve an unscaled video frame first; only the second, canvas-to-canvas draw downsamples.
        raw.clearRect(0, 0, frame.width, frame.height);
        raw.drawImage(video, 0, 0);
        output.clearRect(0, 0, canvas.width, canvas.height);
        output.imageSmoothingEnabled = true;
        output.imageSmoothingQuality = 'high';
        output.drawImage(frame, 0, 0, canvas.width, canvas.height);
        canvas.dataset.previewReady = 'true';
      } catch {
        failed = true;
        hide();
        cancelFrame();
      }
    }

    function schedule() {
      if (disposed || failed || !downsampling || document.hidden || video.paused || video.ended || video.seeking || pending !== null) return;
      const next = () => { pending = null; paint(); schedule(); };
      pending = videoFrames ? video.requestVideoFrameCallback(next) : requestAnimationFrame(next);
    }

    function fit() {
      if (disposed) return;
      const bounds = host.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(bounds.width * ratio));
      const height = Math.max(1, Math.round(bounds.height * ratio));
      downsampling = bounds.width > 0 && bounds.height > 0 && width < video.videoWidth && height < video.videoHeight;
      if (!downsampling) { cancelFrame(); hide(); return; }
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      canvas.style.backgroundColor = getComputedStyle(video).backgroundColor;
      paint();
      schedule();
    }

    function cancelSettledPaint() {
      if (settledPaint !== null) cancelAnimationFrame(settledPaint);
      settledPaint = null;
    }
    function refreshDecodedFrame() {
      fit();
      if (!video.paused || disposed) return;
      // seeked can precede the browser's presentation of the decoded frame.
      // Keep the same two-stage downsampling, then repaint after presentation.
      cancelFrame(); cancelSettledPaint();
      if (videoFrames) pending = video.requestVideoFrameCallback(() => { pending = null; fit(); });
      settledPaint = requestAnimationFrame(() => {
        settledPaint = requestAnimationFrame(() => { settledPaint = null; fit(); });
      });
    }
    const pause = () => { cancelFrame(); refreshDecodedFrame(); };
    const seeking = () => { cancelFrame(); cancelSettledPaint(); hide(); };
    const unavailable = () => { cancelFrame(); cancelSettledPaint(); hide(); };
    const visibility = () => { if (document.hidden) unavailable(); else fit(); };
    const listeners: [string, EventListener][] = [
      ['loadedmetadata', fit], ['loadeddata', refreshDecodedFrame], ['resize', fit], ['seeked', refreshDecodedFrame],
      ['play', fit], ['pause', pause], ['ended', pause], ['seeking', seeking],
      ['emptied', unavailable], ['loadstart', unavailable], ['error', unavailable], ['abort', unavailable],
    ];
    listeners.forEach(([name, callback]) => video.addEventListener(name, callback));
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    window.addEventListener('resize', fit);
    document.addEventListener('visibilitychange', visibility);

    let resolution: MediaQueryList | null = null;
    function watchPixelRatio() {
      resolution?.removeEventListener('change', pixelRatioChanged);
      resolution = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      resolution.addEventListener('change', pixelRatioChanged);
    }
    function pixelRatioChanged() { watchPixelRatio(); fit(); }
    watchPixelRatio();
    fit();

    return () => {
      disposed = true;
      cancelFrame();
      cancelSettledPaint();
      hide();
      observer.disconnect();
      listeners.forEach(([name, callback]) => video.removeEventListener(name, callback));
      window.removeEventListener('resize', fit);
      document.removeEventListener('visibilitychange', visibility);
      resolution?.removeEventListener('change', pixelRatioChanged);
      frame.width = frame.height = 0;
      canvas.width = canvas.height = 1;
    };
  }, [videoRef, sourceKey, active]);

  return <canvas ref={display} className="video-preview-canvas" aria-hidden="true" />;
}
