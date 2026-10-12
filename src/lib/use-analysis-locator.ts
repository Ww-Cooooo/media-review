import { useEffect, useRef, useState } from 'react';
import { analysisActivity, REVIEW_CLIENT_ID, type AnalysisActivityItem } from './api';

export function useAnalysisLocator(online: boolean, dataId: string, runtimeId: string, taskId: string | null, onReveal: () => void, onFallback: (item: AnalysisActivityItem) => void, onError: (message: string) => void) {
  const [locating, setLocating] = useState<string | null>(null);
  const current = useRef({ online, taskId, onReveal, onFallback, onError });
  current.current = { online, taskId, onReveal, onFallback, onError };
  const channel = useRef<BroadcastChannel | null>(null);
  const pending = useRef<{ id: string; clientId: string; finish: (focused: boolean) => void } | null>(null);
  const active = useRef(false);
  useEffect(() => {
    if (!online || !dataId || !runtimeId || typeof BroadcastChannel === 'undefined') return;
    const value = new BroadcastChannel(`media-review-analysis:${dataId}:${runtimeId}`); channel.current = value;
    let stopped = false;
    value.onmessage = event => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      const waiting = pending.current;
      if (message.type === 'located' && waiting && waiting.id === message.requestId && waiting.clientId === message.clientId) waiting.finish(message.focused === true);
      if (message.type !== 'locate' || message.clientId !== REVIEW_CLIENT_ID || message.taskId !== current.current.taskId || !current.current.online || typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(message.requestId)) return;
      current.current.onReveal(); window.focus();
      setTimeout(() => { if (!stopped) value.postMessage({ type: 'located', requestId: message.requestId, clientId: REVIEW_CLIENT_ID, focused: document.visibilityState === 'visible' && document.hasFocus() }); }, 100);
    };
    return () => { stopped = true; pending.current?.finish(false); channel.current = null; value.close(); };
  }, [online, dataId, runtimeId]);
  async function locate(item: AnalysisActivityItem) {
    if (active.current || !current.current.online) return;
    active.current = true; setLocating(item.id);
    const originalChannel = channel.current;
    try {
      const response = await analysisActivity();
      if (response.runtimeId !== runtimeId) { current.current.onError('服务会话已经变化，正在重新核验；未切换素材，当前输入保留。'); return; }
      const fresh = response.items.find(value => value.id === item.id);
      if (!current.current.online || originalChannel !== channel.current) return;
      if (!fresh) { current.current.onError('该分析已结束或取消，请以更新后的任务状态为准；当前输入未改变。'); return; }
      if (fresh.tasks.some(task => task.id === current.current.taskId)) { current.current.onReveal(); return; }
      const page = fresh.pages.find(value => value.clientId !== REVIEW_CLIENT_ID && value.visible) ?? fresh.pages.find(value => value.clientId !== REVIEW_CLIENT_ID);
      if (page && originalChannel) {
        const focused = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => finish(false), 1000);
          const finish = (result: boolean) => { clearTimeout(timer); pending.current = null; resolve(result); };
          const id = crypto.randomUUID(); pending.current = { id, clientId: page.clientId, finish };
          originalChannel.postMessage({ type: 'locate', requestId: id, clientId: page.clientId, taskId: page.taskId });
        });
        if (focused) return;
      }
      if (current.current.online && originalChannel === channel.current) current.current.onFallback(fresh);
    } catch (cause) { current.current.onError(cause instanceof Error ? cause.message : '分析来源未能核实，未切换其他素材；当前输入保留。'); }
    finally { active.current = false; setLocating(null); }
  }
  return { locating, locate };
}
