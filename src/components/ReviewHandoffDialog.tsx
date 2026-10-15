import { Alert, Button, Input, Modal, Tag } from 'antd';
import { ArrowLeftOutlined, CheckOutlined, CopyOutlined, HomeOutlined } from '@ant-design/icons';
import { formatTime } from '../lib/review';
import type { ReviewHandoff } from '../lib/review-handoff';

interface Props {
  handoff: ReviewHandoff | null;
  open: boolean;
  copied: boolean;
  copying: boolean;
  copyError: string;
  onCopy: () => void;
  onClose: () => void;
  onHome: () => void;
}

export function ReviewHandoffDialog({ handoff, open, copied, copying, copyError, onCopy, onClose, onHome }: Props) {
  const noChanges = handoff?.record.completion?.outcome === 'no-changes';
  return <Modal open={open && !!handoff} title={noChanges ? '本轮审阅完成，没有意见' : '意见已保存，可以交给 Agent 了'} width={760}
    className="review-handoff-dialog" centered onCancel={onClose}
    footer={<div className="handoff-footer"><div className="handoff-destinations"><Button icon={<ArrowLeftOutlined />} onClick={onClose}>返回当前素材</Button><Button icon={<HomeOutlined />} onClick={onHome}>回到主页</Button></div>
      <Button type="primary" loading={copying} icon={copied ? <CheckOutlined aria-hidden="true" /> : <CopyOutlined aria-hidden="true" />} onClick={onCopy}>
        {copied ? '已复制，回聊天粘贴发送' : '复制交接内容'}
      </Button></div>}>
    {handoff && <>
      <p className="handoff-instruction">复制下面的内容，回到 Agent 聊天中粘贴并发送。发送后才会交给 Agent 处理，这里不会自动启动剪辑。</p>
      <div className="handoff-summary"><strong>{handoff.record.media.name}</strong>
        <div><Tag color="success" icon={<CheckOutlined aria-hidden="true" />}>已保存并回读核对</Tag><span>{noChanges ? '已审阅 · 没有意见' : handoff.record.notes.length + ' 条意见'} · {formatTime(handoff.record.media.durationMs, false)}</span></div>
        <dl><dt>本次保存</dt><dd>{new Date(handoff.savedAt).toLocaleString('zh-CN', { hour12: false })}</dd>
          <dt>记录位置</dt><dd className="handoff-record-path">{handoff.recordPath}</dd></dl>
      </div>
      <label className="handoff-text-label" htmlFor="review-handoff-text">交给 Agent 的完整请求</label>
      <Input.TextArea id="review-handoff-text" aria-label="交给 Agent 的完整请求" readOnly value={handoff.text}
        autoSize={{ minRows: 7, maxRows: 11 }} onFocus={event => event.currentTarget.select()} />
      {copyError && <Alert className="handoff-copy-error" type="warning" showIcon title="自动复制未成功" description={copyError} />}
      <p className="handoff-copy-status" role="status">{copied ? '已复制到剪贴板。请回到聊天粘贴并发送；尚未发送给 Agent。' : '也可以点击上方文字全选，手动复制；已保存的记录不会受影响。'}</p>
    </>}
  </Modal>;
}
