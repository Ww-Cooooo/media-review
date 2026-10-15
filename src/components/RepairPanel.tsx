import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Select, Tag } from 'antd';
import { formatTime, parseTime, type ReviewNote } from '../lib/review';
import { loadVersions, STATUS_LABEL, updateProgress, type ProgressBundle, type RepairState } from '../lib/review-product';
import type { ReviewTask } from '../lib/api';

export function RepairPanel({ note, bundle, disabled, onRefresh, onOpen }: { note: ReviewNote; bundle: ProgressBundle | null; disabled: boolean; onRefresh: () => Promise<void>; onOpen: (task: ReviewTask) => void }) {
  const { message } = App.useApp();
  const [expanded, setExpanded] = useState(false), [text, setText] = useState(''), [state, setState] = useState<RepairState>('pending');
  const [versions, setVersions] = useState<ReviewTask[]>([]), [target, setTarget] = useState<string | null>(null), [time, setTime] = useState(''), [busy, setBusy] = useState(false);
  const current = bundle?.statuses[note.id];
  useEffect(() => { setExpanded(false); setText(''); setTarget(null); setTime(''); setState('pending'); }, [note.id]);
  useEffect(() => { if (!expanded || !bundle) return; let cancelled = false; void loadVersions(bundle.task.id).then(data => { if (!cancelled) setVersions(data.versions.map(item => item.task).filter(item => item.version.number > bundle.task.version.number)); }).catch(cause => message.error(cause.message)); return () => { cancelled = true; }; }, [expanded, bundle?.task.id]);
  async function submit(status: RepairState, explanation = text) {
    if (!bundle) return;
    const ms = time.trim() ? parseTime(time) : null;
    if (time.trim() && ms === null) { message.error('新版位置请填写 00:00.000'); return; }
    setBusy(true);
    try { await updateProgress(bundle, note.id, status, explanation, target, ms); await onRefresh(); setExpanded(false); setText(''); message.success(status === 'confirmed' ? '已记录你的复核确认' : '返修进度已保存'); }
    catch (cause) { message.error(cause instanceof Error ? cause.message : '未保存，说明仍保留'); }
    finally { setBusy(false); }
  }
  return <section className="repair-panel" aria-label="这条意见的返修进度">
    <header><strong>返修进度</strong><Tag color={current?.status === 'confirmed' ? 'success' : current?.status === 'changed' ? 'processing' : 'default'}>{STATUS_LABEL[current?.status ?? 'pending']}</Tag></header>
    {current?.stale && <Alert type="warning" title="意见已改动，旧处理结果需要重新核对" />}
    {current?.latest && <><p>{current.latest.text || '状态已更新'}</p><small>{current.latest.actor === 'user' ? '用户' : 'Agent'} · {new Date(current.latest.at).toLocaleString()}</small>{current.latest.targetTaskId && <Button type="link" size="small" onClick={async () => { try { const data = await loadVersions(bundle!.task.id); const task = data.versions.find(item => item.task.id === current.latest!.targetTaskId)?.task; if (task) onOpen(task); else message.error('返修版本暂不可读，原意见保留'); } catch (cause) { message.error(cause instanceof Error ? cause.message : '返修版本未读回，请重试'); } }}>打开返修版本{current.latest.targetMs !== null ? ` · ${formatTime(current.latest.targetMs)}` : ''}</Button>}</>}
    <div className="product-actions"><Button size="small" disabled={disabled || !bundle} onClick={() => setExpanded(!expanded)}>记录处理情况</Button>{current?.status === 'changed' && <Button size="small" type="primary" disabled={disabled} loading={busy} onClick={() => void submit('confirmed', '用户复核后确认')}>复核通过</Button>}{current?.status === 'confirmed' && <Button size="small" disabled={disabled} loading={busy} onClick={() => void submit('pending', '用户重新打开问题')}>重新打开问题</Button>}</div>
    {expanded && <div className="repair-form"><Select aria-label="处理状态" value={state} onChange={setState} options={Object.entries(STATUS_LABEL).filter(([key]) => key !== 'confirmed').map(([value, label]) => ({ value, label }))} /><Input.TextArea aria-label="返修说明" placeholder="改了什么，或哪一点需要澄清" value={text} onChange={event => setText(event.target.value)} maxLength={3000} autoSize={{ minRows: 2, maxRows: 5 }} />{state === 'changed' && <><Select aria-label="对应新版" placeholder="选择实际返修版本" value={target} onChange={setTarget} options={versions.map(task => ({ value: task.id, label: `V${task.version.number} · ${task.title}` }))} /><Input aria-label="新版位置" placeholder="新版位置（可选）00:00.000" value={time} onChange={event => setTime(event.target.value)} /><small>旧意见仍定位旧版；此处单独记录新版位置。</small></>}<Button size="small" type="primary" loading={busy} disabled={disabled} onClick={() => void submit(state)}>保存处理情况</Button></div>}
    {!!current?.history.length && <details><summary>查看处理历史（{current.history.length}）</summary>{current.history.map(item => <p key={item.id}><strong>{STATUS_LABEL[item.status]}</strong> · {new Date(item.at).toLocaleString()}<br />{item.text}</p>)}</details>}
  </section>;
}
