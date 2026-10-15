export const REVIEW_FORMAT = 'ai-carry-media-review/v1';
export const REFERENCE_FORMAT = 'ai-carry-media-review/v2';
export const REGIONS_FORMAT = 'ai-carry-media-review/v3';
export const FLOW_FORMAT = 'ai-carry-media-review/v4';
export const COMPLETE_FORMAT = 'ai-carry-media-review/v5';
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
  const flow = [FLOW_FORMAT, COMPLETE_FORMAT].includes(value.format);
  exactKeys(value, ['format', 'media', 'notes', ...(flow && Object.hasOwn(value, 'completion') ? ['completion'] : [])], '记录');
  if (![REVIEW_FORMAT, REFERENCE_FORMAT, REGIONS_FORMAT, FLOW_FORMAT, COMPLETE_FORMAT].includes(value.format)) throw new RecordValidationError('记录格式不受支持');
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
  if (value.completion != null) {
    const completion = value.completion;
    if (!plainObject(completion)) throw new RecordValidationError('审阅结果无效');
    exactKeys(completion, ['outcome', 'completedAt'], '审阅结果');
    if (!['no-changes', 'with-notes'].includes(completion.outcome) || typeof completion.completedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(completion.completedAt) || !Number.isFinite(Date.parse(completion.completedAt)) ||
        (completion.outcome === 'no-changes') !== (value.notes.length === 0)) throw new RecordValidationError('审阅结果与意见不一致');
  }
  for (const [index, note] of value.notes.entries()) {
    const where = `第 ${index + 1} 条标注`;
    if (!plainObject(note)) throw new RecordValidationError(`${where} 无效`);
    const multi = [REGIONS_FORMAT, FLOW_FORMAT, COMPLETE_FORMAT].includes(value.format) && Object.hasOwn(note, 'regions');
    exactKeys(note, ['id', 'kind', 'startMs', 'endMs', 'text', multi ? 'regions' : 'rect', ...(Object.hasOwn(note, 'topic') ? ['topic'] : []), ...(value.format !== REVIEW_FORMAT && Object.hasOwn(note, 'reference') ? ['reference'] : []), ...(flow && Object.hasOwn(note, 'scope') ? ['scope'] : []), ...(flow && Object.hasOwn(note, 'regionSerial') ? ['regionSerial'] : [])], where);
    if (Object.hasOwn(note, 'scope') && note.scope !== 'whole') throw new RecordValidationError(`${where} 的范围无效`);
    if (note.scope === 'whole' && (note.startMs !== null || note.endMs !== null)) throw new RecordValidationError(`${where} 的整片意见不能带时间范围`);
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
    if (note.scope !== 'whole') intInRange(note.startMs, 0, durationMs, `${where} 的开始时间`);
    if (note.endMs !== null) {
      intInRange(note.endMs, note.startMs + 1, durationMs, `${where} 的结束时间`);
    }
    if (typeof note.text !== 'string' || note.text.trim().length < 1 || note.text.length > 3000 ||
        note.text.includes('\0')) {
      throw new RecordValidationError(`${where} 的文字无效`);
    }
    if (multi && (!Array.isArray(note.regions) || note.regions.length > 50)) throw new RecordValidationError(`${where} 的画面区域无效或超过50处`);
    const regions = multi ? note.regions : note.rect === null ? [] : [{ id: 1, rect: note.rect }];
    if (note.regionSerial !== undefined) intInRange(note.regionSerial, 0, Number.MAX_SAFE_INTEGER - 1, `${where} 的画面编号记录`);
    const regionIds = new Set();
    for (const region of regions) {
      if (!plainObject(region)) throw new RecordValidationError(`${where} 的画面区域无效`);
      exactKeys(region, ['id', 'rect', ...(value.format === COMPLETE_FORMAT && Object.hasOwn(region, 'text') ? ['text'] : [])], `${where} 的画面区域`);
      if (region.text !== undefined && (typeof region.text !== 'string' || region.text.length > 2000 || region.text.includes('\0'))) throw new RecordValidationError(`${where} 的区域说明无效`);
      intInRange(region.id, 1, Number.MAX_SAFE_INTEGER, `${where} 的画面编号`);
      if (regionIds.has(region.id)) throw new RecordValidationError(`${where} 的画面编号重复`);
      regionIds.add(region.id);
      if (note.regionSerial !== undefined && region.id > note.regionSerial) throw new RecordValidationError(`${where} 的画面编号记录不一致`);
      if (!plainObject(region.rect)) throw new RecordValidationError(`${where} 的画面位置无效`);
      exactKeys(region.rect, ['x', 'y', 'width', 'height'], `${where} 的画面位置`);
      const { x, y, width, height } = region.rect;
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
          width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
        throw new RecordValidationError(`${where} 的画面位置越界`);
      }
    }
  }

  return value;
}
