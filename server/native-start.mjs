import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLauncherArguments, LAUNCHER_NAME } from './native-launcher.mjs';
import { runtimePaths, readJson } from './runtime.mjs';
import { openReview } from './open.mjs';

export async function startFromNative(args, { rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const dataRoot = parseLauncherArguments(args);
  const root = await fs.realpath(rootDir);
  // 资料根来自安装时固定的命令参数，网址只能是本根的固定start动作。
  process.env.MEDIA_REVIEW_DATA_DIR = dataRoot;
  const location = await runtimePaths(root);
  if (!location.standalone) throw new Error('Media Review本机启动入口需要完整独立安装包。');
  let previousUrl = null;
  try { previousUrl = (await readJson(location.session, 8192)).url; }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const result = await openReview({ rootDir: root, browser: false });
  // 原端口无法复用时，旧页不能跨来源发现新地址；只在此时请求打开新入口。
  let browserRequested = false;
  if (previousUrl !== result.url) browserRequested = (await openReview({ rootDir: root, browser: true })).browser.requested === true;
  return { started: true, reused: result.reused, url: result.url, addressChanged: previousUrl !== result.url, browserRequested };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await startFromNative(process.argv.slice(2)); console.log(`${LAUNCHER_NAME}：${result.url}`); }
  catch (cause) { console.error(`${LAUNCHER_NAME}未完成：${cause.message}`); process.exitCode = 1; }
}
