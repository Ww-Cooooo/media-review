import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReview, connectReview } from '../server/open.mjs';
import { bundledTools } from '../server/media-analysis.mjs';
import { runtimePaths, readJson } from '../server/runtime.mjs';
import { exitLegacy } from '../server/legacy-exit.mjs';
import { ReviewTasks, taskIdentity } from '../server/review-tasks.mjs';
import { exportReview } from '../server/review-export.mjs';
import { ReviewProgress } from '../server/review-progress.mjs';
export { selfCheck } from '../server/self-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function runAgentCLI(args = process.argv.slice(2), root = ROOT) {
  const command = args[0] ?? 'open';
  const option = name => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name}需要一个明确值`);
    return args[index + 1];
  };
  const output = value => console.log(JSON.stringify(value));
  const media = option('--media'), taskId = option('--task');
  if (command === 'help' || args.includes('--help')) {
    output({ contract: 'media-review-agent/v2', commands: {
      'progress': '--task <ID> [--note <意见ID> --revision <意见修订> --state pending|clarify|changed --text <说明> --target <新版任务ID> --at <新版毫秒位置>]：未指定note时读回，Agent不能确认',
      'acknowledge': '--task <ID> --revision <修订> --agent <接手对话名> [--clarify <逗号分隔意见ID>] [--text <说明>]：固定轮次接手回执',
      'check-report': '--task <ID> --report <JSON路径>：记录实际检查范围、发现、未核实项、保留项',
      'versions': '--task <ID>：读回同作品版本、意见与处理状态',
      'round': '--task <ID> --revision <修订>：读取固定交接快照',
      'readiness': '查询运行版本、工具与宿主接入线索',
      'after-export': '--media <绝对路径> [--request-id <UUID>] [--label <来源>] [--previous-task <原版任务ID>] [--check-times <新版毫秒位置,位置>] [--no-browser]：登记独立任务并排队自检；快速返回，不表示已检查完成',
      'self-check': '同after-export，但默认不打开网页',
      'open': '[--task <已有taskId> | --media <绝对路径>] [--no-browser]：打开指定已有任务不新建；不指定任务时只打开共用校对室',
      'status': '--task <taskId> [--job <jobId>] [--result]：查实际任务与证据状态；完成后才读取结果',
      'tasks': '列出待校对任务，不读取意见正文',
      'cancel': '--task <taskId> --job <jobId>：只撤回本任务对分析的需求；其他共享调用者不受影响',
      'end-task': '--task <taskId> --confirm [--confirm-other-windows]：结束等待，不删除历史、不代表认可；存在其他窗口时需另外明确确认，不得代替用户关闭正在编辑的任务',
      'quit': '--confirm [--keep-drafts]：明确退出全局服务，先查看summary；不是Agent做完工作后的默认动作',
      'summary': '查看窗口、待校对任务与分析数量',
      'export': '--task <taskId> --fingerprint <指纹> --out <新的目录>；明确只导出旧全局资料可用--legacy并省略--task，不猜测同媒体的独立任务归属',
      'quit-legacy': '--legacy-root <旧包app绝对目录> [--confirm]：核对已登记beta.1；先在旧页保存，明确确认才退出，不发现／结束未知重复服务',
      'doctor': '本机可用性与上次有记录的退出原因诊断，不下载工具或模型',
    } }); return;
  }
  if (command === 'after-export' || command === 'self-check' || command === 'open') {
    if (command !== 'open' && !media) throw new Error('需要--media明确指定已经导出完毕的成片');
    const result = await openReview({ rootDir: root, media, taskId: command === 'open' ? taskId : null, browser: command !== 'self-check' && !args.includes('--no-browser'), forceBrowser: command === 'open', requestId: option('--request-id') ?? taskId, title: option('--title'), label: option('--label'), previousTaskId: option('--previous-task') ?? null, sampleTimesMs: option('--check-times')?.split(',').map(Number) ?? [], inspect: command !== 'open' });
    output(result); if (result.inspection?.state === 'not-queued') process.exitCode = 2;
    return;
  }
  if (command === 'export') {
    const fingerprint = option('--fingerprint'), out = option('--out');
    if (!fingerprint || !out) throw new Error('导出需要--fingerprint与新建的--out目录');
    const location = await runtimePaths(root);
    const tasks = await new ReviewTasks(location.local, location.reviews).init();
    if (!taskId && !args.includes('--legacy') && [...tasks.headers.values()].some(task => !task.legacy && task.media.fingerprint === fingerprint)) throw new Error('这份媒体存在独立任务，请用--task指定；明确只导出旧全局资料时需--legacy，未猜测归属');
    output(await exportReview(root, fingerprint, out, taskId ? await tasks.scope(taskId, fingerprint) : null, taskId ? { taskId, version: tasks.headers.get(taskId)?.version, sourceLabel: tasks.headers.get(taskId)?.label, progress: await new ReviewProgress(tasks).read(taskId) } : null)); return;
  }
  if (command === 'quit-legacy') { output(await exitLegacy(option('--legacy-root'), args.includes('--confirm'))); return; }
  if (command === 'doctor') {
    const tools = await bundledTools(root).catch(() => null), available = async fn => { try { return !!await fn?.(); } catch { return false; } };
    const location = await runtimePaths(root);
    let lifecycle = null;
    try {
      const value = await readJson(path.join(location.local, 'lifecycle.json'), 4096);
      if (value.format === 'media-review-lifecycle/v1') lifecycle = { startedAt: value.startedAt, exitedAt: value.exitedAt ?? null, reason: value.reason ?? '当前或上次会话未记录正常退出，不能据此确定崩溃、终止或重启的具体原因', previous: value.previous, cleanupWarning: !!value.cleanupWarning };
    } catch (cause) { if (cause.code !== 'ENOENT') lifecycle = { unavailable: true, message: '诊断不可读，原文件保留' }; }
    output({ node: process.versions.node, ffmpeg: await available(tools?.ffmpeg), whisper: await available(tools?.whisper), model: await available(tools?.model), lifecycle, localOnly: true }); return;
  }
  const { entry, post } = await connectReview({ rootDir: root, start: false });
  if (['progress', 'acknowledge', 'check-report', 'versions', 'round', 'readiness'].includes(command)) {
    if (command === 'readiness') { output(await post('/api/session/readiness', {})); return; }
    if (!taskId) throw new Error('需要 --task 明确任务');
    if (command === 'versions') { output(await post('/api/tasks/versions', { taskId })); return; }
    if (command === 'round') {
      if (!option('--revision')) throw new Error('读取交接需要 --revision');
      output(await post('/api/handoff/read', { taskId, revision: option('--revision') })); return;
    }
    const bundle = await post('/api/progress/load', { taskId });
    if (command === 'progress' && !option('--note')) { output(bundle); return; }
    const common = { taskId, baseRevision: option('--progress-revision') ?? bundle.progress.revision };
    if (command === 'progress') {
      if (!option('--revision')) throw new Error('更新进度需要本轮 --revision，不会猜测处理的是哪轮意见');
      output(await post('/api/progress/update', { ...common, recordRevision: option('--revision'), noteId: option('--note'), status: option('--state'), text: option('--text') ?? '', actor: 'agent', targetTaskId: option('--target') ?? null, targetMs: option('--at') ? Number(option('--at')) : null })); return;
    }
    if (command === 'acknowledge') {
      if (!option('--revision') || !option('--agent')) throw new Error('接手回执需要 --revision 和 --agent');
      output(await post('/api/progress/acknowledge', { ...common, recordRevision: option('--revision'), agent: option('--agent'), text: option('--text') ?? '', clarifications: option('--clarify')?.split(',').filter(Boolean) ?? [] })); return;
    }
    if (!option('--report')) throw new Error('检查报告需要 --report 指向已写好的 JSON 文件');
    const report = await readJson(path.resolve(option('--report')), 256 * 1024);
    output(await post('/api/progress/check', { ...report, ...common })); return;
  }
  if (command === 'tasks') { output(await post('/api/tasks/list', {})); return; }
  if (command === 'summary') { output(await post('/api/session/summary', {})); return; }
  if (command === 'status') {
    if (!taskId) throw new Error('status需要--task，不能用全局current猜当前对话的任务');
    const { task } = await post('/api/tasks/get', { taskId: taskIdentity(taskId) });
    const id = option('--job') ?? task.jobs.inspection;
    const job = id ? (await post('/api/jobs/status', { id, result: args.includes('--result') })).job : null;
    if (job && !(job.requesters ?? job.owners).includes(taskId) && !Object.values(task.jobs).includes(job.id)) throw new Error('该分析不属于指定任务');
    output({ task, job }); return;
  }
  if (command === 'cancel') {
    if (!taskId || !option('--job')) throw new Error('取消需要明确--task和--job');
    output(await post('/api/jobs/cancel', { taskId, id: option('--job') })); return;
  }
  if (command === 'end-task') {
    if (!taskId || !args.includes('--confirm')) throw new Error('结束任务需要--task与--confirm；它不是保存、认可或删除授权');
    output(await post('/api/tasks/status', { taskId, status: 'closed', confirmOtherWindows: args.includes('--confirm-other-windows') })); return;
  }
  if (command === 'quit') {
    const summary = await post('/api/session/summary', {});
    if (!args.includes('--confirm')) { output({ requiresConfirmation: true, summary }); return; }
    output(await post('/api/session/close', { runtimeId: entry.runtimeId, confirm: true, discardUnsaved: args.includes('--keep-drafts') })); return;
  }
  throw new Error('命令无效，请运行help；不会下载软件或执行任意命令');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAgentCLI().catch(cause => { console.error(cause.message); process.exitCode = 1; });
