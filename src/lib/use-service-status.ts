import { useEffect, useRef, useState } from 'react';

export type ServiceState = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'incompatible' | 'restarted';
export function useServiceStatus() {
  const runtime = useRef('');
  const [status, setStatus] = useState<{ state: ServiceState; rootId: string }>({ state: 'connecting', rootId: '' });
  useEffect(() => {
    let stopped = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const probe = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(1800) });
        const value = await response.json();
        if (!response.ok || !value.ok || value.app !== 'ai-carry-media-review') throw new Error('服务不可用');
        if (!stopped) {
          failures = 0;
          const restarted = !!runtime.current && runtime.current !== value.runtimeId;
          if (!runtime.current) runtime.current = value.runtimeId;
          setStatus({ state: value.uiRevision !== 'history-20261009-r2' ? 'incompatible' : restarted ? 'restarted' : 'online', rootId: value.rootId ?? '' });
        }
      } catch { if (!stopped) { failures++; setStatus(old => ({ ...old, state: failures >= 2 ? 'offline' : 'reconnecting' })); } }
      finally { if (!stopped) timer = setTimeout(probe, document.hidden ? 10_000 : 2500); }
    };
    void probe();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  return status;
}
