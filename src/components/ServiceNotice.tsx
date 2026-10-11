import { Alert } from 'antd';
import type { ServiceState } from '../lib/use-service-status';

const NOTICE = {
  reconnecting: { title: '连接暂慢，正在重新检查', reason: '单次超时不代表进程已停止；连接确认前不能保存。' },
  offline: { title: '暂时无法连接，当前不能确认保存', reason: '本机服务连续未响应。可能已退出，也可能仍暂不可达；可以从桌面入口核验并按需重开。' },
  incompatible: { title: '连接身份或版本不匹配，请从当前入口重开', reason: '不会把旧页面直接当作有效编辑会话，也没有覆盖当前输入。' },
  restarted: { title: '服务已重新出现，正在核验新会话', reason: '核对身份、版本与认证后再恢复编辑；本页输入不清空，保存仍会检查意见版本。' },
};

export function ServiceNotice({ state }: { state: ServiceState }) {
  if (state === 'online' || state === 'connecting') return null;
  const notice = NOTICE[state], critical = state === 'offline' || state === 'incompatible';
  const entry = '打开 Media Review.cmd';
  return <Alert className={`service-notice service-connection-notice ${critical ? 'is-critical' : 'is-reconnecting'}`} role="alert"
    type={critical ? 'error' : 'warning'} showIcon title={notice.title} description={<>
      <p>{notice.reason} 当前文字仍在本页，<strong>请不要关闭或刷新。</strong></p>
      <p className="service-reopen-step"><strong>重新打开：</strong>双击桌面的“Media Review”，或使用“{entry}”重新进入。</p>
    </>} />;
}
