import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Progress, Tooltip } from 'antd';
import { DownOutlined, UpOutlined, SyncOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { AnalysisActivityItem } from '../lib/api';

const PHASE: Record<string, string> = { preparing: '准备分析', queued: '等待分析', 'waiting-resources': '等待可用资源', uploading: '传送到本机', decoding: '读取音轨', waveform: '生成波形', 'loading-model': '加载语音模型', transcribing: '识别台词', finalizing: '整理结果', cancelling: '正在停止' };
function phase(item: AnalysisActivityItem) {
  if (item.state !== 'running') return PHASE[item.state] ?? '等待分析';
  return item.progress ? PHASE[item.progress.phase] ?? '正在分析' : item.kind === 'inspection' ? 'Agent 正在自检' : '正在分析';
}
export function AnalysisActivityNotice({ items, locating, online, layoutKey, onLocate }: { items: AnalysisActivityItem[]; locating: string | null; online: boolean; layoutKey: string; onLocate: (item: AnalysisActivityItem) => void }) {
  const [collapsed, setCollapsed] = useState(true), [bottom, setBottom] = useState(18);
  const floating = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = floating.current; if (!online || !node) return;
    const place = () => {
      const box = node.getBoundingClientRect(), controls = document.querySelector('.transport')?.getBoundingClientRect();
      const end = innerHeight - 18, start = end - box.height;
      const overlaps = controls && box.left < controls.right && box.right > controls.left && start < controls.bottom && end > controls.top;
      const next = overlaps ? Math.max(18, Math.min(innerHeight - box.height - 12, innerHeight - controls.top + 10)) : 18;
      setBottom(value => value === next ? value : next);
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, { capture: true, passive: true });
    const observer = new ResizeObserver(place); observer.observe(node);
    const surface = document.querySelector('.transport')?.parentElement; if (surface) observer.observe(surface);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [collapsed, online, layoutKey, items]);
  if (!online || !items.length) return null;
  const main = items[0], percent = main.progress?.percent, hasTarget = !!(main.tasks.length || main.pages.length);
  return <aside ref={floating} style={{ bottom }} className={`analysis-activity${collapsed ? ' is-collapsed' : ''}`} aria-label="本机分析活动" data-lenis-prevent data-analysis-activity={main.id}>
    <div className="analysis-activity-head">
      <Tooltip title={hasTarget ? `定位到正在处理“${main.mediaName}”的校对页；不会取消分析` : '旧入口未登记媒体或窗口来源，不能安全定位；请核对原窗口'}>
        <span className="analysis-activity-main"><Button type="text" loading={locating === main.id} disabled={!hasTarget || !!locating && locating !== main.id} aria-label={`前往分析页面：${main.mediaName}`} aria-busy={locating === main.id} icon={<SyncOutlined spin aria-hidden />} onClick={() => onLocate(main)}><span className="analysis-activity-label"><strong>{phase(main)}{percent !== null && percent !== undefined ? ` · ${percent}%` : ''}</strong><span className="analysis-activity-name">{main.mediaName}</span></span><ArrowRightOutlined aria-hidden /></Button></span>
      </Tooltip>
      <Button type="text" size="small" shape="circle" aria-label={collapsed ? '展开分析详情' : '收起分析详情'} aria-expanded={!collapsed} aria-controls="analysis-activity-details" icon={collapsed ? <UpOutlined /> : <DownOutlined />} onClick={() => setCollapsed(value => !value)} />
    </div>
    {!collapsed && <div className="analysis-activity-details" id="analysis-activity-details">
      <p>本机服务 {location.host}<br />{main.pages.length ? `${main.pages.length} 个已登记校对页` : '后台分析，暂无已登记的校对页'} · {main.kind === 'inspection' ? 'Agent 自检' : '波形／台词分析'}</p>
      <p>校对页：{main.tasks[0] ? `${main.tasks[0].label || main.tasks[0].title} · ${main.tasks[0].id.slice(0, 8)}` : '旧入口未登记来源'}</p>
      {percent !== null && percent !== undefined && <Progress percent={percent} size="small" showInfo={false} />}
      <ul>{items.map(item => <li key={item.id}><Button type="link" size="small" title={item.tasks.map(task => `${task.title} · ${task.id.slice(0, 8)}`).join('；') || item.mediaName} disabled={!item.tasks.length && !item.pages.length || !!locating} onClick={() => onLocate(item)}><span className="analysis-activity-item-name">{item.mediaName}</span></Button><small>{phase(item)}{item.tasks.length > 1 ? ` · ${item.tasks.length} 项任务共用结果` : ''}</small></li>)}</ul>
      <p className="analysis-activity-hint">点击素材定位页面，不取消其他任务。浏览器未允许切页时可在本页查看；收起只隐藏详情。</p>
    </div>}
  </aside>;
}
