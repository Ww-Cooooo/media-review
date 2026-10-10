import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { openReview } from '../server/open.mjs';
import { bundledTools } from '../server/media-analysis.mjs';
import { identifyFile } from '../server/review-workflow.mjs';
import { runtimePaths, ordinaryDirectory, atomicJson } from '../server/runtime.mjs';
import { exportReview } from '../server/review-export.mjs';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function selfCheck(root, source) {
  const media = await identifyFile(source), location = await runtimePaths(root), tools = await bundledTools(root);
  const ffmpeg = await tools.ffmpeg();
  const directory = await ordinaryDirectory(path.join(location.local, 'self-checks', media.fingerprint, randomUUID()));
  const report = { format: 'media-review-self-check/v1', origin: 'agent', userApproved: false, media: { name: media.name, fingerprint: media.fingerprint, size: media.size }, status: 'limited', decodePassed: false, durationSeconds: null, dimensions: null, blackIntervals: [], silenceEvents: [], frames: [], notVerified: ['画面美感与文字是否清楚，需要Agent实际看帧／播放核对', '台词含义、专有词、事实与声音听感未自动核实', '自检不代表用户认可，不进入用户意见清单'] };
  if (ffmpeg) {
    try {
      const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const metadata = JSON.parse((await execute(ffprobe, ['-v','error','-show_streams','-show_format','-of','json', media.source], { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 })).stdout);
      const video = metadata.streams?.find(stream => stream.codec_type === 'video');
      report.durationSeconds = Number(metadata.format?.duration) || null;
      report.dimensions = video ? { width: video.width, height: video.height } : null;
      const filters = [...(video ? ['-vf','blackdetect=d=0.2:pix_th=0.10'] : []), ...(metadata.streams?.some(stream => stream.codec_type === 'audio') ? ['-af','silencedetect=noise=-45dB:d=0.8'] : [])];
      const result = await execute(ffmpeg, ['-hide_banner','-nostdin','-v','info','-i',media.source,...filters,'-f','null','-'], { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      report.decodePassed = true; report.status = 'evidence-ready';
      for (const match of result.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/gu)) report.blackIntervals.push({ start: +match[1], end: +match[2], duration: +match[3] });
      for (const match of result.stderr.matchAll(/silence_(start|end):\s*([\d.]+)/gu)) report.silenceEvents.push({ event: match[1], seconds: +match[2] });
      if (video && report.durationSeconds) {
        for (const [index, fraction] of [.12,.5,.88].entries()) {
          const seconds = Math.max(0, Math.min(report.durationSeconds - .05, report.durationSeconds * fraction));
          const file = `frame-${index + 1}.jpg`;
          await execute(ffmpeg, ['-hide_banner','-nostdin','-v','error','-ss',String(seconds),'-i',media.source,'-frames:v','1','-vf',"scale='min(1280,iw)':-2",'-n',path.join(directory,file)], { timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 });
          report.frames.push({ seconds, file });
        }
      }
    } catch { report.status = 'needs-check'; report.notVerified.unshift('媒体工具未完成全部检查；不能据此宣布自检通过'); }
  } else report.notVerified.unshift('未找到本机FFmpeg；播放和手动校对可用，解码／取帧自检未执行');
  const file = path.join(directory, 'self-check.json'); await atomicJson(file, report);
  return { ...report, reportPath: file, frameDirectory: directory };
}

export async function runAgentCLI(args = process.argv.slice(2), root = ROOT) {
  const command = args[0] ?? 'open';
  const option = name => { const index=args.indexOf(name); return index<0?null:args[index+1]; };
  const media = option('--media');
  if (command === 'after-export' || command === 'self-check') {
    if (!media) throw new Error('需要--media明确指定已经导出的成片');
    const opened = await openReview({ rootDir:root, media, browser:command==='after-export' && !args.includes('--no-browser') });
    const inspection = await selfCheck(root,media);
    console.log(JSON.stringify({ ...opened, inspection })); return;
  }
  if (command === 'open') { console.log(JSON.stringify(await openReview({ rootDir:root, media, browser:!args.includes('--no-browser') }))); return; }
  if (command === 'export') { const fingerprint=option('--fingerprint'),out=option('--out'); if(!fingerprint||!out) throw new Error('导出需要--fingerprint与新建的--out目录'); console.log(JSON.stringify(await exportReview(root,fingerprint,out))); return; }
  if (command === 'doctor') {
    const tools=await bundledTools(root); const available=async fn=>{try{return !!await fn();}catch{return false;}};
    console.log(JSON.stringify({ node:process.versions.node, ffmpeg:await available(tools.ffmpeg), whisper:await available(tools.whisper), model:await available(tools.model), localOnly:true })); return;
  }
  throw new Error('支持open、after-export、self-check、export、doctor；不会下载软件或执行任意命令');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAgentCLI().catch(cause=>{ console.error(cause.message); process.exitCode=1; });
