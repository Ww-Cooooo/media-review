export const REVIEW_FORMAT = 'ai-carry-media-review/v1';
export const REFERENCE_FORMAT = 'ai-carry-media-review/v2';
export const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_NOTES = 300;

const KINDS = new Set(['modify', 'keep', 'discuss']);
const TOPICS = new Set(['visual', 'subtitle', 'audio', 'pace', 'content', 'other']);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const NOTE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, where) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RecordValidationError(`${where} 字段与当前格式不符`);
  }
}

function intInRange(value, min, max, where) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RecordValidationError(`${where} 无效`);
  }
  return value;
}

export class RecordValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordValidationError';
  }
}

export function validateFingerprint(value) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new RecordValidationError('媒体指纹无效');
  }
  return value;
}

export function validateRecord(value, expectedFingerprint) {
  if (!plainObject(value)) throw new RecordValidationError('记录必须是对象');
  exactKeys(value, ['format', 'media', 'notes'], '记录');
  if (![REVIEW_FORMAT, REFERENCE_FORMAT].includes(value.format)) throw new RecordValidationError('记录格式不受支持');
  if (!plainObject(value.media)) throw new RecordValidationError('媒体身份无效');
  exactKeys(value.media, ['name', 'size', 'type', 'durationMs', 'fingerprint'], '媒体身份');

  const { name, size, type, durationMs, fingerprint } = value.media;
  if (typeof name !== 'string' || name.length < 1 || name.length > 255 || /[/\\\0]/u.test(name)) {
    throw new RecordValidationError('媒体名称无效');
  }
  intInRange(size, 1, Number.MAX_SAFE_INTEGER, '媒体大小');
  if (typeof type !== 'string' || type.length > 100 ||
      (type !== '' && !/^(audio|video)\/[A-Za-z0-9.+-]+$/u.test(type))) {
    throw new RecordValidationError('媒体类型无效');
  }
  intInRange(durationMs, 1, 172800000, '媒体时长');
  validateFingerprint(fingerprint);
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    throw new RecordValidationError('记录与请求的媒体指纹不一致');
  }
  if (!Array.isArray(value.notes) || value.notes.length > MAX_NOTES) {
    throw new RecordValidationError('标注数量超过限制');
  }

  const ids = new Set();
  for (const [index, note] of value.notes.entries()) {
    const where = `第 ${index + 1} 条标注`;
    if (!plainObject(note)) throw new RecordValidationError(`${where} 无效`);
    exactKeys(note, ['id', 'kind', 'startMs', 'endMs', 'text', 'rect', ...(Object.hasOwn(note, 'topic') ? ['topic'] : []), ...(value.format === REFERENCE_FORMAT && Object.hasOwn(note, 'reference') ? ['reference'] : [])], where);
    if (note.reference !== undefined && note.reference !== null) {
      const reference = note.reference;
      if (!plainObject(reference)) throw new RecordValidationError(`${where} 的参考画面无效`);
      exactKeys(reference, ['frameMs', 'fileName', 'width', 'height'], `${where} 的参考画面`);
      intInRange(reference.frameMs, 0, durationMs, `${where} 的参考帧时间`);
      intInRange(reference.width, 1, 4096, `${where} 的参考图宽度`);
      intInRange(reference.height, 1, 4096, `${where} 的参考图高度`);
      if (typeof reference.fileName !== 'string' || !/^[a-f0-9]{64}\.jpg$/u.test(reference.fileName) || type.startsWith('audio/')) {
        throw new RecordValidationError(`${where} 的参考图文件无效`);
      }
    }
    if (typeof note.id !== 'string' || !NOTE_ID.test(note.id) || ids.has(note.id)) {
      throw new RecordValidationError(`${where} 的 ID 无效或重复`);
    }
    ids.add(note.id);
    if (!KINDS.has(note.kind)) throw new RecordValidationError(`${where} 的类别无效`);
    if (Object.hasOwn(note, 'topic') && note.topic !== null && !TOPICS.has(note.topic)) {
      throw new RecordValidationError(`${where} 的问题位置无效`);
    }
    intInRange(note.startMs, 0, durationMs, `${where} 的开始时间`);
    if (note.endMs !== null) {
      intInRange(note.endMs, note.startMs + 1, durationMs, `${where} 的结束时间`);
    }
    if (typeof note.text !== 'string' || note.text.trim().length < 1 || note.text.length > 3000 ||
        note.text.includes('\0')) {
      throw new RecordValidationError(`${where} 的文字无效`);
    }
    if (note.rect !== null) {
      if (!plainObject(note.rect)) throw new RecordValidationError(`${where} 的画面位置无效`);
      exactKeys(note.rect, ['x', 'y', 'width', 'height'], `${where} 的画面位置`);
      const { x, y, width, height } = note.rect;
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
          width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
        throw new RecordValidationError(`${where} 的画面位置越界`);
      }
    }
  }

  return value;
}
