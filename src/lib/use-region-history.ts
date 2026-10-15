import { useEffect, useRef, useState } from 'react';
import type { FrameRegion } from './review';

// One editing session, only geometry. Text keeps the browser's native undo stack.
export function useRegionHistory(key: string) {
  const history = useRef({ past: [] as FrameRegion[][], future: [] as FrameRegion[][] });
  const [, refresh] = useState(0);
  function clear() { history.current = { past: [], future: [] }; refresh(value => value + 1); }
  useEffect(clear, [key]);
  function remember(before: FrameRegion[], after: FrameRegion[]) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    history.current = { past: [...history.current.past, structuredClone(before)].slice(-30), future: [] };
    refresh(value => value + 1);
  }
  function take(current: FrameRegion[], redo = false): FrameRegion[] | null {
    const source = redo ? history.current.future : history.current.past;
    const target = redo ? history.current.past : history.current.future;
    const next = source.pop(); if (!next) return null;
    target.push(structuredClone(current)); refresh(value => value + 1); return next.map(region => { const existing = current.find(item => item.id === region.id); if (!existing) return region; const { text: _old, ...shape } = region; return { ...shape, ...(existing.text !== undefined ? { text: existing.text } : {}) }; });
  }
  return { remember, take, clear, canUndo: !!history.current.past.length, canRedo: !!history.current.future.length };
}
