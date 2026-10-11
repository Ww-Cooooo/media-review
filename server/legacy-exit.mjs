import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runtimePaths, readJson, ReviewError } from './runtime.mjs';

// 仅为已发布beta.1的升级提供明确退出入口；不猜PID、不扫描重复服务、不自动升级。
export async function exitLegacy(legacyRoot, confirm = false) {
  if (typeof legacyRoot !== 'string' || !path.isAbsolute(legacyRoot)) throw new ReviewError('需要--legacy-root明确指定旧包app目录的绝对路径', 'legacy_identity', 400);
  const root = await fs.realpath(legacyRoot), location = await runtimePaths(root);
  const entry = await readJson(location.session, 8192);
  const rootId = createHash('sha256').update(root.replaceAll('\\', '/').toLowerCase()).digest('hex');
  if (entry.app !== 'ai-carry-media-review' || entry.rootId !== rootId || entry.uiRevision !== 'history-20261009-r2' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(entry.url)) throw new ReviewError('旧版登记与实际目录／已知beta.1身份不符，没有关闭任何服务', 'legacy_identity');
  const probe = async () => {
    const response = await fetch(`${entry.url}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    if (!response.ok || !health.ok || health.app !== entry.app || health.rootId !== rootId || health.runtimeId !== entry.runtimeId || health.uiRevision !== entry.uiRevision || health.protocol !== undefined) throw new ReviewError('该地址不再是已核对的旧服务，没有发送退出', 'legacy_identity');
    return health;
  };
  await probe();
  if (!confirm) return { requiresConfirmation: true, root, url: entry.url, warning: '旧版不能报告各窗口的未保存状态。请先在旧页保存；明确--confirm才退出此登记服务，不会关闭浏览器，也不能发现未登记的旧重复服务。' };
  const response = await fetch(entry.url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536) throw new ReviewError('旧页面未读回，未发送退出', 'legacy_identity');
  const html = await response.text();
  if (html.length > 65536) throw new ReviewError('旧页面身份未确认，未发送退出', 'legacy_identity');
  const token = /window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!token) throw new ReviewError('旧会话认证未确认，未发送退出', 'legacy_identity');
  await probe();
  const closed = await fetch(`${entry.url}/api/session/close`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Origin: entry.url, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: '{}' });
  if (!closed.ok || (await closed.json()).closed !== true) throw new ReviewError('旧版退出请求未确认，请保留旧页；没有杀进程', 'legacy_exit_failed');
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try { await probe(); }
    catch (cause) {
      if (cause.cause?.code === 'ECONNREFUSED') return { requested: true, verifiedNotListening: true, retained: true, scope: '仅这个已登记的beta.1地址已不接受连接；不代表所有旧副本或独立CLI工具已退出' };
      if (cause instanceof ReviewError) return { requested: true, verifiedNotListening: false, retained: true, message: '原地址的服务身份发生变化，未再发送退出；请核对旧副本，不要混跑版本。' };
    }
  }
  return { requested: true, verifiedNotListening: false, retained: true, message: '已请求退出，但尚未确认原地址停止接受连接，请勿据此混跑两个版本。' };
}
