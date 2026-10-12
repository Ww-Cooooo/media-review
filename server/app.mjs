import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RECORD_BYTES, RecordValidationError, validateFingerprint, validateRecord } from './review-record.mjs';
import { MAX_CHUNK_BYTES, MediaAnalysisError, MediaAnalysisService } from './media-analysis.mjs';
import { MAX_REFERENCE_REQUEST, readReference, writeReference, verifyReferences } from './review-reference.mjs';
import { Readable } from 'node:stream';
import { UI_REVISION, SERVICE_PROTOCOL, runtimePaths, ordinaryDirectory, pathIdentity, keyedSerial, documentRevision, ReviewError, readJson, atomicJson } from './runtime.mjs';
import { ReviewService } from './review-service.mjs';
import { exportReview } from './review-export.mjs';
import { MAX_WORKSPACE_BYTES, ReviewWorkflow } from './review-workflow.mjs';
import { listReviewHistory, openReviewLocation, openSystemLocation } from './review-history.mjs';
import { prepareRestart } from './restart-worker.mjs';
import { readNativeLauncher } from './native-launcher.mjs';

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 3000;
const MAX_INFLIGHT_BODY_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_REQUEST_BYTES = Math.ceil(MAX_CHUNK_BYTES * 4 / 3) + 4096;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const MIME = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.pdf', 'application/pdf'],
  ['.ico', 'image/x-icon'],
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function error(res, status, code, message) {
  json(res, status, { error: code, message });
}

function sameToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ensureReviewsDirectory(root) {
  const reviews = path.join(root, 'reviews');
  try {
    await fs.mkdir(reviews);
  } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
  }
  const stat = await fs.lstat(reviews);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('reviews 必须是扩展目录下的普通文件夹');
  return reviews;
}

async function readSavedRecord(reviews, fingerprint) {
  const file = path.join(reviews, `${fingerprint}.review.json`);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) {
    throw new RecordValidationError('已有记录不符合当前格式，已原样保留');
  }
  let record;
  try {
    record = JSON.parse(await fs.readFile(file, 'utf8'));
    validateRecord(record, fingerprint);
  } catch (cause) {
    if (cause instanceof RecordValidationError || cause instanceof SyntaxError) {
      throw new RecordValidationError('已有记录不符合当前格式，已原样保留');
    }
    throw cause;
  }
  return record;
}

