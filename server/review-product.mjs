import path from 'node:path';
import { ReviewError, UI_REVISION, atomicJson, readJson } from './runtime.mjs';
import { bundledTools } from './media-analysis.mjs';
import { taskIdentity } from './review-tasks.mjs';

export async function productRoute(service, pathname, body, context) {
  const { tasks, progress } = service;
  if (pathname === '/api/tasks/organize') {
    const ids = body.taskIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new ReviewError('每次可整理 1–50 项任务', 'invalid_task', 400);
    const results = [];
    for (const id of ids) {
      try {
        taskIdentity(id);
        if (body.action === 'archive' && service.clients.taskUse(id).windows) throw new ReviewError('任务仍在窗口中打开，请先挂起后再归档', 'task_in_use');
        const task = await tasks.organize(id, body.action, body.title);
        if (body.action === 'archive') for (const job of Object.values(task.jobs)) await service.queue.cancel(job, id);
        results.push({ id, ok: true, task });
      } catch (cause) { results.push({ id, ok: false, message: cause.message }); }
    }
    return { results };
  }
  if (pathname === '/api/tasks/versions') {
    const versions = tasks.versions(body.taskId);
    const bundles = await Promise.all(versions.map(async task => {
      try { return await progress.bundle(task.id); }
      catch { return { task, unavailable: true, message: '这版意见或进度暂不可读，原资料保留' }; }
    }));
    return { versions: bundles };
  }
  if (pathname === '/api/progress/load') return progress.bundle(body.taskId);
  if (pathname === '/api/progress/update') return { progress: await progress.update(body, context, service.clients) };
  if (pathname === '/api/progress/acknowledge') return { progress: await progress.acknowledge(body) };
  if (pathname === '/api/progress/check') return { progress: await progress.check(body) };
  if (pathname === '/api/handoff/create') {
    const task = await tasks.read(body.taskId);
    await service.scope(context, task.media.fingerprint, true);
    if (context?.taskId !== body.taskId) throw new ReviewError('只能交接当前任务', 'task_conflict');
    return progress.snapshot(body.taskId, body.revision);
  }
  if (pathname === '/api/handoff/read') return progress.record(body.taskId, body.revision);
  if (pathname === '/api/transcript/load' || pathname === '/api/transcript/save') {
    const task = await tasks.read(body.taskId);
    const file = path.join(await tasks.directoryFor(task.id), 'transcript.json');
    if (pathname.endsWith('/save')) {
      if (context?.taskId !== task.id) throw new ReviewError('字幕与当前任务不符', 'task_conflict');
      await service.scope(context, task.media.fingerprint, true);
      const { cues, name } = body;
      if (typeof name !== 'string' || name.length > 255 || /[\0/\\]/u.test(name) || !Array.isArray(cues) || !cues.length || cues.length > 2000 || cues.some(cue => !Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > 172800000 || typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 2000)) throw new ReviewError('字幕内容或时间无效', 'invalid_transcript', 400);
      const value = { format: 'media-review-transcript/v1', fingerprint: task.media.fingerprint, name, cues: cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), at: new Date().toISOString() };
      await atomicJson(file, value); return { transcript: value };
    }
    try {
      const transcript = await readJson(file, 1024 * 1024);
      if (transcript.format !== 'media-review-transcript/v1' || transcript.fingerprint !== task.media.fingerprint) throw new ReviewError('字幕记录与本版不符，原文件保留');
      return { transcript };
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; return { transcript: null }; }
  }
  if (pathname === '/api/session/readiness') {
    const tools = await bundledTools(service.root).catch(() => null);
    const available = async fn => { try { return !!await fn?.(); } catch { return false; } };
    const [ffmpeg, whisper, model] = await Promise.all([available(tools?.ffmpeg), available(tools?.whisper), available(tools?.model)]);
    const metadata = await readJson(path.join(service.root, 'package.json'), 100000).catch(() => ({}));
    return { runtime: UI_REVISION, baseVersion: metadata.version ?? '未知', localRevision: metadata.localRevision ?? null, node: process.versions.node, ffmpeg, whisper, model, host: [...tasks.headers.values()].some(task => !task.manual) ? '本机已有 Agent 送片记录；当前对话是否已加载 Skill 需由宿主确认' : '尚无 Agent 送片记录，可由当前对话调用 after-export', playback: '取决于浏览器能否解码当前文件；打开文件后实际检查', publication: metadata.localRevision ? '本机定制版本；此页面不查询 GitHub 最新版本' : '公开版源码／发行包；此页面不查询 GitHub 最新版本', toolsHelp: '用安装入口连接现有媒体工具，或由 Agent 执行 doctor 排查；不会自动下载安装。' };
  }
  return null;
}
