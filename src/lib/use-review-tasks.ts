import { useCallback, useEffect, useRef, useState } from 'react';
import { listTasks, type TaskList } from './api';

export function useReviewTasks(online: boolean) {
  const [data, setData] = useState<TaskList | null>(null), [error, setError] = useState('');
  const [page, setPage] = useState(1), [closed, setClosed] = useState(false), [query, setQuery] = useState('');
  const [filter, setFilter] = useState(''), [sort, setSort] = useState('created');
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!online) return;
    const sequence = ++request.current;
    try { const value = await listTasks((page - 1) * 8, closed, query, filter, sort); if (sequence === request.current) { setData(value); setError(''); } }
    catch (cause) { if (sequence === request.current) setError(cause instanceof Error ? cause.message : '任务列表暂未读回，原资料保留'); }
  }, [online, page, closed, query, filter, sort]);
  useEffect(() => {
    if (!online) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh(); if (!stopped) timer = setTimeout(poll, document.hidden ? 15_000 : 5000);
    };
    timer = setTimeout(poll, query ? 180 : 0);
    return () => { stopped = true; request.current++; clearTimeout(timer); };
  }, [online, refresh, query]);
  return { data, error, page, closed, query, setPage, filter, sort, setFilter: (value: string) => { setFilter(value); setPage(1); }, setSort: (value: string) => { setSort(value); setPage(1); },
    setClosed: (value: boolean) => { request.current++; setClosed(value); setPage(1); },
    setQuery: (value: string) => { request.current++; setQuery(value); setPage(1); }, refresh };
}