async function saveRecord(reviews, record, baseRevision) {
  const fingerprint = record.media.fingerprint;
  const fileName = `${fingerprint}.review.json`;
  const file = path.join(reviews, fileName);
  // Do not replace a corrupt or future-format record. That is user data, not a repair target.
  const existing = await readSavedRecord(reviews, fingerprint);
  if (documentRevision(existing) !== baseRevision) throw new ReviewError('正式意见已被另一窗口修改；没有覆盖先保存的内容。本页意见与草稿仍在，请先核对两个版本。', 'review_conflict');
  if (existing && ['name', 'size', 'type', 'durationMs', 'fingerprint']
    .some((key) => existing.media[key] !== record.media[key])) {
    throw new RecordValidationError('已有记录的媒体身份不同，已原样保留');
  }
  await verifyReferences(reviews, record);
  if (existing?.format === 'ai-carry-media-review/v2' && record.format !== existing.format) {
    throw new RecordValidationError('不能用旧格式覆盖含参考画面的记录，请重新打开当前入口');
  }
  if (existing?.format === 'ai-carry-media-review/v1' && record.format === 'ai-carry-media-review/v2') {
    const oldBytes = await fs.readFile(file);
    const digest = createHash('sha256').update(oldBytes).digest('hex').slice(0, 16);
    const backup = path.join(reviews, `${fingerprint}.${digest}.v1.backup.json`);
    try { await fs.copyFile(file, backup, constants.COPYFILE_EXCL); }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      const stat = await fs.lstat(backup);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== oldBytes.length || !(await fs.readFile(backup)).equals(oldBytes)) throw new RecordValidationError('旧版备份身份不明，原文件保留，未覆盖');
    }
  }
  if (existing) {
    const oldBytes = await fs.readFile(file), directory = await ordinaryDirectory(path.join(reviews, 'versions'));
    const backup = path.join(directory, `${fingerprint}.${baseRevision}.review.json`);
    try { await fs.copyFile(file, backup, constants.COPYFILE_EXCL); }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      const stat = await fs.lstat(backup);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== oldBytes.length || !(await fs.readFile(backup)).equals(oldBytes)) throw new RecordValidationError('旧版备份身份不明，原文件保留，未覆盖');
    }
  }
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) {
    throw new RecordValidationError('记录超过保存大小限制');
  }
  const temporary = path.join(reviews, `.${fingerprint}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (documentRevision(await readSavedRecord(reviews, fingerprint)) !== baseRevision) throw new ReviewError('记录在提交前发生变化，未覆盖；本页意见仍保留。', 'review_conflict');
    await fs.rename(temporary, file);
    const written = await readSavedRecord(reviews, fingerprint);
    if (JSON.stringify(written) !== JSON.stringify(record)) {
      throw new Error('保存后的记录回读不一致');
    }
    return { fileName, record: written, revision: documentRevision(written), recordPath: file.replaceAll('\\', '/'), savedAt: new Date().toISOString() };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((cause) => {
      if (cause.code !== 'ENOENT') throw cause;
    });
  }
}

async function readJsonBody(req, maxBytes = MAX_RECORD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new RecordValidationError('请求内容超过限制');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RecordValidationError('JSON 内容无效');
  }
}

async function serveStatic(req, res, dist, pathname, token, nonce) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, 'method_not_allowed', '不支持此请求');
  if (pathname.includes('\\') || pathname.includes('\0')) return error(res, 400, 'bad_path', '路径无效');
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return error(res, 400, 'bad_path', '路径无效');
  }
  if (requested.includes('\\') || requested.includes('\0') || requested.split('/').includes('..')) {
    return error(res, 400, 'bad_path', '路径无效');
  }
  const file = requested === '/' ? path.join(dist, 'index.html') : path.resolve(dist, `.${requested}`);
  if (!isInside(dist, file)) return error(res, 404, 'not_found', '页面不存在');
  let realFile;
  try {
    realFile = await fs.realpath(file);
  } catch (cause) {
    if (cause.code === 'ENOENT') return error(res, 404, 'not_found', '页面不存在');
    throw cause;
  }
  if (!isInside(dist, realFile)) return error(res, 404, 'not_found', '页面不存在');
  const stat = await fs.stat(realFile);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return error(res, 404, 'not_found', '页面不存在');
  if (path.basename(realFile) === 'index.html') {
    const html = await fs.readFile(realFile, 'utf8');
    if (!html.includes('</head>')) throw new Error('构建页面缺少 head 结束标签');
    const sessionScript = `<script nonce="${nonce}">window.__REVIEW_SESSION_TOKEN__=${JSON.stringify(token)};<\/script>`;
    const body = html.replace('</head>', `${sessionScript}</head>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(200, {
    'Content-Type': MIME.get(path.extname(realFile).toLowerCase()) ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(realFile).pipe(res);
}

export async function createReviewServer({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  port = 0,
  idleMs = DEFAULT_IDLE_MS,
  maxLifetimeMs = null,
  locationOpener = openSystemLocation,
  clock = () => performance.now(),
  serviceOptions = {},
  restartPreparer = prepareRestart,
  nativeLauncherReader = readNativeLauncher,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  if (!Number.isInteger(idleMs) || idleMs < 1000) throw new Error('空闲时限无效');
  if (maxLifetimeMs !== null && (!Number.isInteger(maxLifetimeMs) || maxLifetimeMs < idleMs)) throw new Error('总时限无效');
  const root = await fs.realpath(rootDir);
  const dist = await fs.realpath(path.join(root, 'dist'));
  if (!isInside(root, dist)) throw new Error('构建目录必须位于扩展目录内');
  const location = await runtimePaths(root);
  const reviews = location.standalone ? await ordinaryDirectory(location.reviews) : await ensureReviewsDirectory(root);
  const workflow = new ReviewWorkflow(root, reviews);
  const local = await ordinaryDirectory(location.local);
  const state = await new ReviewService(root, local, reviews, { ...serviceOptions, locationOpener }).init();
  const mediaAnalysis = state.uploads;
  const serial = keyedSerial();
  const rootId = pathIdentity(root), dataId = pathIdentity(local);
  const reviewsStat = await fs.lstat(reviews);
  async function assertReviewsDirectory() {
    const current = await fs.lstat(reviews);
    if (!current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== reviewsStat.dev || current.ino !== reviewsStat.ino ||
        await fs.realpath(reviews) !== reviews) {
      throw new Error('标注目录已改变，拒绝继续读写');
    }
  }
  const runtimeId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  let windowStarted = clock(), emptySince = clock(), count = 0, inFlightBytes = 0, inFlight = 0;
  let server, closing, restarting = false, streamingAnalysis = 0, mediaTransfers = 0;
  const identity = { ok: true, app: 'ai-carry-media-review', version: 2, protocol: SERVICE_PROTOCOL, runtimeId, uiRevision: UI_REVISION, rootId, dataId };
  state.runtimeId = runtimeId;
  const lifecycleFile = path.join(local, 'lifecycle.json');
  let lifecycleWritable = true, previous = null;
  try {
    const old = await readJson(lifecycleFile, 4096);
    if (old.format !== 'media-review-lifecycle/v1') lifecycleWritable = false;
    else previous = { runtimeId: old.runtimeId, startedAt: old.startedAt, exitedAt: old.exitedAt ?? null, reason: old.reason ?? 'unconfirmed' };
  } catch (cause) { if (cause.code !== 'ENOENT') lifecycleWritable = false; }
  const lifecycle = { format: 'media-review-lifecycle/v1', runtimeId, uiRevision: UI_REVISION, startedAt: new Date().toISOString(), previous };
  if (lifecycleWritable) await atomicJson(lifecycleFile, lifecycle).catch(() => { lifecycleWritable = false; });
  const close = (reason = 'explicit') => closing ??= (async () => {
    try { await state.close(); } catch { state.uploads.cleanupWarning = true; }
    finally {
      if (lifecycleWritable) await atomicJson(lifecycleFile, { ...lifecycle, exitedAt: new Date().toISOString(), reason, cleanupWarning: !!state.uploads.cleanupWarning }).catch(() => {});
      if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  })();

  server = createServer(async (req, res) => {
    let reserved = 0, admitted = false, analysisStream = false;
    try {
      if (closing || restarting) return error(res, 503, 'service_closing', '校对室正在退出或重启，已有资料保留');
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      const host = `127.0.0.1:${address.port}`;
      if (req.headers.host !== host) return error(res, 403, 'invalid_host', '请求来源无效');
      if (req.headers.origin && req.headers.origin !== origin) {
        return error(res, 403, 'invalid_origin', '请求来源无效');
      }
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' &&
          req.headers['sec-fetch-site'] !== 'none') {
        return error(res, 403, 'invalid_site', '请求来源无效');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);

      let pathname;
      try {
        pathname = new URL(req.url, origin).pathname;
      } catch {
        return error(res, 400, 'bad_path', '路径无效');
      }
      if (pathname === '/api/health') {
        if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', '不支持此请求');
        return json(res, 200, identity);
      }
      if (pathname === '/api/session/bootstrap' && req.method === 'GET') return json(res, 200, { ...identity, token });
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', '不支持此请求');
        if (req.headers.origin !== origin || !sameToken(req.headers['x-review-token'], token)) {
          return error(res, 403, 'invalid_session', '审片台会话无效，请重新打开');
        }
        if (clock() - windowStarted > 60_000) { count = 0; windowStarted = clock(); }
        if (++count > MAX_REQUESTS_PER_MINUTE) return error(res, 429, 'request_rate', '本机请求过密，请稍后重试；没有结束服务');
        if (!JSON_TYPE.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] ||
            req.headers['transfer-encoding']) {
          return error(res, 415, 'invalid_content_type', '需要 JSON 请求');
        }
        const requestLimit = pathname === '/api/workspace/save' || pathname === '/api/workspace/archive' ? MAX_WORKSPACE_BYTES + 4096 : pathname === '/api/media/append' ? MAX_MEDIA_REQUEST_BYTES : pathname === '/api/references/save' ? MAX_REFERENCE_REQUEST : MAX_RECORD_BYTES + 4096;
        const length = Number(req.headers['content-length']);
        if (!Number.isInteger(length) || length < 1 || length > requestLimit) {
          return error(res, 413, 'invalid_length', '请求大小无效');
        }
        if (inFlightBytes + length > MAX_INFLIGHT_BODY_BYTES || inFlight >= 64) return error(res, 429, 'request_capacity', '当前在途请求达到容量，请稍后重试；输入未被清空');
        reserved = length; inFlightBytes += length; inFlight++; admitted = true; emptySince = null;
        const body = await readJsonBody(req, requestLimit);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RecordValidationError('JSON请求需要对象');
        const context = body.context ?? null;
        if (body && typeof body === 'object') delete body.context;
        const handled = await state.route(pathname, body, context);
        if (handled !== null) return json(res, 200, handled);
        const fingerprintOf = value => value?.media?.fingerprint ?? value?.fingerprint;
        const scoped = (value, writing = false) => state.scope(context, fingerprintOf(value), writing);
        const scopedWorkflow = async value => new ReviewWorkflow(root, await scoped(value));
        if (pathname === '/api/history/list') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new RecordValidationError('历史请求无效');
          await assertReviewsDirectory(); return json(res, 200, await listReviewHistory(reviews));
        }
        if (pathname === '/api/history/open-location') {
          await assertReviewsDirectory(); return json(res, 200, await openReviewLocation(reviews, body, locationOpener));
        }
        if (pathname === '/api/workflow/current' || pathname === '/api/workspace/latest') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new RecordValidationError('工作流请求无效');
          await assertReviewsDirectory();
          return json(res, 200, pathname.endsWith('/current') ? { media: await workflow.current() } : { workspace: await (await scopedWorkflow(body)).latest() });
        }
        if (pathname === '/api/workflow/media') {
          if (Object.keys(body).some(key => !['id', 'readOnly'].includes(key))) throw new RecordValidationError('带入媒体请求无效');
          const media = state.tasks.headers.has(body.id) ? await state.media(body.id, context, body.readOnly === true) : await workflow.media(body.id);
          res.writeHead(200, { 'Content-Type': media.type, 'Content-Length': media.size, 'Cache-Control': 'no-store' });
          const stream = media.task ? Readable.from(state.mediaStream(media)) : media.handle.createReadStream();
          mediaTransfers++; stream.once('close', () => { mediaTransfers--; });
          res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()).pipe(res); return;
        }
        if (pathname === '/api/workspace/load') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'fingerprint') throw new RecordValidationError('恢复请求无效');
          await assertReviewsDirectory();
          const selected = await scopedWorkflow(body), workspace = await selected.load(body.fingerprint, context?.clientId ?? null);
          return json(res, 200, { workspace, at: selected.loadedAt ?? 0 });
        }
        if (pathname === '/api/workspace/save') {
          await assertReviewsDirectory(); await state.assertMedia(context, body.media);
          const directory = await scoped(body, true);
          return json(res, 200, await serial(`${directory}:draft:${body.media.fingerprint}`, () => new ReviewWorkflow(root, directory).save(body, context?.clientId ?? null)));
        }
        if (pathname === '/api/workspace/archive') {
          await assertReviewsDirectory(); await state.assertMedia(context, body.media);
          const directory = await scoped(body, true);
          return json(res, 200, await serial(`${directory}:draft:${body.media.fingerprint}`, () => new ReviewWorkflow(root, directory).archive(body, context?.clientId ?? 'legacy')));
        }
        if (pathname === '/api/media/start') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).sort().join(',') !== 'durationMs,size') {
            throw new RecordValidationError('媒体分析请求无效');
          }
          if (context?.taskId) {
            const task = await state.tasks.read(context.taskId);
            await state.scope(context, task.media.fingerprint, true);
            if (body.size !== task.media.size) throw new RecordValidationError('上传媒体与当前任务大小不匹配');
          }
          const id = await mediaAnalysis.start(body.size, body.durationMs, context);
          res.once('close', () => { if (!res.writableEnded) void mediaAnalysis.cancel(id); });
          if (res.destroyed) { await mediaAnalysis.cancel(id); return; }
          return json(res, 200, { id });
        }
        if (pathname === '/api/media/append') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).sort().join(',') !== 'data,id,index') {
            throw new RecordValidationError('媒体分片请求无效');
          }
          mediaAnalysis.assertOwner(body.id, context);
          return json(res, 200, { written: await mediaAnalysis.append(body.id, body.index, body.data) });
        }
        if (pathname === '/api/media/cancel') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).join(',') !== 'id') {
            throw new RecordValidationError('取消请求无效');
          }
          mediaAnalysis.assertOwner(body.id, context);
          return json(res, 200, { cancelled: await mediaAnalysis.cancel(body.id) });
        }
        if (pathname === '/api/media/finish') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).join(',') !== 'id') {
            throw new RecordValidationError('完成请求无效');
          }
          mediaAnalysis.assertOwner(body.id, context);
          analysisStream = true; streamingAnalysis++;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
          res.on('close', () => { if (!res.writableEnded) void mediaAnalysis.cancel(body.id); });
          try {
            await mediaAnalysis.finish(body.id, (event) => {
              if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
            });
          } catch {
            if (!res.destroyed) res.write(`${JSON.stringify({ kind: 'error', message: '本机媒体分析中断；仍可播放并手动标记。' })}\n`);
          }
          if (!res.destroyed) res.end();
          return;
        }
        if (pathname === '/api/references/save' || pathname === '/api/references/load') {
          const field = pathname.endsWith('/save') ? 'data' : 'fileName';
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== [field, 'fingerprint'].sort().join(',')) {
            throw new RecordValidationError('参考画面请求无效');
          }
          const fingerprint = validateFingerprint(body.fingerprint);
          await assertReviewsDirectory();
          const directory = await scoped(body, field === 'data');
          if (field === 'data') return json(res, 200, await writeReference(directory, fingerprint, body.data));
          const image = await readReference(directory, fingerprint, body.fileName);
          return json(res, 200, { data: `data:image/jpeg;base64,${image.bytes.toString('base64')}` });
        }
        if (pathname === '/api/reviews/export') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'fingerprint') throw new RecordValidationError('导出请求无效');
          const fingerprint = validateFingerprint(body.fingerprint); await assertReviewsDirectory();
          const directory = await ordinaryDirectory(path.join(location.local, 'exports'));
          return json(res, 200, await exportReview(root, fingerprint, path.join(directory, `review-${randomBytes(8).toString('hex')}`), await scoped(body)));
        }
        if (pathname === '/api/reviews/load') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).length !== 1) {
            throw new RecordValidationError('读取请求无效');
          }
          const fingerprint = validateFingerprint(body.fingerprint);
          await assertReviewsDirectory();
          const directory = await scoped(body);
          const record = await readSavedRecord(directory, fingerprint);
          return json(res, 200, { found: record !== null, record, revision: documentRevision(record), recordPath: record ? path.join(directory, `${fingerprint}.review.json`).replaceAll('\\', '/') : null });
        }
        if (pathname === '/api/reviews/save') {
          const record = validateRecord(body.record ?? body);
          await state.assertMedia(context, record.media);
          if (!Object.hasOwn(body, 'baseRevision') || !(body.baseRevision === null || typeof body.baseRevision === 'string' && /^[a-f0-9]{64}$/u.test(body.baseRevision))) throw new ReviewError('保存需要加载时的意见版本，请从当前入口重新连接；未覆盖原记录', 'revision_required', 428);
          await assertReviewsDirectory();
          const directory = await scoped(record, true);
          const saved = await serial(`${directory}:${record.media.fingerprint}`, () => saveRecord(directory, record, body.baseRevision));
          return json(res, 200, { saved: true, ...saved });
        }
        if (pathname === '/api/session/launcher') return json(res, 200, await nativeLauncherReader(local));
        if (pathname === '/api/session/restart-info') {
          const summary = state.summary();
          return json(res, 200, { ...summary, impactRevision: documentRevision(summary) });
        }
        if (pathname === '/api/session/restart') {
          const summary = state.summary();
          if (body.confirm !== true || body.runtimeId !== runtimeId || body.impactRevision !== documentRevision(summary)) throw new ReviewError('当前服务或使用情况已变化，请重新核对重启影响；原服务未退出。', 'restart_confirmation');
          if (summary.unsavedWindows && body.keepUnsaved !== true) throw new ReviewError('仍有窗口报告未保存输入，请先保存，或明确选择保留本页与已确认恢复副本后重启。', 'unsaved_windows');
          if (mediaTransfers || inFlight - streamingAnalysis > 1) throw new ReviewError('仍有素材带入、保存或其他短操作正在确认，请等回执完成再重启；未中断写入。', 'requests_in_flight');
          restarting = true;
          let successor;
          try { successor = await restartPreparer(root, runtimeId); }
          catch (cause) { restarting = false; throw cause; }
          json(res, 200, { restarting: true, retained: true });
          void close('user-restart').then(() => successor.commit()).catch(() => successor.abort());
          return;
        }
        if (pathname === '/api/session/close') {
          if (body.confirm !== true || body.runtimeId !== runtimeId) throw new ReviewError('退出会影响整个校对室，请先查看使用情况并明确确认当前服务', 'close_confirmation');
          if (state.clients.summary().unsavedWindows > (body.discardUnsaved === true ? 64 : 0)) throw new ReviewError('仍有窗口报告未保存输入，请先保存，或明确选择保留恢复副本后退出', 'unsaved_windows');
          json(res, 200, { closing: true, retained: true });
          void close('user-request');
          return;
        }
        return error(res, 404, 'not_found', '接口不存在');
      }
      return await serveStatic(req, res, dist, pathname, token, nonce);
    } catch (cause) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      if (cause instanceof ReviewError) return error(res, cause.status, cause.code, cause.message);
      if (cause instanceof MediaAnalysisError) {
        return error(res, cause.message.includes('仍在分析') ? 409 : 400, 'media_analysis_unavailable', cause.message);
      }
      if (cause instanceof RecordValidationError) {
        return error(res, cause.message.startsWith('已有记录') ? 409 : 400, 'invalid_record', cause.message);
      }
      error(res, 500, 'internal_error', '本地操作未能确认，请核对本机磁盘与记录；原输入保留');
    } finally { if (analysisStream) streamingAnalysis--; if (admitted) { inFlightBytes -= reserved; inFlight--; } }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (cause) { await close('listen-failed'); throw cause; }
  const checkIdle = () => {
    if (state.busy || inFlight) emptySince = null;
    else if (emptySince === null) emptySince = clock();
    else if (clock() - emptySince > idleMs) void close('empty-desk');
  };
  const interval = setInterval(checkIdle, Math.min(15_000, idleMs));
  interval.unref();
  server.once('close', () => clearInterval(interval));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close, identity, state, checkIdle };
}
