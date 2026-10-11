import { useEffect, useRef, useState } from 'react';

export type ServiceState = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'incompatible' | 'restarted';
const UI_REVISION = 'lifecycle-20261011-r2', PROTOCOL = 3;
interface Status { state: ServiceState; rootId: string; dataId: string; runtimeId: string }
export function useServiceStatus() {
  const identity = useRef({ rootId: '', dataId: '', runtimeId: '' });
  const [status, setStatus] = useState<Status>({ state: 'connecting', rootId: '', dataId: '', runtimeId: '' });
  useEffect(() => {
    let stopped = false, failures = 0, probing = false;
    let timer: ReturnType<typeof setTimeout>;
    const probe = async () => {
      if (probing || stopped) return;
      probing = true; clearTimeout(timer);
      try {
        const response = await fetch('/api/health', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
        const value = await response.json();
        if (!response.ok || !value.ok || value.app !== 'ai-carry-media-review') throw new Error('服务暂不可用');
        if (value.uiRevision !== UI_REVISION || value.protocol !== PROTOCOL || !/^[a-f0-9]{64}$/u.test(value.dataId) || identity.current.rootId && (identity.current.rootId !== value.rootId || identity.current.dataId !== value.dataId)) {
          if (!stopped) setStatus(old => ({ ...old, state: 'incompatible' })); return;
        }
        if (identity.current.runtimeId !== value.runtimeId) {
          if (!stopped && identity.current.runtimeId) setStatus(old => ({ ...old, state: 'restarted' }));
          const bootResponse = await fetch('/api/session/bootstrap', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
          const boot = await bootResponse.json();
          if (!bootResponse.ok || ['rootId', 'dataId', 'runtimeId', 'protocol', 'uiRevision'].some(key => boot[key] !== value[key]) || !/^[a-f0-9]{64}$/u.test(boot.token)) throw new Error('新会话尚未核实');
          if (stopped) return;
          window.__REVIEW_SESSION_TOKEN__ = boot.token;
          identity.current = { rootId: value.rootId, dataId: value.dataId, runtimeId: value.runtimeId };
        }
        if (!stopped) { failures = 0; setStatus({ state: 'online', ...identity.current }); }
      } catch { if (!stopped) { failures++; setStatus(old => ({ ...old, state: failures >= 3 ? 'offline' : 'reconnecting' })); } }
      finally { probing = false; if (!stopped) timer = setTimeout(probe, document.hidden ? 15_000 : 5000); }
    };
    const wake = () => { if (!document.hidden) void probe(); };
    void probe(); window.addEventListener('focus', wake); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, []);
  return status;
}
