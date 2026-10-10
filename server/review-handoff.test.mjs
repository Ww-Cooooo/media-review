import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewHandoff, verifySaveReceipt } from '../src/lib/review-handoff.ts';

function fixture() {
  const fingerprint = 'b'.repeat(64);
  const record = {
    format: 'ai-carry-media-review/v1',
    media: { name: '隔离测试－不是用户意见.mp4', size: 2048, type: 'video/mp4', durationMs: 16000, fingerprint },
    notes: ['modify', 'keep', 'discuss'].map((kind, index) => ({
      id: `test_${index}`, kind, startMs: index * 1000, endMs: null,
      text: '【隔离测试】只用于验证交接。', rect: null,
    })),
  };
  return {
    record,
    receipt: { saved: true, fileName: `${fingerprint}.review.json`, recordPath: `C:/isolated/reviews/${fingerprint}.review.json`, savedAt: '2026-10-08T04:05:06.000Z', record: structuredClone(record) },
  };
}

test('仅接受确认保存、媒体身份与全部意见一致的回读回执', () => {
  const { record, receipt } = fixture();
  assert.equal(verifySaveReceipt(receipt, record), receipt);
  for (const change of [
    value => { value.saved = false; },
    value => { value.fileName = `${'c'.repeat(64)}.review.json`; },
    value => { value.record.media.fingerprint = 'c'.repeat(64); },
    value => { value.record.notes.pop(); },
    value => { value.record.notes[0].text = '不是当前意见'; },
    value => { value.record.notes[0].startMs = 50; },
    value => { value.record.notes[0].rect = { x: .1, y: .2, width: .3, height: .4 }; },
    value => { value.recordPath = '../reviews/missing.json'; },
    value => { value.recordPath = `C:/bad\n/reviews/${value.fileName}`; },
    value => { value.savedAt = 'not-a-time'; },
  ]) {
    const changed = structuredClone(receipt);
    change(changed);
    assert.throws(() => verifySaveReceipt(changed, record));
  }
});

test('交接使用实际回执路径、媒体身份、数量和执行边界，不伪补截图', () => {
  const { record, receipt } = fixture();
  const handoff = createReviewHandoff(verifySaveReceipt(receipt, record));
  assert.ok(handoff.text.includes(JSON.stringify(receipt.recordPath)));
  assert.ok(handoff.text.includes(record.media.fingerprint));
  assert.ok(handoff.text.includes(record.media.name));
  assert.match(handoff.text, /共 3 条意见（修改 1、保留 1、待讨论 1）/u);
  assert.match(handoff.text, /待讨论项先和我确认/u);
  assert.match(handoff.text, /无法确定源素材位置/u);
  assert.match(handoff.text, /不要覆盖原素材/u);
  assert.match(handoff.text, /不要自行上传或发布/u);
  assert.match(handoff.text, /不要猜补/u);
  receipt.record.notes[0].text = '外部后来改变的数据';
  assert.equal(handoff.record.notes[0].text, '【隔离测试】只用于验证交接。');
});

test('媒体名称中的引号与换行保持为引用数据，不变成新的交接段落', () => {
  const { receipt } = fixture();
  receipt.record.media.name = '带"引号\n素材.mp4';
  const handoff = createReviewHandoff(receipt);
  assert.ok(handoff.text.split('\n')[0].includes('带\\"引号\\n素材.mp4'));
});
