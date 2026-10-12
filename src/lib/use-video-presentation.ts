import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export function useVideoPresentation(host: RefObject<HTMLElement | null>, enabled: boolean, onNotice: (text: string) => void) {
  const [expanded, setExpanded] = useState(false), [fullscreen, setFullscreen] = useState(false), [pending, setPending] = useState(false);
  const transition = useRef(false), current = useRef({ enabled, onNotice });
  current.current = { enabled, onNotice };
  const leave = useCallback(async () => {
    setExpanded(false);
    if (host.current && document.fullscreenElement === host.current) {
      try { await document.exitFullscreen(); }
      catch { current.current.onNotice('浏览器尚未退出全屏，请按 Esc 返回；播放位置和意见仍保留。'); }
    }
  }, [host]);
  useEffect(() => {
    const change = () => setFullscreen(!!host.current && document.fullscreenElement === host.current);
    document.addEventListener('fullscreenchange', change); change();
    return () => document.removeEventListener('fullscreenchange', change);
  }, [host]);
  useEffect(() => { if (!enabled) void leave(); }, [enabled, leave]);
  useEffect(() => {
    if (!expanded || !enabled || fullscreen) return;
    const node = host.current; if (!node) return;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    node.querySelector<HTMLButtonElement>('[data-player-resize]')?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); return; }
      if (event.key !== 'Tab') return;
      const targets = [...node.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length && element.tabIndex >= 0);
      const first = targets[0], last = targets.at(-1); if (!first || !last) return;
      if (!node.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    window.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [expanded, enabled, fullscreen, host]);
  async function toggleFullscreen() {
    const node = host.current;
    if (!node || !current.current.enabled || transition.current) return;
    transition.current = true; setPending(true);
    try {
      if (document.fullscreenElement === node) await document.exitFullscreen();
      else {
        if (document.fullscreenElement) { current.current.onNotice('请先退出其他内容的全屏，再全屏查看当前视频。'); return; }
        if (!document.fullscreenEnabled || !node.requestFullscreen) throw new Error('fullscreen_unavailable');
        await node.requestFullscreen();
        if ((!current.current.enabled || host.current !== node) && document.fullscreenElement === node) await document.exitFullscreen();
      }
    } catch {
      if (current.current.enabled && host.current === node) {
        setExpanded(true);
        current.current.onNotice('浏览器未允许系统全屏，已改为页内放大；可按 Esc 或点击“收起”返回，当前位置和意见保留。');
      }
    } finally { transition.current = false; setPending(false); }
  }
  return { expanded, fullscreen, pending, leave, toggleFullscreen, toggleExpanded: () => { if (current.current.enabled && !transition.current) { if (fullscreen) void leave(); else setExpanded(value => !value); } } };
}
