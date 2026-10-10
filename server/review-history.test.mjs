import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReviewServer } from './app.mjs';

const fingerprint='a'.repeat(64), draftFingerprint='b'.repeat(64);
const identity=(fp=fingerprint)=>({name:fp===fingerprint?'已标记的视频.mp4':'尚未保存的录音.wav',size:2048,type:fp===fingerprint?'video/mp4':'audio/wav',durationMs:16000,fingerprint:fp});
const blank=()=>({id:null,mode:null,kind:'modify',topic:null,startText:'',endText:'',text:'',rect:null,frameMs:null,reference:null,snapshot:null});
const workspace=(fp=draftFingerprint)=>({format:'media-review-workspace/v1',media:identity(fp),currentMs:5000,notes:[],baseNotes:[],dirty:false,newDraft:{...blank(),mode:'point',startText:'00:05.000',text:'隔离草稿，不能算正式意见'},editDraft:blank(),parked:[],view:{kind:'new'}});
async function fixture(t,locationOpener) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'review-history-test-')),root=path.join(temporary,'workspace/media-review-desk');
  await fs.mkdir(path.join(root,'dist'),{recursive:true});await fs.writeFile(path.join(root,'dist/index.html'),'<html><head></head><body>隔离测试</body></html>');
  const app=await createReviewServer({rootDir:root,locationOpener,idleMs:10000,maxLifetimeMs:60000});
  t.after(async()=>{await app.close();await fs.rm(temporary,{recursive:true,force:true});});
  const token=/window\.__REVIEW_SESSION_TOKEN__="([a-f0-9]+)"/u.exec(await(await fetch(app.url)).text())[1];
  const post=(route,body,headers={})=>fetch(app.url+route,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Review-Token':token,...headers},body:JSON.stringify(body)});
  return {root,temporary,reviews:path.join(root,'reviews'),post,...app};
}

test('历史汇总真实保存与恢复副本、去重并区分草稿；v1读取不迁移、不泄露意见正文',async t=>{
  const app=await fixture(t,async()=>{});
  const record={format:'ai-carry-media-review/v1',media:identity(),notes:[{id:'original',kind:'modify',startMs:2000,endMs:null,text:'私有正文不应进入历史摘要',rect:null}]};
  const file=path.join(app.reviews,`${fingerprint}.review.json`), bytes=JSON.stringify(record,null,3)+'\n';await fs.writeFile(file,bytes);
  const same=workspace(fingerprint);same.notes=record.notes;same.baseNotes=record.notes;same.newDraft=blank();
  assert.equal((await app.post('/api/workspace/save',same)).status,200);
  assert.equal((await app.post('/api/workspace/save',workspace())).status,200);
  const history=await(await app.post('/api/history/list',{})).json();assert.equal(history.items.length,2);assert.equal(history.directory,app.reviews.replaceAll('\\','/'));
  const saved=history.items.find(item=>item.fingerprint===fingerprint);assert.equal(saved.savedNotes,1);assert.equal(saved.hasDraft,false);assert.equal(saved.name,record.media.name);
  const draft=history.items.find(item=>item.fingerprint===draftFingerprint);assert.equal(draft.savedNotes,null);assert.equal(draft.hasDraft,true);assert.equal(draft.recordPath,null);assert.ok(draft.workspacePath.endsWith('.workspace.json'));
  assert.equal(JSON.stringify(history).includes(record.notes[0].text),false);assert.equal(JSON.stringify(history).includes(workspace().newDraft.text),false);assert.equal(await fs.readFile(file,'utf8'),bytes);
  same.view={kind:'edit',id:'original'};same.editDraft={...blank(),id:'original',mode:'point',startText:'00:03.000',text:record.notes[0].text};
  await app.post('/api/workspace/save',same);assert.equal((await(await app.post('/api/history/list',{})).json()).items.find(item=>item.fingerprint===fingerprint).hasDraft,true);
  const bad=path.join(app.reviews,`${'c'.repeat(64)}.review.json`);await fs.writeFile(bad,'broken');const listed=await(await app.post('/api/history/list',{})).json();assert.equal(listed.items.length,3);assert.ok(listed.items.find(item=>item.fingerprint==='c'.repeat(64)).errors.length);assert.equal(await fs.readFile(bad,'utf8'),'broken');
});

test('打开位置只接受认证后的固定校对目录，拒绝浏览器任意路径、未知文件和链接目录',async t=>{
  const opened=[],app=await fixture(t,async(...args)=>opened.push(args));
  await fs.writeFile(path.join(app.reviews,`${fingerprint}.review.json`),'需要检查的原记录');await app.post('/api/workspace/save',workspace());
  assert.equal((await fetch(app.url+'/api/history/list')).status,405);
  assert.equal((await app.post('/api/history/open-location',{scope:'all'},{'X-Review-Token':'wrong'})).status,403);
  for(const body of [{scope:'all',path:app.temporary},{scope:'elsewhere'},{scope:'record',fingerprint:'../../outside'},{scope:'record',fingerprint:'d'.repeat(64)}])assert.equal((await app.post('/api/history/open-location',body)).status,400);
  assert.equal(opened.length,0);
  assert.equal((await app.post('/api/history/open-location',{scope:'all'})).status,200);assert.deepEqual(opened[0],[app.reviews,null]);
  assert.equal((await app.post('/api/history/open-location',{scope:'record',fingerprint})).status,200);assert.deepEqual(opened[1],[app.reviews,path.join(app.reviews,`${fingerprint}.review.json`)]);
  assert.equal((await app.post('/api/history/open-location',{scope:'draft',fingerprint:draftFingerprint})).status,200);assert.ok(opened[2][1].endsWith('.workspace.json'));
  const outside=path.join(app.temporary,'outside'), references=path.join(app.reviews,'references');await fs.mkdir(outside);await fs.mkdir(references);
  await fs.symlink(outside,path.join(references,fingerprint),process.platform==='win32'?'junction':'dir');
  assert.equal((await app.post('/api/history/open-location',{scope:'references',fingerprint})).status,400);assert.equal(opened.length,3);
});

test('单份坏恢复副本不清空其他历史，系统未能打开文件夹不返回成功',async t=>{
  const app=await fixture(t,async()=>{throw new Error('隔离测试：系统未响应');});
  await app.post('/api/workspace/save',workspace());await fs.writeFile(path.join(app.reviews,'drafts',`${draftFingerprint}.workspace.json`),'broken');
  const listed=await(await app.post('/api/history/list',{})).json();assert.equal(listed.items.length,1);assert.ok(listed.items[0].errors.length);assert.equal(listed.items[0].savedNotes,null);
  const response=await app.post('/api/history/open-location',{scope:'all'});assert.equal(response.status,500);assert.equal((await response.json()).requested,undefined);
});
