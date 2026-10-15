import { useMemo, useState } from 'react';
import { Button, Radio, Tag } from 'antd';
import { formatTime, KIND_LABEL, regionsOf, sortedNotes, type ReviewNote } from '../lib/review';
import type { ReviewDraft } from '../lib/review-draft';

function NoteSummary({ note }: { note?: ReviewNote }) {
  if (!note) return <p className="product-muted">此版本没有这条意见（新增或已删除）</p>;
  return <div><p><Tag>{KIND_LABEL[note.kind]}</Tag>{note.scope === 'whole' ? '整片意见' : formatTime(note.startMs!)}{note.endMs !== null ? ' — ' + formatTime(note.endMs) : ''}</p><p className="difference-text">{note.text}</p>{note.reference && <small>参考帧：{formatTime(note.reference.frameMs)}</small>}{regionsOf(note).map(region => <p className="product-muted" key={region.id}>框 {region.id}：{region.text || '共用本条说明'}<br />左 {(region.rect.x * 100).toFixed(1)}%、上 {(region.rect.y * 100).toFixed(1)}%、宽 {(region.rect.width * 100).toFixed(1)}%、高 {(region.rect.height * 100).toFixed(1)}%</p>)}</div>;
}
export function ReviewDifference({ left, right, leftLabel, rightLabel, drafts = [], onMerge }: { left: ReviewNote[]; right: ReviewNote[]; leftLabel: string; rightLabel: string; drafts?: ReviewDraft[]; onMerge?: (notes: ReviewNote[]) => void }) {
  const [choices, setChoices] = useState<Record<string, 'left' | 'right'>>({});
  const ids = useMemo(() => [...new Set([...left, ...right].map(note => note.id))], [left, right]);
  const changed = ids.filter(id => JSON.stringify(left.find(note => note.id === id)) !== JSON.stringify(right.find(note => note.id === id)));
  return <section className="review-difference" aria-label="逐条比较意见">
    <p>{changed.length} 条存在差异，{ids.length - changed.length} 条相同。文字、时间、参考帧与框位置分别保留。</p>
    {changed.map((id, index) => <article key={id}><header><strong>差异 {index + 1}</strong>{onMerge && <Radio.Group aria-label={`差异 ${index + 1} 保留哪一份`} value={choices[id] ?? 'right'} onChange={event => setChoices(old => ({ ...old, [id]: event.target.value }))}><Radio.Button value="left">保留{leftLabel}</Radio.Button><Radio.Button value="right">保留{rightLabel}</Radio.Button></Radio.Group>}</header><div className="difference-columns"><section><h4>{leftLabel}</h4><NoteSummary note={left.find(note => note.id === id)} /></section><section><h4>{rightLabel}</h4><NoteSummary note={right.find(note => note.id === id)} /></section></div></article>)}
    {drafts.filter(draft => draft.text || draft.mode).length > 0 && <details open><summary>尚未保存的草稿（继续保留）</summary>{drafts.filter(draft => draft.text || draft.mode).map((draft, index) => <div key={index}><strong>草稿 {index + 1} · {draft.mode === 'whole' ? '整片' : `${draft.startText || '起点未定'}${draft.endText ? ' — ' + draft.endText : ''}`}</strong><p className="difference-text">{draft.text || '尚未填写说明'}</p><p>画面框：{regionsOf(draft).map(region => region.id).join('、') || '无'}{draft.snapshot || draft.reference ? ' · 参考画面已保留' : ''}</p></div>)}</details>}
    {onMerge && <Button type="primary" onClick={() => onMerge(sortedNotes(ids.flatMap(id => { const a = left.find(note => note.id === id), b = right.find(note => note.id === id); const chosen = choices[id] === 'left' ? a : b; return chosen ? [chosen] : []; })))}>采用逐条选择，继续编辑</Button>}
  </section>;
}
