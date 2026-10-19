import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execute, say, dataRoot, ordinaryDirectory, ordinaryFile, readObject, atomicJson, findCommand, hashFile, provision, resolvePackage, validatePackage } from './setup-support.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await fs.readFile(new URL('./setup-dependencies.json', import.meta.url), 'utf8'));
const importFile = file => import(pathToFileURL(file).href);
async function run(executable, args, options = {}) {
  return execute(executable, args, { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, ...options });
}
async function probe(file, args, check = () => true) {
  if (!await ordinaryFile(file)) return false;
  try { const result = await run(file, args); return check(result.stdout + result.stderr); } catch { return false; }
}
export async function selectExistingTool({ override, configured, discover, managed, usable, acquire }) {
  if (override) {
    if (!await usable(override)) throw new Error('指定的工具不能运行，原配置保留；请 Agent 核对该路径。');
    return { file: override, reused: true };
  }
  if (configured && await usable(configured)) return { file: configured, reused: true };
  const found = await discover?.();
  for (const file of new Set([found, managed].filter(Boolean))) {
    if (file !== configured && await usable(file)) return { file, reused: true };
  }
  const file = await acquire();
  if (!await usable(file)) throw new Error('准备的工具仍不可用，保留现有文件；请 Agent 修复这一项，不重复安装整套环境。');
  return { file, reused: false };
}
export function mergedTools(previous, selected) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('工具配置格式错误，未修改。');
  return { ...previous, ...selected };
}
export function subtitleCheck(srt, durationMs) {
  const cues = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\s*\n([^\n]+)/gu)];
  if (!cues.length || !/字幕/u.test(srt) || !/测试|測試/u.test(srt)) throw new Error('测试语音没有得到预期中文字幕，转写尚未验证。');
  let previous = 0;
  for (const cue of cues) {
    const time = offset => Number(cue[offset]) * 3600000 + Number(cue[offset + 1]) * 60000 + Number(cue[offset + 2]) * 1000 + Number(cue[offset + 3]);
    const start = time(1), end = time(5);
    if (start < previous || end <= start || end > durationMs + 250) throw new Error('测试字幕时间码无效，转写尚未验证。');
    previous = end;
  }
  return cues.length;
}
async function setupLock(local) {
  const file = path.join(local, 'setup.lock');
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = await readObject(file);
    if (!Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error('首次准备记录异常，原记录保留。');
    try { process.kill(old.pid, 0); throw new Error('另一个 Agent 正在准备校对台；请等待其完成后重试同一入口。'); }
    catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
    await fs.unlink(file); handle = await fs.open(file, 'wx');
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  return async () => { await handle.close(); await fs.unlink(file); };
}
async function stableBootstrap(args) {
  if (await hashFile(process.execPath) !== pins.node.sha256) throw new Error('Node.js 校验不匹配，未采用。');
  const directory = await ordinaryDirectory(path.join(dataRoot(), `runtime/node-${pins.node.version}`));
  const target = path.join(directory, 'node.exe');
  if (!await ordinaryFile(target)) await fs.copyFile(process.execPath, target, (await import('node:fs')).constants.COPYFILE_EXCL);
  if (await hashFile(target) !== pins.node.sha256) throw new Error('已有便携 Node.js 内容不匹配，原样保留。');
  await new Promise((resolve, reject) => {
    const child = spawn(target, [fileURLToPath(import.meta.url), ...args.filter(arg => arg !== '--bootstrap-node')], { windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('首次准备尚未完成，见上方具体原因。')));
  });
}
export async function prepare(args = process.argv.slice(2)) {
  if (args[0] === '--agent-cli') {
    const pkg = await resolvePackage(skillRoot, pins.release);
    const { runAgentCLI } = await importFile(path.join(pkg, 'app/scripts/review-agent.mjs'));
    await runAgentCLI(args.slice(1)); return;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('自动准备当前支持 Windows x64；其他系统未做同等验证。');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请通过 scripts/first-use.cmd 自动准备 Node.js 24。');
  if (args.includes('--bootstrap-node')) return stableBootstrap(args);
  const flags = new Set(['--no-browser', '--skip-page-launcher', '--install', '--verify']);
  const values = new Set(['--destination', '--desktop-dir', '--desktop-name', '--data-dir', '--ffmpeg', '--whisper', '--model']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error(`首次准备参数无效：${key}`);
  }
  if (options['--destination'] && !options['--install']) throw new Error('--destination 只用于 --install。');
  if (options['--data-dir']) {
    if (!path.isAbsolute(options['--data-dir'])) throw new Error('--data-dir 必须是绝对路径。');
    process.env.MEDIA_REVIEW_DATA_DIR = options['--data-dir'];
  }
  const root = dataRoot(), local = await ordinaryDirectory(path.join(root, 'data'));
  const releaseLock = await setupLock(local);
  let phase = 'package';
  try {
    let receipt = await readObject(path.join(local, 'setup.json')).catch(() => null);
    say(receipt?.verification?.passed
      ? '正在检查已有程序、工具路径和配置；有效的直接复用，只修复缺失或失效的项目。'
      : '首次准备会先检查本机环境；缺少的运行组件、音视频工具或语音模型可能需要联网下载和配置。全缺时约下载 0.8 GB，之后会复用，不会每次重装。');
    let pkg = await resolvePackage(skillRoot, pins.release, true);
    await validatePackage(pkg, pins.release);
    const runtime = await ordinaryDirectory(path.join(root, 'runtime'));
    phase = 'powershell';
    const usablePowerShell = file => probe(file, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], value => Number(value.trim()) >= 7);
    const { file: pwsh } = await selectExistingTool({
      configured: receipt?.runtime?.pwsh,
      discover: () => findCommand('pwsh', usablePowerShell),
      managed: path.join(runtime, `powershell-${pins.powershell.version}`, pins.powershell.entry),
      usable: usablePowerShell, acquire: () => provision('powershell', pins.powershell, runtime),
    });
    const configFile = path.join(local, 'tools.json');
    const configExists = await fs.lstat(configFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const previous = configExists ? await readObject(configFile) : {};
    const configBytes = configExists ? await fs.readFile(configFile) : null;
    const selected = {}, reused = [], prepared = [];
    for (const [key, command, override, checkArgs, check] of [
      ['ffmpeg', 'ffmpeg', '--ffmpeg', ['-version'], value => /ffmpeg version/u.test(value)],
      ['whisper_cpu', 'whisper-cli', '--whisper', ['--help'], value => /--model|\s-m\s/u.test(value)],
      ['model', null, '--model', null, null],
    ]) {
      phase = key;
      const usable = async file => {
        const valid = checkArgs ? await probe(file, checkArgs, check) : await ordinaryFile(file);
        return valid && (key !== 'ffmpeg' || await probe(path.join(path.dirname(file), 'ffprobe.exe'), ['-version'], value => /ffprobe version/u.test(value)));
      };
      const choice = await selectExistingTool({
        override: options[override] ? path.resolve(options[override]) : null,
        configured: previous[key], discover: command ? () => findCommand(command, usable) : null,
        managed: path.join(runtime, `${key}-${pins[key].version}`, pins[key].entry), usable,
        acquire: () => provision(key, pins[key], runtime),
      });
      (choice.reused ? reused : prepared).push(key);
      say(`${choice.reused ? '检查通过，复用已有' : '已补齐'}${key === 'model' ? '语音模型' : key}。`);
      selected[key] = choice.file;
    }
    const candidate = mergedTools(previous, selected);
    const sample = path.join(pkg, 'assets/setup-speech.wav');
    const facts = [];
    for (const file of [process.execPath, ...Object.values(selected), path.join(path.dirname(selected.ffmpeg), 'ffprobe.exe')]) {
      if (!await ordinaryFile(file)) throw new Error('工具或自检样本不可读，原配置保留。');
      const stat = await fs.stat(file); facts.push([await fs.realpath(file), stat.size, stat.mtimeMs]);
    }
    const signature = createHash('sha256').update(JSON.stringify({ version: pins.release, facts, sample: await hashFile(sample) })).digest('hex');
    let verification;
    if (!options['--verify'] && receipt?.signature === signature && receipt.verification?.passed) verification = { ...receipt.verification, reused: true };
    else {
      phase = 'transcription'; say('正在用随包中文语音实测：解码、波形、字幕内容和时间码。');
      const { stdout } = await run(path.join(path.dirname(selected.ffmpeg), 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', sample]);
      const durationMs = Math.round(Number(stdout.trim()) * 1000);
      if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 20000) throw new Error('自检样本时长异常。');
      const { MediaAnalysisService } = await importFile(path.join(pkg, 'app/server/media-analysis.mjs'));
      const service = new MediaAnalysisService(path.join(pkg, 'app'), { tools: { ffmpeg: async () => selected.ffmpeg, whisper: async () => selected.whisper_cpu, model: async () => selected.model } });
      const events = [], start = performance.now();
      try { await service.fromFile(sample, durationMs, event => events.push(event), AbortSignal.timeout(120_000)); }
      finally { clearInterval(service.interval); }
      const failure = events.find(event => /error|cleanup-warning/u.test(event.kind));
      const srt = events.find(event => event.kind === 'transcript')?.srt ?? '';
      if (failure) throw new Error(`字幕自检未完成：${failure.message}`);
      if (!events.some(event => event.kind === 'wave' && event.peaks.some(value => value > 0))) throw new Error('自检没有得到真实波形。');
      const cues = subtitleCheck(srt, durationMs);
      verification = { passed: true, at: new Date().toISOString(), durationMs, cues, elapsedMs: Math.round(performance.now() - start), reused: false };
    }
    phase = 'configuration';
    // Another editor of tools.json must not be silently overwritten while downloads run.
    const nowBytes = await fs.readFile(configFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (configBytes?.toString() !== nowBytes?.toString()) throw new Error('准备期间工具配置被其他操作修改，原配置保留；重新运行即可复用已下载工具。');
    if (JSON.stringify(previous) !== JSON.stringify(candidate)) {
      if (configBytes) await fs.writeFile(path.join(local, `tools.before-setup-${Date.now()}-${randomUUID().slice(0, 8)}.json`), configBytes, { flag: 'wx' });
      await atomicJson(configFile, candidate);
    }
    phase = 'desktop';
    const installArgs = ['-NoProfile', '-File', path.join(pkg, 'scripts/install.ps1')];
    if (options['--install']) {
      const target = options['--destination'] ? path.resolve(options['--destination']) : path.join((await import('node:os')).homedir(), '.claude/skills/media-review');
      installArgs.push('-Destination', target); options.installedTo = target;
    } else installArgs.push('-InitializeOnly');
    if (options['--desktop-dir']) installArgs.push('-DesktopDirectory', path.resolve(options['--desktop-dir']));
    if (options['--desktop-name']) installArgs.push('-DesktopName', options['--desktop-name']);
    if (options['--skip-page-launcher']) installArgs.push('-SkipPageLauncher');
    await run(pwsh, installArgs, { timeout: 120_000, env: { ...process.env, PATH: `${path.dirname(process.execPath)};${path.dirname(pwsh)};${process.env.PATH ?? ''}` } });
    if (options.installedTo) pkg = options.installedTo;
    receipt = { format: 'media-review-setup/v1', version: pins.release, signature, runtime: { node: process.execPath, pwsh }, verification, reusedTools: reused, preparedTools: prepared };
    await atomicJson(path.join(local, 'setup.json'), receipt);
    phase = 'browser';
    const { openReview } = await importFile(path.join(pkg, 'app/server/open.mjs'));
    const opened = await openReview({ rootDir: path.join(pkg, 'app'), browser: !options['--no-browser'] });
    say(verification.reused ? '工具和此前真实字幕测试仍匹配；本机校对台已就绪。' : '真实中文字幕测试通过；临时音轨和字幕已清理，本机校对台已就绪。');
    const result = { ...receipt, ready: true, packageRoot: pkg, node: process.execPath, pwsh, reviewEntry: path.join(options['--install'] ? pkg : skillRoot, 'scripts/review.cmd'), url: opened.url, browser: opened.browser };
    console.log(JSON.stringify(result)); return result;
  } catch (error) {
    throw new Error(`首次准备停在 ${phase}：${error.message}。Agent 应处理这个具体问题后重试；不要把整套下载配置交回用户。`);
  } finally { await releaseLock(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
