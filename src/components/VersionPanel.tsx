import { useEffect, useState } from 'react';
import { Alert, App, Button, Empty, Tag } from 'antd';
import { formatTime, KIND_LABEL } from '../lib/review';
import { loadVersions, STATUS_LABEL, updateProgress, type ProgressBundle } from '../lib/review-product';
import type { ReviewTask } from '../lib/api';

export function VersionPanel({ task, editable, onOpen, onNew, onSeek }: { task: ReviewTask; editable: boolean; onOpen: (task: ReviewTask) => void; onNew: () => void; onSeek: (ms: number) => void }) {
  const { message } = App.useApp();
  const [versions, setVersions] = useState<ProgressBundle[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = async () => { try { const data = await loadVersions(task.id); setVersions(data.versions); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : '版本资料未读回'); } };
  useEffect(() => { let cancelled = false; void loadVersions(task.id).then(data => { if (!cancelled) setVersions(data.versions); }).catch(cause => { if (!cancelled) setError(cause.message); }); return () => { cancelled = true; }; }, [task.id]);
  const incoming = versions.flatMap(bundle => (bundle.record?.notes ?? []).filter(note => bundle.statuses[note.id]?.latest?.targetTaskId === task.id).map(note => ({ bundle, note, status: bundle.statuses[note.id] })));
  async function confirm(bundle: ProgressBundle, noteId: string, reopen = false) {
    setBusy(true);
    try { await updateProgress(bundle, noteId, reopen ? 'pending' : 'confirmed', reopen ? '用户在新版复核后重新打开' : '用户在返修版复核通过'); await refresh(); }
    catch (cause) { message.error(cause instanceof Error ? cause.message : '状态未更新'); }
    finally { setBusy(false); }
  }
  return <div className="version-panel">
    <p>同一作品各版分别保留意见。旧时间码与画面框只属于原版。</p><div className="product-actions"><Button onClick={() => void refresh()}>刷新版本与进度</Button><Button type="primary" onClick={onNew}>手选此作品的新版本</Button></div>
    {error && <Alert type="warning" title={error} />}
    <ol className="version-list">{versions.map(bundle => <li key={bundle.task.id}><div><strong>V{bundle.task.version.number} · {bundle.task.title}</strong><Tag>{bundle.task.id === task.id ? '当前版本' : bundle.task.archivedAt ? '已归档' : '保留版本'}</Tag></div><p>{bundle.task.label || '手选素材'} · {new Date(bundle.task.createdAt).toLocaleString()}</p>{bundle.unavailable ? <Alert type="warning" title={bundle.message} /> : <p>{bundle.record?.notes.length ?? 0} 条意见 · {Object.values(bundle.statuses).filter(item => item.status === 'confirmed').length} 条已确认{bundle.record?.completion?.outcome === 'no-changes' ? ' · 本轮无修改意见' : ''}</p>}<Button size="small" disabled={bundle.task.id === task.id} onClick={() => onOpen(bundle.task)}>查看这版</Button>{bundle.progress?.acknowledgements.at(-1) && <p className="product-muted">接手：{bundle.progress.acknowledgements.at(-1)!.agent} · 收到 {bundle.progress.acknowledgements.at(-1)!.received.length} 条 · 待澄清 {bundle.progress.acknowledgements.at(-1)!.clarifications.length} 条</p>}</li>)}</ol>
    <h3>本版处理的意见</h3>{!incoming.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无关联的返修结果；Agent 提交处理说明后显示在这里" />}
    {incoming.map(({ bundle, note, status }) => <article className="version-issue" key={bundle.task.id + note.id}><header><strong>来自 V{bundle.task.version.number} · {KIND_LABEL[note.kind]}</strong><Tag color={status.status === 'confirmed' ? 'success' : 'processing'}>{STATUS_LABEL[status.status]}</Tag></header><small>原版位置：{note.scope === 'whole' ? '整片意见' : formatTime(note.startMs!)}{note.endMs !== null ? ' — ' + formatTime(note.endMs) : ''}</small><p>{note.text}</p><p><strong>处理说明：</strong>{status.latest?.text}</p><div className="product-actions">{status.latest?.targetMs != null && <Button size="small" onClick={() => onSeek(status.latest!.targetMs!)}>定位本版 {formatTime(status.latest.targetMs)}</Button>}<Button size="small" onClick={() => onOpen(bundle.task)}>查看原意见和参考帧</Button>{status.status === 'changed' && <Button size="small" type="primary" disabled={!editable} loading={busy} onClick={() => void confirm(bundle, note.id)}>本版复核通过</Button>}{status.status === 'confirmed' && <Button size="small" disabled={!editable} loading={busy} onClick={() => void confirm(bundle, note.id, true)}>重新打开问题</Button>}</div></article>)}
    <h3>本版自检记录</h3>{versions.find(bundle => bundle.task.id === task.id)?.progress?.checks.map(check => <article key={check.id} className="version-issue"><p className="product-muted">Agent 检查 · {new Date(check.at).toLocaleString()} · 不代表用户认可</p>{check.coverage.map((part, index) => <p key={index}>{formatTime(part.startMs)} — {formatTime(part.endMs)} · {part.aspects.map(value => ({visual:'画面',audio:'声音',subtitle:'字幕',pace:'节奏'}[value] ?? value)).join('、')} · {({checked:'已核对',issue:'发现问题',unverified:'尚未核实'} as Record<string,string>)[part.result]}<br />{part.detail}</p>)}<p>发现：{check.findings || '未另记发现'}</p><p>未核实：{check.notVerified || '见上方逐项范围；范围外未作声明'}</p>{check.keptNotes.map((item, index) => <p key={index}>保留项 {item.noteId} · {({checked:'已核对',issue:'发现问题',unverified:'尚未核实'} as Record<string,string>)[item.result]}：{item.detail}</p>)}</article>)}{!versions.find(bundle => bundle.task.id === task.id)?.progress?.checks.length && <p className="product-muted">尚无实际检查记录。工具取帧和解码成功不能代替看过、听过。</p>}
  </div>;
}
