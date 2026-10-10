import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RecordValidationError, validateFingerprint } from './review-record.mjs';

export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
export const MAX_REFERENCE_REQUEST = Math.ceil(MAX_REFERENCE_BYTES * 4 / 3) + 1024;
const filePattern = /^[a-f0-9]{64}\.jpg$/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw new RecordValidationError('参考图不是完整 JPEG');
  }
  let at = 2;
  while (at + 4 < bytes.length) {
    if (bytes[at++] !== 0xff) break;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      const height = bytes.readUInt16BE(at + 3), width = bytes.readUInt16BE(at + 5);
      if (width >= 1 && height >= 1 && width <= 4096 && height <= 4096) return { width, height };
      break;
    }
    at += length;
  }
  throw new RecordValidationError('参考图尺寸无法核对');
}

async function directory(reviews, fingerprint, create) {
  validateFingerprint(fingerprint);
  let current = reviews;
  for (const part of ['references', fingerprint]) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) {
      throw new RecordValidationError('参考画面目录已改变，拒绝读写');
    }
  }
  return current;
}

export async function readReference(reviews, fingerprint, fileName) {
  if (typeof fileName !== 'string' || !filePattern.test(fileName)) throw new RecordValidationError('参考图名称无效');
  const folder = await directory(reviews, fingerprint, false);
  const file = path.join(folder, fileName);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REFERENCE_BYTES) throw new RecordValidationError('参考图文件无效');
  const bytes = await fs.readFile(file);
  if (`${hash(bytes)}.jpg` !== fileName) throw new RecordValidationError('参考图内容已改变，原意见保留');
  return { bytes, ...jpegSize(bytes) };
}

export async function writeReference(reviews, fingerprint, data) {
  validateFingerprint(fingerprint);
  if (typeof data !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
    throw new RecordValidationError('参考图编码无效');
  }
  const encoded = data.slice('data:image/jpeg;base64,'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_REFERENCE_BYTES || bytes.toString('base64') !== encoded) throw new RecordValidationError('参考图超过限制或编码不完整');
  const size = jpegSize(bytes);
  const fileName = `${hash(bytes)}.jpg`;
  const folder = await directory(reviews, fingerprint, true);
  try { await fs.writeFile(path.join(folder, fileName), bytes, { flag: 'wx', mode: 0o600 }); }
  catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  const read = await readReference(reviews, fingerprint, fileName);
  if (!read.bytes.equals(bytes)) throw new RecordValidationError('参考图回读不一致');
  return { fileName, ...size };
}

export async function verifyReferences(reviews, record) {
  for (const note of record.notes) {
    if (!note.reference) continue;
    const image = await readReference(reviews, record.media.fingerprint, note.reference.fileName);
    if (image.width !== note.reference.width || image.height !== note.reference.height) {
      throw new RecordValidationError('参考图尺寸与意见不一致，未保存');
    }
  }
}
