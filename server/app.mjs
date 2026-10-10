import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RECORD_BYTES, RecordValidationError, validateFingerprint, validateRecord } from './review-record.mjs';
import { MAX_CHUNK_BYTES, MediaAnalysisError, MediaAnalysisService } from './media-analysis.mjs';
import { MAX_REFERENCE_REQUEST, readReference, writeReference, verifyReferences } from './review-reference.mjs';
import { UI_REVISION, runtimePaths, ordinaryDirectory } from './runtime.mjs';
import { exportReview } from './review-export.mjs';
import { MAX_WORKSPACE_BYTES, ReviewWorkflow } from './review-workflow.mjs';
import { listReviewHistory, openReviewLocation, openSystemLocation } from './review-history.mjs';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_REQUESTS = 4000;
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

async function saveRecord(reviews, record) {
  const fingerprint = record.media.fingerprint;
  const fileName = `${fingerprint}.review.json`;
  const file = path.join(reviews, fileName);
  // Do not replace a corrupt or future-format record. That is user data, not a repair target.
  const existing = await readSavedRecord(reviews, fingerprint);
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
    catch (cause) { if (cause.code !== 'EEXIST' || !(await fs.readFile(backup)).equals(oldBytes)) throw cause; }
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
    await fs.rename(temporary, file);
    const written = await readSavedRecord(reviews, fingerprint);
    if (JSON.stringify(written) !== JSON.stringify(record)) {
      throw new Error('保存后的记录回读不一致');
    }
    return { fileName, record: written, recordPath: file.replaceAll('\\', '/'), savedAt: new Date().toISOString() };
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
  maxLifetimeMs = DEFAULT_LIFETIME_MS,
  locationOpener = openSystemLocation,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  if (!Number.isInteger(idleMs) || idleMs < 1000) throw new Error('空闲时限无效');
  if (!Number.isInteger(maxLifetimeMs) || maxLifetimeMs < idleMs) throw new Error('总时限无效');
  const root = await fs.realpath(rootDir);
  const dist = await fs.realpath(path.join(root, 'dist'));
  if (!isInside(root, dist)) throw new Error('构建目录必须位于扩展目录内');
  const location = await runtimePaths(root);
  const reviews = location.standalone ? await ordinaryDirectory(location.reviews) : await ensureReviewsDirectory(root);
  const workflow = new ReviewWorkflow(root, reviews);
  const mediaAnalysis = new MediaAnalysisService(root);
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
  const started = Date.now();
  let lastRequest = started;
  let count = 0;
  let server;

  const close = () => new Promise((resolve) => {
    void mediaAnalysis.close();
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });

  server = createServer(async (req, res) => {
    try {
      if (req.url !== '/api/health' && req.url !== '/api/workflow/current') count += 1;
      if (count > MAX_REQUESTS || Date.now() - started > maxLifetimeMs) {
        error(res, 503, 'session_expired', '审片台本次会话已结束，请重新打开');
        void close();
        return;
      }
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
        return json(res, 200, { ok: true, app: 'ai-carry-media-review', version: 2, runtimeId, uiRevision: UI_REVISION, rootId: createHash('sha256').update(root.replaceAll('\\', '/').toLowerCase()).digest('hex') });
      }
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', '不支持此请求');
        if (req.headers.origin !== origin || !sameToken(req.headers['x-review-token'], token)) {
          return error(res, 403, 'invalid_session', '审片台会话无效，请重新打开');
        }
        if (pathname !== '/api/workflow/current') lastRequest = Date.now();
        if (!JSON_TYPE.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] ||
            req.headers['transfer-encoding']) {
          return error(res, 415, 'invalid_content_type', '需要 JSON 请求');
        }
        const requestLimit = pathname === '/api/workspace/save' ? MAX_WORKSPACE_BYTES : pathname === '/api/media/append' ? MAX_MEDIA_REQUEST_BYTES : pathname === '/api/references/save' ? MAX_REFERENCE_REQUEST : MAX_RECORD_BYTES;
        const length = Number(req.headers['content-length']);
        if (!Number.isInteger(length) || length < 1 || length > requestLimit) {
          return error(res, 413, 'invalid_length', '请求大小无效');
        }
        const body = await readJsonBody(req, requestLimit);
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
          return json(res, 200, pathname.endsWith('/current') ? { media: await workflow.current() } : { workspace: await workflow.latest() });
        }
        if (pathname === '/api/workflow/media') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'id') throw new RecordValidationError('带入媒体请求无效');
          const media = await workflow.media(body.id);
          res.writeHead(200, { 'Content-Type': media.type, 'Content-Length': media.size, 'Cache-Control': 'no-store' });
          const stream = media.handle.createReadStream();
          res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()).pipe(res); return;
        }
        if (pathname === '/api/workspace/load') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'fingerprint') throw new RecordValidationError('恢复请求无效');
          await assertReviewsDirectory();
          const workspace = await workflow.load(body.fingerprint);
          const at = workspace ? (await fs.stat(path.join(reviews, 'drafts', `${body.fingerprint}.workspace.json`))).mtimeMs : 0;
          return json(res, 200, { workspace, at });
        }
        if (pathname === '/api/workspace/save') {
          await assertReviewsDirectory(); return json(res, 200, await workflow.save(body));
        }
        if (pathname === '/api/media/start') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).sort().join(',') !== 'durationMs,size') {
            throw new RecordValidationError('媒体分析请求无效');
          }
          const id = await mediaAnalysis.start(body.size, body.durationMs);
          res.once('close', () => { if (!res.writableEnded) void mediaAnalysis.cancel(id); });
          if (res.destroyed) { await mediaAnalysis.cancel(id); return; }
          return json(res, 200, { id });
        }
        if (pathname === '/api/media/append') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).sort().join(',') !== 'data,id,index') {
            throw new RecordValidationError('媒体分片请求无效');
          }
          return json(res, 200, { written: await mediaAnalysis.append(body.id, body.index, body.data) });
        }
        if (pathname === '/api/media/cancel') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).join(',') !== 'id') {
            throw new RecordValidationError('取消请求无效');
          }
          return json(res, 200, { cancelled: await mediaAnalysis.cancel(body.id) });
        }
        if (pathname === '/api/media/finish') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).join(',') !== 'id') {
            throw new RecordValidationError('完成请求无效');
          }
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
          if (field === 'data') return json(res, 200, await writeReference(reviews, fingerprint, body.data));
          const image = await readReference(reviews, fingerprint, body.fileName);
          return json(res, 200, { data: `data:image/jpeg;base64,${image.bytes.toString('base64')}` });
        }
        if (pathname === '/api/reviews/export') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'fingerprint') throw new RecordValidationError('导出请求无效');
          const fingerprint = validateFingerprint(body.fingerprint); await assertReviewsDirectory();
          const directory = await ordinaryDirectory(path.join(location.local, 'exports'));
          return json(res, 200, await exportReview(root, fingerprint, path.join(directory, `review-${randomBytes(8).toString('hex')}`)));
        }
        if (pathname === '/api/reviews/load') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).length !== 1) {
            throw new RecordValidationError('读取请求无效');
          }
          const fingerprint = validateFingerprint(body.fingerprint);
          await assertReviewsDirectory();
          const record = await readSavedRecord(reviews, fingerprint);
          return json(res, 200, { found: record !== null, record, recordPath: record ? path.join(reviews, `${fingerprint}.review.json`).replaceAll('\\', '/') : null });
        }
        if (pathname === '/api/reviews/save') {
          const record = validateRecord(body);
          await assertReviewsDirectory();
          const saved = await saveRecord(reviews, record);
          return json(res, 200, { saved: true, ...saved });
        }
        if (pathname === '/api/session/close') {
          if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
            throw new RecordValidationError('关闭请求无效');
          }
          json(res, 200, { closed: true });
          void close();
          return;
        }
        return error(res, 404, 'not_found', '接口不存在');
      }
      lastRequest = Date.now();
      return await serveStatic(req, res, dist, pathname, token, nonce);
    } catch (cause) {
      if (cause instanceof MediaAnalysisError) {
        return error(res, cause.message.includes('仍在分析') ? 409 : 400, 'media_analysis_unavailable', cause.message);
      }
      if (cause instanceof RecordValidationError) {
        return error(res, cause.message.startsWith('已有记录') ? 409 : 400, 'invalid_record', cause.message);
      }
      error(res, 500, 'internal_error', '本地保存未能确认，请重新打开记录核对');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const interval = setInterval(() => {
    if (Date.now() - lastRequest > idleMs || Date.now() - started > maxLifetimeMs) void close();
  }, Math.min(15_000, idleMs));
  interval.unref();
  server.once('close', () => clearInterval(interval));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close };
}
