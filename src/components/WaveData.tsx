import { useEffect, useState } from 'react';
import { Pagination } from 'antd';
import { formatTime } from '../lib/review';

export function WaveData({ peaks, durationMs }: { peaks: number[]; durationMs: number }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [peaks]);
  const start = (page - 1) * 100;
  return <details className="wave-data" data-lenis-prevent onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看波形数值（{peaks.length} 个时间窗）</summary>
    {open && <><div><table><thead><tr><th>时间窗起点</th><th>RMS</th></tr></thead><tbody>{peaks.slice(start, start + 100).map((value, index) => <tr key={start + index}><td>{formatTime((start + index) / peaks.length * durationMs)}</td><td>{value.toFixed(5)}</td></tr>)}</tbody></table></div>{peaks.length > 100 && <Pagination size="small" current={page} pageSize={100} total={peaks.length} showSizeChanger={false} onChange={setPage} />}</>}
  </details>;
}
