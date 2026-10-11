import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReviewServer } from './app.mjs';
import { enqueueMedia, identifyFile } from './review-workflow.mjs';
import { exportReview } from './review-export.mjs';

async function fixture(t, options={}) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'review-workflow-test-'));
  const root=path.join(temporary,'workspace/media-review-desk'); await fs.mkdir(path.join(root,'dist'),{recursive:true});
  await fs.writeFile(path.join(root,'dist/index.html'),'<html><head></head><body>隔离测试</body></html>');
  const app=await createReviewServer({rootDir:root,idleMs:10000,maxLifetimeMs:60000,...options});
  t.after(async()=>{await app.close(); await fs.rm(temporary,{recursive:true});});
  const token=/window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]+)"/u.exec(await(await fetch(app.url)).text())[1];
  const revisions = new Map();
  const post = async (route, body, headers = {}) => {
    if (route === '/api/reviews/save') body = { record: body, baseRevision: revisions.get(body.media.fingerprint) ?? null };
    const response = await fetch(app.url + route, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Review-Token': token, ...headers }, body: JSON.stringify(body) });
    if (response.ok && ['/api/reviews/save', '/api/reviews/load'].includes(route)) { const value = await response.clone().json(); revisions.set(value.record?.media.fingerprint ?? body.fingerprint, value.revision); }
    return response;
  };
  const source=path.join(temporary,'isolated.mp4'); await fs.writeFile(source,Buffer.alloc(2048,3));
  return {root,temporary,source,post,...app};
}
const blank=()=>({id:null,mode:null,kind:'modify',topic:null,startText:'',endText:'',text:'',rect:null,frameMs:null,reference:null,snapshot:null});
const media=()=>({name:'isolated.mp4',size:2048,type:'video/mp4',durationMs:16000,fingerprint:'d'.repeat(64)});

test('CLI登记仅授权指定媒体；私有接口拒绝任意路径与无效会话，媒体变化不冒充原片',async t=>{
  const app=await fixture(t); const input=await enqueueMedia(app.root,app.source);
  const current=await(await app.post('/api/workflow/current',{})).json(); assert.equal(current.media.fingerprint,input.fingerprint); assert.equal(Object.hasOwn(current.media,'source'),false);
  assert.equal((await fetch(app.url+'/api/workflow/media')).status,405);
  assert.equal((await app.post('/api/workflow/media',{id:input.id},{'X-Review-Token':'wrong'})).status,403);
  assert.equal((await app.post('/api/workflow/media',{id:input.id,path:app.source})).status,400);
  assert.equal((await app.post('/api/workflow/media',{id:'../../not-authorized'})).status,400);
  const response=await app.post('/api/workflow/media',{id:input.id}); assert.equal(response.status,200); assert.deepEqual(Buffer.from(await response.arrayBuffer()),await fs.readFile(app.source));
  await fs.appendFile(app.source,'changed'); assert.equal((await app.post('/api/workflow/current',{})).status,400);
});

test('恢复副本保存未完成草稿，不等于正式意见；损坏内容保留，非法结构拒绝',async t=>{
  const app=await fixture(t),identity=media();
  const state={format:'media-review-workspace/v1',media:identity,currentMs:5000,notes:[],baseNotes:[],dirty:false,newDraft:{...blank(),mode:'range',startText:'00:04.000',text:'【隔离测试】尚未选完也要恢复'},editDraft:blank(),parked:[],view:{kind:'new'}};
  assert.equal((await app.post('/api/workspace/save',state)).status,200);
  const loaded=await(await app.post('/api/workspace/load',{fingerprint:identity.fingerprint})).json(); assert.deepEqual(loaded.workspace,state); assert.ok(loaded.at>0);
  assert.deepEqual((await(await app.post('/api/workspace/latest',{})).json()).workspace,state);
  const reviews=path.join(app.root,'reviews'); await assert.rejects(fs.access(path.join(reviews,`${identity.fingerprint}.review.json`)));
  assert.equal((await app.post('/api/workspace/save',{...state,extra:true})).status,400);
  const file=path.join(reviews,'drafts',`${identity.fingerprint}.workspace.json`); await fs.writeFile(file,'broken');
  assert.equal((await app.post('/api/workspace/save',state)).status,400); assert.equal(await fs.readFile(file,'utf8'),'broken');
});

test('可携带返修目录不包含源媒体或路径；真实意见回读后导出，不覆盖已有目录',async t=>{
  const app=await fixture(t),identity=media();
  const record={format:'ai-carry-media-review/v2',media:identity,notes:[{id:'user-note',kind:'discuss',startMs:3000,endMs:5000,text:'【隔离测试】只讨论，不是自动批准',rect:null,reference:null}]};
  assert.equal((await app.post('/api/reviews/save',record)).status,200);
  const out=path.join(app.temporary,'portable'); const result=await exportReview(app.root,identity.fingerprint,out); assert.equal(result.originalMediaIncluded,false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'review.json'),'utf8')),record);
  const manifest=JSON.parse(await fs.readFile(path.join(out,'package.json'),'utf8')); assert.equal(manifest.automaticallyAuthorized,false); assert.equal(JSON.stringify(manifest).includes(app.temporary),false);
  await assert.rejects(exportReview(app.root,identity.fingerprint,out));
  const response=await app.post('/api/reviews/export',{fingerprint:identity.fingerprint}); assert.equal(response.status,200); assert.equal((await response.json()).exported,true);
});

test('只发送心跳不会无限延长空闲会话',async t=>{
  const app=await fixture(t,{idleMs:1000,maxLifetimeMs:5000});
  for(let i=0;i<4;i++){await new Promise(resolve=>setTimeout(resolve,180));assert.equal((await fetch(app.url+'/api/health')).status,200);}
  await new Promise(resolve=>setTimeout(resolve,1500)); await assert.rejects(fetch(app.url+'/api/health',{signal:AbortSignal.timeout(1000)}));
});
