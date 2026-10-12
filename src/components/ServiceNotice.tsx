import { Alert, Button, Tooltip } from 'antd';
import { PoweroffOutlined } from '@ant-design/icons';
import type { NativeLauncher } from '../lib/api';
import type { ServiceState } from '../lib/use-service-status';

const NOTICE = {
  reconnecting: { title: '连接暂慢，正在重新检查', reason: '单次超时不代表进程已停止；连接确认前不能保存。' },
  offline: { title: '暂时无法连接，当前不能确认保存', reason: '本机服务连续未响应。可能已退出，也可能仍暂不可达；可以从桌面入口核验并按需重开。' },
  incompatible: { title: '连接身份或版本不匹配，请从当前入口重开', reason: '不会把旧页面直接当作有效编辑会话，也没有覆盖当前输入。' },
  restarted: { title: '服务已重新出现，正在核验新会话', reason: '核对身份、版本与认证后再恢复编辑；本页输入不清空，保存仍会检查意见版本。' },
};

export function ServiceRecoveryButton({ state, launcher, waiting, onStart, compact = false }: { state: ServiceState; launcher: NativeLauncher | null; waiting: boolean; onStart: () => boolean; compact?: boolean }) {
  const canStart = state !== 'incompatible' && !!launcher?.available && !!launcher.uri && /^media-review-[a-f0-9]{64}:\/\/start$/u.test(launcher.uri);
  const explanation = state === 'incompatible' ? '版本或身份不匹配时不强行重启；请保留输入，从当前桌面入口核对。' : canStart ? '请求Windows打开“启动 Media Review 本机音视频校对室”；已停止则启动，仍在运行则核验并复用，不上传素材。浏览器可能要求确认。' : launcher?.reason ?? '尚未确认已配置的本机入口；请从完整包安装器配置，或使用桌面入口。';
  const label = compact ? '重启服务' : '启动 Media Review 本机校对室';
  return <Tooltip title={explanation}><span className="service-recovery-control"><Button type={compact ? 'default' : 'primary'} icon={<PoweroffOutlined aria-hidden />} href={canStart ? launcher!.uri! : undefined} disabled={!canStart} loading={waiting} aria-label={label} aria-busy={waiting} onClick={event => { if (!canStart || waiting || !onStart()) event.preventDefault(); }}>{label}</Button></span></Tooltip>;
}

export function ServiceNotice({ state, launcher, waiting, onStart }: { state: ServiceState; launcher: NativeLauncher | null; waiting: boolean; onStart: () => boolean }) {
  if (state === 'online' || state === 'connecting') return null;
  const notice = NOTICE[state], critical = state === 'offline' || state === 'incompatible';
  const canStart = launcher?.available && launcher.uri && /^media-review-[a-f0-9]{64}:\/\/start$/u.test(launcher.uri) && state !== 'incompatible';
  return <Alert className={`service-notice service-connection-notice ${critical ? 'is-critical' : 'is-reconnecting'}`} role="alert"
    type={critical ? 'error' : 'warning'} showIcon title={waiting ? '正在等待 Media Review 恢复连接' : notice.title} description={<>
      <p>{notice.reason} 当前文字仍在本页，<strong>请不要关闭或刷新。</strong></p>
      {canStart ? <><ServiceRecoveryButton state={state} launcher={launcher} waiting={waiting} onStart={onStart} />
        <p>请求 Windows 打开“启动 Media Review 本机音视频校对室”，由它启动本机 Node.js 服务，不上传素材。浏览器可能要求确认；成功与否以实际连接检查为准。</p></> : <p>{launcher?.reason ?? '尚未确认已安装的页面启动入口。'} 未注册入口时，请从完整包安装器配置；不能只复制 Skill 文本。</p>}
      <p className="service-reopen-step"><strong>备用入口：</strong>双击桌面的“Media Review”，或使用“打开 Media Review.cmd”。若安全软件阻止，请核对安装来源与拦截详情，不要关闭防护。</p>
    </>} />;
}
