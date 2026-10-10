import { useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { Flip } from 'gsap/Flip';
import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { MotionButton as Button } from './MotionButton';
import { formatTime } from '../lib/review';
import type { Frame } from './FrameStrip';
import './FilmStage.css';

gsap.registerPlugin(Flip, useGSAP);

export interface FilmStageControls { settle: () => void }
interface Props {
  mediaKey: string;
  open: boolean;
  busy: boolean;
  isAudio: boolean;
  aspect: number;
  currentMs: number;
  frames: readonly Frame[];
  context: string;
  children: ReactNode;
  editor: ReactNode;
  controls: RefObject<FilmStageControls | null>;
  onClose: () => void;
  onSeek: (ms: number) => void;
}

export function FilmStage({ mediaKey, open, busy, isAudio, aspect, currentMs, frames, context, children, editor, controls, onClose, onSeek }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const motion = useRef<gsap.core.Timeline | null>(null);
  const initialized = useRef(false);
  const previousOpen = useRef(open);
  const previous = [...frames].reverse().find((frame) => frame.timeMs < currentMs - 100);
  const next = frames.find((frame) => frame.timeMs > currentMs + 100);
  const targets = () => root.current!.querySelectorAll<HTMLElement>('[data-film-layout], .video-frame, .audio-identity');

  useGSAP((_context, contextSafe) => {
    const host = root.current!;
    const changed = previousOpen.current !== open;
    previousOpen.current = open;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.innerWidth <= 820;
    const interrupted = !!motion.current?.isActive();
    motion.current?.kill();
    Flip.killFlipsOf(targets(), false);
    const state = Flip.getState(targets());
    gsap.set(targets(), { clearProps: 'transform,width,height,position,top,left' });
    host.dataset.open = String(open);
    const finish = contextSafe!(() => {
      host.dataset.moving = 'false';
      // 阅读和圈选使用无透视的终态；不保留会影响坐标或文字锐度的合成变换。
      gsap.set('.film-pose', { clearProps: 'transform' });
      if (!open && host.contains(document.activeElement)) {
        document.querySelector<HTMLButtonElement>('[data-open-composer]')?.focus({ preventScroll: true });
      }
    });
    if (!initialized.current || !changed || reduced) {
      initialized.current = true;
      gsap.set('.film-editor', { autoAlpha: open ? 1 : 0, x: 0, rotationY: 0 });
      gsap.set('.film-editor-body', { opacity: 1, y: 0 });
      const neighbors = host.querySelectorAll('.film-neighbor');
      if (neighbors.length) gsap.set(neighbors, { opacity: open ? 0.15 : 0.8, x: 0, scale: 1 });
      finish();
      return;
    }
    host.dataset.moving = 'true';
    const timeline = gsap.timeline({ onComplete: finish });
    motion.current = timeline;
    // 背板、媒体画幅是同一透视层下的兄弟节点，视频与框选层不会继承横向拉伸。
    timeline.add(Flip.from(state, { duration: 1.15, ease: 'sine.inOut', scale: true, nested: true }), 0)
      .to('.film-pose', { rotationY: open ? -32 : 18, rotationZ: open ? -5 : 3, z: open ? 100 : 60, force3D: true, duration: 0.575, ease: 'sine.inOut' }, 0)
      .to('.film-pose', { rotationY: 0, rotationZ: 0, z: 0, duration: 0.575, ease: 'sine.inOut' }, 0.575);
    for (const [selector, direction] of [['.film-prev', -1], ['.film-next', 1]] as const) {
      const neighbor = host.querySelector(selector);
      if (neighbor) timeline.to(neighbor, { x: open ? direction * 100 : 0, rotation: direction * (open ? 24 : 9), scale: open ? 0.76 : 1, opacity: open ? 0.15 : 0.8, duration: 0.95, ease: 'sine.inOut' }, 0);
    }
    if (open) {
      const revealAt = interrupted && Number(gsap.getProperty(host.querySelector('.film-editor')!, 'opacity')) > 0.1 ? 0 : 1;
      timeline.to('.film-editor', { autoAlpha: 1, x: 0, rotationY: 0, duration: 0.25, ease: 'power2.out' }, revealAt)
        .fromTo('.film-editor-body', interrupted ? {} : { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' }, revealAt);
    } else {
      timeline.to('.film-editor', { autoAlpha: 0, x: 24, duration: 0.25 }, 0);
    }
  }, { scope: root, dependencies: [open, mediaKey] });

  useGSAP((_context, contextSafe) => {
    const host = root.current!;
    const settle = contextSafe!(() => { motion.current?.progress(1); });
    controls.current = { settle };
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = host.clientWidth;
    let height = host.clientHeight;
    const resize = new ResizeObserver(() => {
      if (width === host.clientWidth && height === host.clientHeight) return;
      width = host.clientWidth; height = host.clientHeight;
      settle();
      gsap.set(targets(), { clearProps: 'transform,width,height,position,top,left' });
    });
    resize.observe(host);
    const hidden = () => { if (document.hidden) settle(); };
    query.addEventListener('change', settle);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      motion.current?.kill();
      controls.current = null;
      resize.disconnect();
      query.removeEventListener('change', settle);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, { scope: root, dependencies: [mediaKey], revertOnUpdate: true });

  return <div ref={root} className={`film-scene ${isAudio ? 'film-audio' : ''}`} data-open="false" data-moving="false" style={{ '--media-ratio': aspect } as CSSProperties}>
    <span className="film-stage-word" aria-hidden="true">{isAudio ? 'LISTEN' : 'FOCUS'}</span>
    {[previous, next].map((frame, index) => frame && !isAudio ? <button key={index} className={`film-neighbor ${index ? 'film-next' : 'film-prev'}`} disabled={busy || open} onClick={() => onSeek(frame.timeMs)} aria-label={`回看${index ? '后一处' : '前一处'}画面 ${formatTime(frame.timeMs)}`}>
      <img src={frame.image} alt="" /><span>{index ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}{formatTime(frame.timeMs)} · {index ? '后一处' : '前一处'}</span>
    </button> : null)}
    <div className="film-pose">
      <div className="film-card" data-film-layout aria-hidden="true" />
      <div className="film-media-bed" data-film-layout aria-hidden="true" />
      <div className="film-media">{children}</div>
      <section className="film-editor" inert={!open} aria-hidden={!open} aria-label="当前片段批注">
        <header className="film-editor-head"><div><span>这一处 / {isAudio ? '声音意见' : '审片意见'}</span><h2>把想改的地方<br />说清楚。</h2><p>{context}</p></div><Button disabled={busy} onClick={onClose} aria-label="收起批注，保留草稿">收起 <ArrowRightOutlined /></Button></header>
        <div className="film-editor-body">{editor}</div>
      </section>
    </div>
  </div>;
}
