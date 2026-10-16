import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeFrameComment } from '../src/lib/frame-comment-placement.ts';
import { emptyDraft, draftProblem, draftToNote } from '../src/lib/review-draft.ts';
import { validateWorkspace } from './review-workflow.mjs';

const frame = { x: 90, y: 12, width: 640, height: 360 };
const area = { x: 0, y: 0, width: 820, height: 390 };
const card = { width: 304, height: 276 };
test('浮卡避开活动区域，四边均不越界；大框、窄屏与长卡回到正常流', () => {
  for (const [x,y] of [[92,14],[640,14],[92,280],[640,280],[360,150]]) {
    const r={x,y,width:85,height:70}; const p=placeFrameComment(area,frame,r,card);
    if (!p) continue;
    assert.ok(p.x >= 8 && p.y >= 8 && p.x+p.width <= area.width-8 && p.y+p.height <= area.height-8);
    assert.ok(p.x+p.width <= x || p.x >= x+r.width || p.y+p.height <= y || p.y >= y+r.height);
  }
  assert.equal(placeFrameComment(area,frame,frame,card),null);
  assert.equal(placeFrameComment({...area,width:400},frame,{x:20,y:20,width:40,height:40},card),null);
  assert.equal(placeFrameComment(area,frame,{x:20,y:20,width:40,height:40},{...card,height:600}),null);
});
test('竖屏优先使用画面外的侧边留白', () => {
  const f={x:350,y:10,width:180,height:320},r={x:390,y:70,width:50,height:60};
  const p=placeFrameComment({...area,width:1000},f,r,card);
  assert.ok(p && (p.x+p.width < f.x || p.x > f.x+f.width));
});
test('新框逐框必填，旧共同意见兼容；长文、空白草稿恢复不丢状态', () => {
  const rect={x:.1,y:.1,width:.2,height:.2};
  const d={...emptyDraft(),mode:'frame',startText:'00:01.000',frameMs:1000,reference:{frameMs:1000,fileName:'a'.repeat(64)+'.jpg',width:960,height:540},regions:[{id:1,rect,text:'已填写'},{id:3,rect,text:''}]};
  delete d.rect;
  assert.match(draftProblem(d,6000),/框 3/);
  assert.match(draftProblem({...d,text:'共同文字'},6000),/框 3/);
  assert.match(draftProblem({...d,regions:[{id:1,rect,text:' \n '}]},6000),/框 1/);
  const media={name:'fixture.mp4',size:100,type:'video/mp4',durationMs:6000,fingerprint:'a'.repeat(64)};
  const workspace={format:'media-review-workspace/v4',media,currentMs:1000,notes:[],baseNotes:[],dirty:false,newDraft:d,editDraft:emptyDraft(),parked:[],view:{kind:'new'}};
  assert.equal(validateWorkspace(workspace).newDraft.regions[1].text,'');
  const long='修改字幕位置。'.repeat(250);
  const saved=draftToNote({...d,regions:d.regions.map(r=>({...r,text:long}))},6000);
  assert.deepEqual(saved.regions.map(r=>r.id),[1,3]); assert.equal(saved.regions[1].text,long);
  assert.equal(draftProblem({...d,text:'旧共同意见',regions:[{id:1,rect}]},6000),'');
  assert.match(draftProblem({...d,regions:[{id:1,rect,text:'字'.repeat(2001)}]},6000),/2000/);
});
