import { useCallback, useEffect, useState } from 'react';
import { listTasks, type TaskList } from './api';

export function useReviewTasks(online: boolean) {
  const [data, setData] = useState<TaskList | null>(null), [error, setError] = useState('');
  const [page, setPage] = useState(1), [closed, setClosed] = useState(false);
  const refresh = useCallback(async () => {
    if (!online) return;
    try { setData(await listTasks((page - 1) * 8, closed)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '任务列表暂未读回，原资料保留'); }
  }, [online, page, closed]);
  useEffect(() => {
    if (!online) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await listTasks((page - 1) * 8, closed); if (!stopped) { setData(value); setError(''); } }
      catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : '任务列表暂未读回'); }
      finally { if (!stopped) timer = setTimeout(poll, document.hidden ? 15_000 : 5000); }
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [online, page, closed]);
  return { data, error, page, closed, setPage, setClosed: (value: boolean) => { setClosed(value); setPage(1); }, refresh };
}
