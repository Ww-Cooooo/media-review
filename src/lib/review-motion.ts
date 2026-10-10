import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { Flip } from 'gsap/Flip';

gsap.registerPlugin(Flip);

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

interface MotionState {
  mediaKey: string | undefined;
  sideView: 'notes' | 'transcript';
  selectionPulse: number;
  recentId: string | null;
  saveOutcome: 'idle' | 'saved' | 'error';
  saving: boolean;
  playing: boolean;
  rectMode: boolean;
  composerOpen: boolean;
  listenOnly: boolean;
}

export function useReviewMotion(root: RefObject<HTMLDivElement | null>, state: MotionState) {
  const reduced = useReducedMotion();
  const before = useRef<ReturnType<typeof Flip.getState> | null>(null);
  const layout = useRef<gsap.core.Timeline | null>(null);
  const audio = useRef<gsap.core.Timeline | null>(null);
  const settle = useCallback(() => {
    layout.current?.progress(1);
    audio.current?.progress(1);
  }, []);
  const prepareLayout = useCallback(() => {
    settle();
    const nodes = root.current?.querySelectorAll('[data-flow]');
    before.current = nodes?.length ? Flip.getState(nodes) : null;
  }, [root, settle]);

  useGSAP(() => {
    layout.current?.progress(1);
    const timeline = gsap.timeline();
    layout.current = timeline;
    if (before.current) {
      const nodes = root.current?.querySelectorAll('[data-flow]');
      if (nodes?.length) timeline.add(Flip.from(before.current, { targets: nodes, duration: reduced ? 0 : .55, ease: 'power3.inOut', scale: false }), 0);
      before.current = null;
    }
    const panel = root.current?.querySelector('.editor-panel');
    if (panel && state.composerOpen && !reduced) timeline.fromTo(panel,
      { x: 24, y: 10, opacity: 0 },
      { x: 0, y: 0, opacity: 1, duration: .55, ease: 'power3.out', clearProps: 'transform,opacity' }, .06);
  }, { scope: root, dependencies: [state.composerOpen, state.mediaKey] });

  useGSAP(() => {
    audio.current?.progress(1);
    const wave = root.current?.querySelector('.audio-scene .waveform');
    if (!state.listenOnly || !wave || reduced) return;
    audio.current = gsap.timeline().fromTo(wave,
      { clipPath: 'inset(0 100% 0 0)' },
      { clipPath: 'inset(0 0% 0 0)', duration: .7, ease: 'power2.inOut', clearProps: 'clipPath' });
  }, { scope: root, dependencies: [state.listenOnly, state.mediaKey] });

  useGSAP(() => {
    if (!state.recentId || reduced) return;
    const node = root.current?.querySelector(`[data-review-id="${CSS.escape(state.recentId)}"]`);
    if (node) gsap.fromTo(node, { backgroundColor: '#f4d5bf' }, { backgroundColor: '#fffef9', duration: .55, clearProps: 'backgroundColor' });
  }, { scope: root, dependencies: [state.recentId, state.sideView, reduced], revertOnUpdate: true });

  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const hidden = () => { if (document.hidden) settle(); };
    preference.addEventListener('change', settle);
    window.addEventListener('resize', settle);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      preference.removeEventListener('change', settle);
      window.removeEventListener('resize', settle);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [settle]);

  return { prepareLayout, settle };
}
