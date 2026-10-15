import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bundledTools } from './media-analysis.mjs';
import { identifyFile } from './review-workflow.mjs';
import { runtimePaths, ordinaryDirectory, atomicJson } from './runtime.mjs';
import { runTool, ANALYSIS_THREADS } from './tool-runner.mjs';

export async function selfCheck(root, source, { signal, sampleTimesMs = [] } = {}) {
  const media = await identifyFile(source), location = await runtimePaths(root), tools = await bundledTools(root);
  const ffmpeg = await tools.ffmpeg();
  const directory = await ordinaryDirectory(path.join(location.local, 'self-checks', media.fingerprint, randomUUID()));
  const report = { format: 'media-review-self-check/v1', origin: 'agent', userApproved: false, media: { name: media.name, fingerprint: media.fingerprint, size: media.size }, status: 'limited', decodePassed: false, durationSeconds: null, dimensions: null, blackIntervals: [], silenceEvents: [], frames: [], coverage: { decode: 'full-file', requestedTimesMs: sampleTimesMs, sampledTimesMs: [], outsideTimesMs: [], dynamicPlayback: false, listening: false }, notVerified: ['画面美感与文字是否清楚，需要Agent实际看帧／播放核对', '台词含义、专有词、事实与声音听感未自动核实', '自检不代表用户认可，不进入用户意见清单'] };
  if (ffmpeg) {
    const execute = (executable, args, options) => runTool(executable, args, { ...options, signal });
    try {
      const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const metadata = JSON.parse((await execute(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', media.source], { timeout: 15_000, maxBuffer: 256 * 1024 })).stdout);
      const video = metadata.streams?.find(stream => stream.codec_type === 'video');
      report.durationSeconds = Number(metadata.format?.duration) || null;
      report.dimensions = video ? { width: video.width, height: video.height } : null;
      const filters = [...(video ? ['-vf', 'blackdetect=d=0.2:pix_th=0.10'] : []), ...(metadata.streams?.some(stream => stream.codec_type === 'audio') ? ['-af', 'silencedetect=noise=-45dB:d=0.8'] : [])];
      const result = await execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-threads', String(ANALYSIS_THREADS), '-filter_threads', String(ANALYSIS_THREADS), '-protocol_whitelist', 'file,pipe', '-i', media.source, ...filters, '-threads', String(ANALYSIS_THREADS), '-f', 'null', '-'], { timeout: 120_000 });
      report.decodePassed = true; report.status = 'evidence-ready';
      for (const match of result.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/gu)) report.blackIntervals.push({ start: +match[1], end: +match[2], duration: +match[3] });
      for (const match of result.stderr.matchAll(/silence_(start|end):\s*([\d.]+)/gu)) report.silenceEvents.push({ event: match[1], seconds: +match[2] });
      const points = report.durationSeconds ? [...new Set([...[.12,.5,.88].map(fraction => Math.round(report.durationSeconds * fraction * 1000)), ...sampleTimesMs.filter(time => time < report.durationSeconds * 1000)])].sort((a,b) => a-b) : [];
      report.coverage.outsideTimesMs = sampleTimesMs.filter(time => !report.durationSeconds || time >= report.durationSeconds * 1000);
      if (video && report.durationSeconds) for (const [index, point] of points.entries()) {
        const seconds = Math.max(0, Math.min(report.durationSeconds - .05, point / 1000));
        const file = `frame-${index + 1}.jpg`;
        await execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-threads', String(ANALYSIS_THREADS), '-filter_threads', String(ANALYSIS_THREADS), '-protocol_whitelist', 'file,pipe', '-ss', String(seconds), '-i', media.source, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-threads', String(ANALYSIS_THREADS), '-n', path.join(directory, file)], { timeout: 15_000, maxBuffer: 64 * 1024 });
        report.frames.push({ seconds, file }); report.coverage.sampledTimesMs.push(Math.round(seconds * 1000));
      }
    } catch {
      signal?.throwIfAborted();
      report.status = 'needs-check'; report.notVerified.unshift('媒体工具未完成全部检查；不能据此宣布自检通过');
    }
  } else report.notVerified.unshift('未找到本机FFmpeg；播放和手动校对可用，解码／取帧自检未执行');
  signal?.throwIfAborted();
  const file = path.join(directory, 'self-check.json'); await atomicJson(file, report);
  return { ...report, reportPath: file, frameDirectory: directory };
}
