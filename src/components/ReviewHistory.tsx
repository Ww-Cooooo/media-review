import { useEffect, useState } from 'react';
import { Alert, App, Button, Empty, Spin, Tag } from 'antd';
import { FolderOpenOutlined, HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import { loadReviewHistory, openReviewLocation, type ReviewHistory as HistoryData } from '../lib/api';
import { formatTime } from '../lib/review';

export function ReviewHistory({ online }: { online: boolean }) {
  const { message } = App.useApp();
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    setLoading(true); setError('');
    void loadReviewHistory().then(value => { if (!cancelled) setData(value); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '历史暂未读回，原资料保留'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [online]);
  async function refresh() {
    if (!online || loading) return;
    setLoading(true); setError('');
    try { setData(await loadReviewHistory()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '历史暂未读回，原资料保留'); }
    finally { setLoading(false); }
  }
  async function open(scope: 'all' | 'record' | 'draft' | 'references', fingerprint?: string) {
    if (opening || !online) return;
    setOpening(`${scope}-${fingerprint ?? ''}`);
    try {
      const result = await openReviewLocation(scope, fingerprint);
      if (!result.requested) throw new Error('打开请求未确认，请复制下方保存位置到文件资源管理器');
      message.success(result.selectedFile ? '已请求打开文件夹并选中对应记录。' : '已请求打开校对资料文件夹。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '未能打开，请复制保存位置到文件资源管理器'); }
    finally { setOpening(''); }
  }
  return <section className="review-history" aria-label="校对历史">
    <header className="history-head"><div><HistoryOutlined /><h2>校对历史</h2>{data && <span className="history-count">{data.items.length} 个素材</span>}</div>
      <Button type="text" icon={<ReloadOutlined />} loading={loading} disabled={!online} onClick={() => void refresh()}>刷新</Button></header>
    <p className="history-intro">找回视频或录音的标记、意见和参考截图。</p>
    <div className="history-storage"><div><strong>校对资料保存在本机</strong><Button icon={<FolderOpenOutlined />} disabled={!online || !data || !!opening} loading={opening === 'all-'} onClick={() => void open('all')}>打开保存文件夹</Button></div>
      {data ? <p className="history-path">{data.directory}</p> : <p>{online ? '正在读取保存位置…' : '服务连接后显示保存位置。'}</p>}
      <small>正式意见在此文件夹；参考图在 references，恢复草稿在 drafts。</small></div>
    {error && <Alert type="warning" showIcon title={error} />}
    {data?.warnings.map(warning => <p className="history-warning" key={warning}>{warning}</p>)}
    <div className="history-list" data-lenis-prevent aria-busy={loading}>
      {!data ? <div className="history-pending">{online && loading ? <Spin tip="正在读取校对历史"><div /></Spin> : <p>{error ? '历史未读回，不代表没有记录。' : '等待本机服务连接，已有资料不会被清空。'}</p>}</div> : data.items.length ? <ol>{data.items.map(item => <li key={item.fingerprint} data-history-id={item.fingerprint}>
        <div className="history-item-title"><strong>{item.name ?? `记录待检查 · ${item.fingerprint.slice(0, 8)}`}</strong><span>{item.type.startsWith('audio/') ? '音频' : item.type.startsWith('video/') ? '视频' : '素材'}{item.durationMs !== null ? ` · ${formatTime(item.durationMs, false)}` : ''}</span></div>
        <div className="history-item-meta"><Tag color={item.savedNotes !== null ? 'success' : 'default'}>{item.savedNotes !== null ? `已保存 ${item.savedNotes} 条意见` : item.recordPath ? '正式记录待检查' : '尚无正式意见'}</Tag>{item.hasDraft && <Tag color="warning">有未正式保存的草稿</Tag>}
          {item.updatedAt && <time dateTime={item.updatedAt}>最近活动 · {new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}</time>}</div>
        {item.errors.map(value => <p className="history-warning" key={value}>{value}</p>)}
        <div className="history-item-actions"><Button size="small" icon={<FolderOpenOutlined />} disabled={!online || !!opening} loading={opening === `${item.recordPath ? 'record' : 'draft'}-${item.fingerprint}`} onClick={() => void open(item.recordPath ? 'record' : 'draft', item.fingerprint)}>打开记录文件夹</Button>
          {item.referencesDirectory && <Button size="small" disabled={!online || !!opening} onClick={() => void open('references', item.fingerprint)}>打开参考图文件夹</Button>}
          <details><summary>查看保存位置</summary>{item.recordPath && <p>正式意见：{item.recordPath}</p>}{item.referencesDirectory && <p>参考截图：{item.referencesDirectory}</p>}{item.workspacePath && <p>恢复副本：{item.workspacePath}</p>}</details></div>
      </li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>还没有校对历史</strong><p>打开素材后，已保留的草稿或正式保存的意见会出现在这里。</p></>} />}
    </div>
    <p className="history-foot">这里保存校对意见，不是剪辑后的新视频。尚未回传的浏览器草稿暂不列入历史。</p>
  </section>;
}
