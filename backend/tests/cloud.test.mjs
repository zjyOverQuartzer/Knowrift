import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { buildServer } from '../cloud/server.mjs';
import { Scheduler, SchedulerStore, nextOccurrence } from '../cloud/scheduler.mjs';

const fixture = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(),'zhixi-cloud-')),'cloud.json');
test('按当地日历计算每天、每周与一次性时区任务', () => {
  const after=DateTime.fromISO('2026-10-22T02:00:00Z');
  assert.equal(nextOccurrence({frequency:'daily',localTime:'2026-10-22T09:00',timezone:'Asia/Shanghai'},after),'2026-10-23T01:00:00.000Z');
  assert.equal(nextOccurrence({frequency:'once',localTime:'2026-10-22T09:00',timezone:'Asia/Shanghai'},after),null);
  const dst=nextOccurrence({frequency:'daily',localTime:'2026-10-31T09:00',timezone:'America/New_York'},DateTime.fromISO('2026-10-31T20:00Z'));
  assert.equal(dst,'2026-11-01T14:00:00.000Z');
});
test('桌面离线时云端仍执行，重复 tick 不重复提交',async()=>{
  const store=new SchedulerStore(fixture()); const mails=[];
  store.state.users.push({id:'u',email:'user@example.test'});
  store.state.tasks.push({id:'t',userId:'u',title:'复习',body:'准备好的内容',frequency:'once',localTime:'2026-10-22T09:00',timezone:'Asia/Shanghai',enabled:true,nextRunAt:'2026-10-22T01:00:00Z'});store.save();
  const scheduler=new Scheduler(store,async mail=>{mails.push(mail);return{messageId:'test-id'};},{now:()=>DateTime.fromISO('2026-10-22T01:00:01Z')});
  await Promise.all([scheduler.tick(),scheduler.tick()]);await scheduler.tick();
  assert.equal(mails.length,1);assert.equal(store.state.runs[0].status,'submitted');assert.equal(store.state.runs[0].attempts,1);
  const restart=new SchedulerStore(store.file);assert.equal(restart.state.runs.length,1);
});
test('发信失败按1、5、15分钟重试，最终失败如实保留',async()=>{
  const store=new SchedulerStore(fixture());let now=DateTime.fromISO('2026-10-22T01:00Z');
  store.state.users.push({id:'u',email:'u@example.test'});store.state.tasks.push({id:'t',userId:'u',enabled:true,frequency:'once',nextRunAt:now.toISO(),title:'x',body:'x'});
  const worker=new Scheduler(store,async()=>{throw new Error('SMTP unavailable');},{now:()=>now});
  await worker.tick();assert.equal(store.state.runs[0].status,'retrying');assert.equal(store.state.runs[0].nextAttemptAt,now.plus({minutes:1}).toISO());
  for(const minutes of [1,5,15]){now=now.plus({minutes});await worker.tick();}
  assert.equal(store.state.runs[0].status,'failed');assert.equal(store.state.runs[0].attempts,4);
});
test('多个项目的到期复习每天合并一封，未到期项目不发送',async()=>{
  const store=new SchedulerStore(fixture());const mails=[];let now=DateTime.fromISO('2026-10-22T01:00:01Z');
  store.state.users.push({id:'u',email:'u@example.test'});
  for(const [id,dueAt] of [['java','2026-10-22T00:00:00Z'],['mq','2026-10-22T00:10:00Z'],['future','2026-10-25T00:00:00Z']])store.state.tasks.push({id,userId:'u',type:'digest',title:id,body:'电脑端复测',items:[{label:`${id}知识点`,status:'待复测',dueAt}],frequency:'daily',localTime:'2026-10-22T09:00',timezone:'Asia/Shanghai',enabled:true,nextRunAt:'2026-10-22T01:00:00Z'});
  const worker=new Scheduler(store,async mail=>{mails.push(mail);return{};},{now:()=>now});
  await worker.tick();await worker.tick();assert.equal(mails.length,1);assert.match(mails[0].text,/java知识点/);assert.match(mails[0].text,/mq知识点/);assert.doesNotMatch(mails[0].text,/future知识点/);
  now=now.plus({days:1});await worker.tick();assert.equal(mails.length,2);
});
test('摘要重试前重新读取任务，暂停项目不会继续出现在邮件中',async()=>{
  const store=new SchedulerStore(fixture());let now=DateTime.fromISO('2026-10-22T01:00:01Z');const mails=[];let fail=true;
  store.state.users.push({id:'u',email:'u@example.test'});
  for(const id of ['a','b'])store.state.tasks.push({id,userId:'u',type:'digest',title:id,body:'复习',items:[{label:id,status:'待复测',dueAt:'2026-10-21T00:00:00Z'}],frequency:'daily',localTime:'2026-10-22T09:00',timezone:'Asia/Shanghai',enabled:true,nextRunAt:'2026-10-22T01:00:00Z'});
  const worker=new Scheduler(store,async mail=>{if(fail)throw new Error('offline');mails.push(mail);return{};},{now:()=>now});
  await worker.tick();assert.equal(store.state.runs[0].status,'retrying');store.state.tasks[0].enabled=false;fail=false;now=now.plus({minutes:1});await worker.tick();
  assert.equal(mails.length,1);assert.doesNotMatch(mails[0].text,/a\n/);assert.match(mails[0].text,/b\n/);
});
test('提交中断的运行恢复为不确定，不冒充成功或盲目重发',()=>{
  const store=new SchedulerStore(fixture());store.state.runs.push({status:'sending'});
  const worker=new Scheduler(store,async()=>{});worker.recover();assert.equal(store.state.runs[0].status,'uncertain');
});
test('验证码验证、任务修改暂停删除与不同用户隔离',async()=>{
  const messages=[];const {server,store}=await buildServer({file:fixture(),mailer:{sendMail:async mail=>{messages.push(mail);return{messageId:'mock'};}}});
  try{
    const auth=async email=>{assert.equal((await server.inject({method:'POST',url:'/auth/code',payload:{email}})).statusCode,200);const code=messages.at(-1).text.match(/\d{6}/)[0];const result=await server.inject({method:'POST',url:'/auth/verify',payload:{email,code}});assert.equal(result.statusCode,200);return result.json().token;};
    const token=await auth('a@example.test');const other=await auth('b@example.test');
    const payload={title:'定时学习',body:'预备正文',frequency:'daily',localTime:'2026-10-23T09:00',timezone:'Asia/Shanghai',enabled:true};
    const headers={authorization:`Bearer ${token}`};
    assert.equal((await server.inject({method:'PUT',url:'/tasks/task1',headers,payload})).statusCode,200);
    const own=(await server.inject({method:'GET',url:'/tasks',headers})).json();assert.equal(own.tasks.length,1);
    const others=(await server.inject({method:'GET',url:'/tasks',headers:{authorization:`Bearer ${other}`}})).json();assert.equal(others.tasks.length,0);
    assert.equal((await server.inject({method:'GET',url:'/tasks'})).statusCode,401);
    await server.inject({method:'PUT',url:'/tasks/task1',headers,payload:{...payload,enabled:false}});assert.equal(store.state.tasks[0].enabled,false);
    await server.inject({method:'DELETE',url:'/tasks/task1',headers});assert.equal((await server.inject({method:'GET',url:'/tasks',headers})).json().tasks.length,0);
    assert.equal(JSON.stringify(store.state).includes(token),false);
  }finally{await server.close();}
});
