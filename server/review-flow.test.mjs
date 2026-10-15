import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReviewServer } from './app.mjs';
import { validateRecord, FLOW_FORMAT } from './review-record.mjs';
import { validateWorkspace } from './review-workflow.mjs';
import { ReviewTasks } from './review-tasks.mjs';
import { exportReview } from './review-export.mjs';
import { emptyDraft, draftToNote, draftProblem } from '../src/lib/review-draft.ts';
import { createReviewHandoff } from '../src/lib/review-handoff.ts';
const fingerprint='d'.repeat(64);
const media={name:'isolated-review.mp4',size:100,type:'video/mp4',durationMs:12000,fingerprint};
const completedAt='2026-10-15T01:00:00.000Z';
const general = draftToNote({...emptyDraft(), mode:'whole', text:'整体配乐偏大，请调低。'},12000);

test('整片意见无伪造时间，保存、恢复和交接保留范围；旧版不能接受新语义',()=>{
  assert.equal(general.startMs,null); assert.equal(general.scope,'whole');
  const record={format:FLOW_FORMAT,media,notes:[general],completion:{outcome:'with-notes',completedAt}};
  assert.deepEqual(validateRecord(record),record);
  assert.throws(()=>validateRecord({...record,notes:[{...general,startMs:0}]}));
  assert.throws(()=>validateRecord({...record,format:'ai-carry-media-review/v3'}));
  const workspace={format:'media-review-workspace/v3',media,currentMs:8000,notes:[general],baseNotes:[general],dirty:false,newDraft:{...emptyDraft(),mode:'whole',text:'新草稿'},editDraft:emptyDraft(),parked:[],view:{kind:'new'}};
  assert.deepEqual(validateWorkspace(workspace),workspace);
  assert.equal(draftProblem(workspace.newDraft,12000),'');
  assert.match(createReviewHandoff({record,recordPath:'C:/isolated/review.json',savedAt:completedAt}).text,/scope 为 whole/);
});

test('无意见完成必须明确记录且不能与意见混淆，交接不要求返修或发布',()=>{
  const record={format:FLOW_FORMAT,media,notes:[],completion:{outcome:'no-changes',completedAt}};
  assert.deepEqual(validateRecord(record),record);
  assert.throws(()=>validateRecord({...record,notes:[general]}));
  assert.throws(()=>validateRecord({...record,completion:{outcome:'with-notes',completedAt}}));
  const text=createReviewHandoff({record,recordPath:'C:/isolated/review.json',savedAt:completedAt}).text;
  assert.match(text,/没有意见/); assert.match(text,/不代表上传或发布许可/); assert.doesNotMatch(text,/交付新版本/);
  assert.equal(validateRecord({...record,completion:null}).completion,null);
});

test('v3升级v4，原字节保留；无意见结果可重读导出，旧版降级拒绝',async t=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'media-review-flow-'));
  const root=path.join(temporary,'workspace/media-review-desk');
  await fs.mkdir(path.join(root,'dist'),{recursive:true}); await fs.writeFile(path.join(root,'dist/index.html'),'<html><head></head><body>isolated</body></html>');
  const app=await createReviewServer({rootDir:root,idleMs:10000,maxLifetimeMs:60000});
  t.after(async()=>{await app.close(); assert.equal(path.dirname(temporary),path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('media-review-flow-')); await fs.rm(temporary,{recursive:true,force:true});});
  const token=/window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]{64})"/u.exec(await(await fetch(app.url)).text())[1];
  const post=(route,value)=>fetch(app.url+route,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Review-Token':token},body:JSON.stringify(value)});
  const old={format:'ai-carry-media-review/v3',media,notes:[]};
  const first=await(await post('/api/reviews/save',{record:old,baseRevision:null})).json();
  const file=path.join(root,'reviews',fingerprint+'.review.json'),bytes=await fs.readFile(file);
  const record={format:FLOW_FORMAT,media,notes:[],completion:{outcome:'no-changes',completedAt}};
  const response=await post('/api/reviews/save',{record,baseRevision:first.revision}); assert.equal(response.status,200);
  const receipt=await response.json(); assert.deepEqual(receipt.record,record);
  assert.deepEqual((await(await post('/api/reviews/load',{fingerprint})).json()).record,record);
  const backups=(await fs.readdir(path.dirname(file))).filter(name=>name.endsWith('.v3.backup.json'));
  assert.equal(backups.length,1); assert.deepEqual(await fs.readFile(path.join(path.dirname(file),backups[0])),bytes);
  assert.equal((await post('/api/reviews/save',{record:old,baseRevision:receipt.revision})).status,400);
  const out=path.join(temporary,'export');await exportReview(root,fingerprint,out);
  assert.match(await fs.readFile(path.join(out,'返修清单.md'),'utf8'),/本轮已审阅，没有意见/);
});

test('搜索先匹配全部任务再分页，支持文件名、来源、ID与已结束任务',()=>{
  const tasks=new ReviewTasks('unused','unused');
  for(let i=0;i<18;i++) tasks.remember({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,title:i===0?'目标成片':'校对 '+i,label:i===0?'湖衫来源':'隔离测试',status:i===17?'closed':'waiting',createdAt:new Date(2026,0,i+1).toISOString(),media:{...media,name:i===0?'final.MP4':i+'.mp4'},jobs:{}});
  assert.equal(tasks.list({limit:8}).items.some(task=>task.title==='目标成片'),false);
  for(const query of ['目标','湖衫','FINAL.mp4','00000000-0000-4000-8000-000000000000','目标 湖衫']) assert.equal(tasks.list({limit:8,query}).items[0].title,'目标成片');
  assert.equal(tasks.list({query:'17.mp4'}).total,0);
  assert.equal(tasks.list({closed:true,query:'17.mp4'}).total,1);
  assert.equal(tasks.list({query:'不匹配'}).total,0);
  assert.throws(()=>tasks.list({query:'a'.repeat(161)}));
});
