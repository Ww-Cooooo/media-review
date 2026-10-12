import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UI_REVISION, pathIdentity, readJson } from './runtime.mjs';

const execute = promisify(execFile);
export const LAUNCHER_NAME = '启动 Media Review 本机音视频校对室';
export const launcherScheme = local => `media-review-${pathIdentity(local)}`;
export const launcherUri = local => `${launcherScheme(local)}://start`;
const quoteArgument = value => `"${value.replace(/\\+$/u, ending => ending + ending)}"`;
export const launcherCommand = (node, root, dataRoot) => `${quoteArgument(node)} ${quoteArgument(path.join(root, 'server/native-start.mjs'))} --data-dir ${quoteArgument(dataRoot)} "%1"`;

export function parseLauncherArguments(args) {
  if (args.length !== 3 || args[0] !== '--data-dir' || !path.isAbsolute(args[1]) || /["\r\n\0]/u.test(args[1]) || (args[2] !== launcherUri(path.join(args[1], 'data')) && args[2] !== launcherUri(path.join(args[1], 'data')) + '/')) throw new Error('Media Review启动入口只接受本数据根的固定启动动作，不执行网址中的命令或文件路径。');
  return path.resolve(args[1]);
}

async function registeredCommand(scheme) {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\${scheme}'); if ($null -ne $k) { try { if ($k.GetValue('MediaReviewOwner') -eq 'media-review-native-launcher/v1' -and $k.GetValueNames().Contains('URL Protocol')) { $c=$k.OpenSubKey('shell\\open\\command'); if ($null -ne $c) { try { [Console]::Write($c.GetValue('')) } finally { $c.Dispose() } } } } finally { $k.Dispose() } }`;
  return (await execute('pwsh', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 8192 })).stdout;
}

export async function readNativeLauncher(local, { platform = process.platform, registryReader = registeredCommand } = {}) {
  const unavailable = reason => ({ available: false, uri: null, name: LAUNCHER_NAME, reason });
  if (platform !== 'win32') return unavailable('页面唤起入口目前仅支持Windows；请使用本机启动文件。');
  try {
    const value = await readJson(path.join(local, 'native-launcher.json'), 8192);
    if (value.format !== 'media-review-native-launcher/v1' || value.uiRevision !== UI_REVISION || !path.isAbsolute(value.dataRoot) || pathIdentity(path.join(value.dataRoot, 'data')) !== pathIdentity(local) || !path.isAbsolute(value.runtimeRoot) || !path.isAbsolute(value.node)) return unavailable('本机启动登记与当前版本或资料根不匹配，请用新版安装器明确配置。');
    for (const file of [value.node, path.join(value.runtimeRoot, 'server/native-start.mjs')]) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) return unavailable('启动入口已移动或不是普通文件，请重新核对安装。');
    }
    if (await registryReader(launcherScheme(local)) !== launcherCommand(value.node, value.runtimeRoot, value.dataRoot)) return unavailable('Windows启动协议未注册或已变化；请用安装器重新配置，不关闭安全防护。');
    return { available: true, uri: launcherUri(local), rootId: pathIdentity(value.runtimeRoot), name: LAUNCHER_NAME, reason: '请求Windows启动本机Media Review的Node.js服务，不上传素材；浏览器可能要求确认。' };
  } catch { return unavailable('尚未确认本机启动入口；请用完整包安装器配置，或从桌面／启动文件重开。'); }
}
