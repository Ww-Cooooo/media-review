import { useState } from 'react';
import { organizeTasks } from '../lib/review-product';
import { App, Alert, Button, Empty, Input, Pagination, Popconfirm, Switch, Tag, Select, Checkbox, Modal } from 'antd';
import { openTaskLocation } from '../lib/api';
import { AudioOutlined, InboxOutlined, ReloadOutlined, VideoCameraOutlined } from '@ant-design/icons';
import type { ReviewTask, TaskList } from '../lib/api';

export function ReviewTasks({ data, error, currentId, page, includeClosed, online, query, onQuery, onPage, onClosed, onRefresh, onOpen, onSelectFile, onNew, onStatus, filter, sort, onFilter, onSort }: {
  filter: string; sort: string; onFilter: (value: string) => void; onSort: (value: string) => void;
  data: TaskList | null; error: string; currentId: string | null; page: number; includeClosed: boolean; online: boolean; query: string; onQuery: (value: string) => void;
  onPage: (page: number) => void; onClosed: (value: boolean) => void; onRefresh: () => void; onNew: () => void;
  onOpen: (task: ReviewTask) => void; onSelectFile: (task: ReviewTask) => void; onStatus: (task: ReviewTask, status: 'waiting' | 'closed') => void;
}) {
  const { message } = App.useApp();
  const [selected, setSelected] = useState<string[]>([]), [renaming, setRenaming] = useState<ReviewTask | null>(null), [name, setName] = useState(''), [organizing, setOrganizing] = useState(false);
  async function organize(action: 'archive' | 'restore' | 'rename', ids = selected) {
    setOrganizing(true);
    try { const { results } = await organizeTasks(ids, action, name); const failures = results.filter(item => !item.ok); setSelected(failures.map(item => item.id)); if (failures.length) message.warning(failures.map(item => item.message).join('；')); else { message.success(action === 'restore' ? '已恢复到历史列表，可重开任务继续' : action === 'archive' ? '已归档，意见保留，可随时找回' : '任务已重命名'); setRenaming(null); } onRefresh(); }
    catch (cause) { message.error(cause instanceof Error ? cause.message : '整理未完成，资料保留'); }
    finally { setOrganizing(false); }
  }
  const location = async (taskId: string) => {
    try { const result = await openTaskLocation(taskId); if (!result.requested) throw new Error('打开资料位置未确认'); message.success('已请求打开这项任务的资料文件夹。'); }
    catch (cause) { message.error(cause instanceof Error ? cause.message : '资料位置未打开，原文件保留'); }
  };
  return <section className="review-tasks" aria-label="校对任务">
    <header className="history-head"><div><InboxOutlined /><h2>待校对任务</h2>{data && <span className="history-count">{data.active} 项等待接手</span>}</div><Button type="text" icon={<ReloadOutlined />} onClick={onRefresh} disabled={!online}>刷新</Button></header>
    <p className="history-intro">不同对话送来的成片分别保留。打开一项不会合并别的任务的意见。</p>
    <Button size="small" disabled={!online} onClick={onNew}>手选素材，新建独立任务</Button>
    {data && <div className="task-queue-summary" role="status"><strong>{data.service.analysis.running ? '1 项重分析执行中' : '重分析当前空闲'}</strong><span>{data.service.analysis.queued} 项排队 · 共用一个服务</span><small>待人工接手的任务不会因没人操作而到期。分析结束不等于校对通过。</small></div>}
    {error && <Alert type="warning" showIcon title={error} />}
    {data?.warnings.map(value => <Alert key={value} type="warning" showIcon title={value} />)}
    <Input.Search className="task-search" aria-label="搜索校对任务" placeholder="搜索任务名、来源、文件名或任务编号" maxLength={160} allowClear value={query} onChange={event => onQuery(event.target.value)} onSearch={onRefresh} />
    <div className="task-organizer"><Select aria-label="任务状态筛选" value={filter} onChange={onFilter} options={[{value:'',label:'待校对'},{value:'all',label:'全部任务'},{value:'closed',label:'已结束'},{value:'archived',label:'已归档'}]} /><Select aria-label="任务排序" value={sort} onChange={onSort} options={[{value:'created',label:'最近送达'},{value:'opened',label:'最近打开'}]} /><Checkbox checked={!!data?.items.length && data.items.every(task => selected.includes(task.id))} onChange={event => setSelected(event.target.checked ? [...new Set([...selected, ...(data?.items.map(task => task.id) ?? [])])].slice(0,50) : selected.filter(id => !data?.items.some(task => task.id === id)))}>选择本页</Checkbox>{!!selected.length && <><span>已选 {selected.length} 项</span><Popconfirm title="归档所选任务？" description="意见和版本关系保留，之后可恢复。正在打开的任务会跳过。" onConfirm={() => void organize('archive')}><Button size="small" loading={organizing}>批量归档</Button></Popconfirm><Button size="small" loading={organizing} onClick={() => void organize('restore')}>恢复所选</Button></>}</div>
    <Modal title="重命名任务" open={!!renaming} onCancel={() => setRenaming(null)} onOk={() => renaming && void organize('rename',[renaming.id])} confirmLoading={organizing} okText="保存名称" cancelText="取消"><Input aria-label="任务新名称" value={name} maxLength={255} onChange={event => setName(event.target.value)} /><p>仅改变任务显示名称，原媒体与意见不变。</p></Modal>
    {query.trim() && data && <p className="task-search-count" role="status">找到 {data.total} 项匹配任务</p>}
    <label className="task-history-toggle"><Switch size="small" checked={includeClosed} onChange={onClosed} />包含已结束任务（历史仍保留）</label>
    <div className="task-list" data-lenis-prevent aria-live="polite">
      {!data ? <p>{error ? '列表尚未读回，不代表没有任务。' : online ? '正在读取本机任务…' : '服务连接后显示任务；已有资料保留。'}</p> : data.items.length ? <ol>{data.items.map(task => <li key={task.id} className={task.id === currentId ? 'is-current' : ''} data-task-id={task.id}>
        <div className="task-title"><Checkbox aria-label={`选择任务 ${task.title}`} checked={selected.includes(task.id)} onChange={event => setSelected(old => event.target.checked ? [...old,task.id].slice(0,50) : old.filter(id => id !== task.id))} /><span>{task.media.type.startsWith('audio/') ? <AudioOutlined /> : <VideoCameraOutlined />}</span><div><strong title={task.title}>{task.title} · V{task.version?.number ?? 1}</strong><small>{task.label || (task.manual ? '手选素材' : 'Agent 送片')} · {task.id.slice(0, 8)}</small></div><Tag color={task.id === currentId ? 'processing' : task.status === 'closed' ? 'default' : 'warning'}>{task.id === currentId ? '当前任务' : task.archivedAt ? '已归档' : task.status === 'closed' ? '已结束等待' : task.status === 'legacy' ? '旧交接待选择' : '待校对'}</Tag></div>
        <p className="task-metadata">{(task.media.size / 1024 / 1024).toFixed(1)} MiB · {new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}{task.legacy && ' · 沿用旧版资料位置'}</p>
        {task.jobStates && <p className="task-job-states">{Object.entries(task.jobStates).map(([kind, state]) => <span key={kind}>{kind === 'inspection' ? 'Agent 自检' : '波形／台词'}：{({ queued: '排队中', running: '分析中', 'waiting-resources': '等待资源', completed: '已结束，请核对结果', failed: '未完成，可重试', cancelled: '已取消', interrupted: '曾中断，请重试', expired: '可重建缓存已回收', detached: '本任务已撤回，其他归属可继续' } as Record<string, string>)[state] ?? state}</span>)}</p>}
        <div className="task-actions"><Button size="small" disabled={!online} onClick={() => { setRenaming(task); setName(task.title); }}>重命名</Button><Button size="small" disabled={!online} onClick={() => void location(task.id)}>查看资料</Button><Button size="small" type={task.id === currentId ? 'default' : 'primary'} disabled={!online || task.status !== 'waiting'} onClick={() => onOpen(task)}>{task.id === currentId ? '返回当前任务' : task.manual ? '选择文件继续' : '打开校对'}</Button>{!task.manual && task.status === 'waiting' && <Button size="small" disabled={!online} onClick={() => onSelectFile(task)}>手选同版</Button>}{task.status !== 'waiting' ? <Button size="small" disabled={!online} onClick={() => onStatus(task, 'waiting')}>{task.status === 'legacy' ? '继续旧交接' : '重开任务'}</Button> : <Popconfirm title="结束等待这个任务？" description="保留意见与历史，不代表认可；当前任务会先处理未保存输入。其他任务不受影响。" okText="结束任务" cancelText="取消" onConfirm={() => onStatus(task, 'closed')}><Button size="small" disabled={!online}>结束任务</Button></Popconfirm>}</div>
      </li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.trim() ? '没有匹配任务，可以换个关键词或包含已结束任务。' : '当前没有待校对任务；Agent 送片或手动选择素材后会登记在这里。'} />}
    </div>
    {data && data.total > 8 && <Pagination size="small" current={page} pageSize={8} total={data.total} showSizeChanger={false} onChange={onPage} />}
    <p className="history-foot">只加载你选中的媒体。挂起可释放视频与取帧资源；结束任务不会删除资料。</p>
  </section>;
}
