import { Alert } from 'antd';
import type { ServiceState } from '../lib/use-service-status';

const NOTICE = {
  reconnecting: { title: '连接中断，正在尝试重连', reason: '连接恢复前，暂时无法确认保存。' },
  offline: { title: '服务已断开，当前无法保存', reason: '本机校对服务没有响应，需要重新打开校对室。' },
  incompatible: { title: '连接版本已失效，请重新打开校对室', reason: '当前页面与服务版本不一致，不能继续保存；这不是正常连接状态。' },
  restarted: { title: '会话已失效，请重新打开校对室', reason: '本机服务已重启，当前旧页面无法确认保存。' },
};

export function ServiceNotice({ state }: { state: ServiceState }) {
  if (state === 'online' || state === 'connecting') return null;
  const notice = NOTICE[state], critical = state !== 'reconnecting';
  const entry = '打开 Media Review.cmd';
  return <Alert className={`service-notice service-connection-notice ${critical ? 'is-critical' : 'is-reconnecting'}`} role="alert"
    type={critical ? 'error' : 'warning'} showIcon title={notice.title} description={<>
      <p>{notice.reason} 当前文字仍在本页，<strong>请不要关闭或刷新。</strong></p>
      <p className="service-reopen-step"><strong>重新打开：</strong>双击桌面的“Media Review”，或使用“{entry}”重新进入。</p>
    </>} />;
}
