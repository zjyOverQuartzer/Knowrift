import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../cloud/server.mjs';
import { LearningService } from '../core/service.mjs';

test('桌面经过真实HTTP验证邮箱、同步、暂停与删除云端任务',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zhixi-sync-'));const mails=[];
  const {server,store}=await buildServer({file:path.join(root,'cloud.json'),mailer:{sendMail:async mail=>{mails.push(mail);return{messageId:'test-channel'};}}});
  await server.listen({port:0,host:'127.0.0.1'});
  const secrets=new Map();const service=new LearningService(path.join(root,'desktop'),{environmentKey:'',secrets:{get:async name=>secrets.get(name)||'',set:async(name,value)=>secrets.set(name,value)}});
  try{
    const project=service.createProject({name:'HTTP同步验收'});const args={projectId:project.id};
    await service.saveSettings({cloudUrl:`http://127.0.0.1:${server.server.address().port}`,email:'owner@example.test'});await service.cloudRequestCode({email:'owner@example.test'});const code=mails.at(-1).text.match(/\d{6}/)[0];await service.cloudVerify({email:'owner@example.test',code});
    const future=new Date(Date.now()+86400000).toISOString().slice(0,16);const item=await service.saveTask({...args,task:{title:'复习',body:'预先准备的邮件',frequency:'once',timezone:'UTC',localTime:future,enabled:true}});
    assert.equal(service.repo.load(project.id).tasks[0].status,'synced');assert.equal(store.state.tasks[0].body,'预先准备的邮件');
    await assert.rejects(service.saveSettings({email:'other@example.test'}),/先暂停/);
    await service.patchTask({...args,taskId:item.id,enabled:false});assert.equal(store.state.tasks[0].enabled,false);
    await service.patchTask({...args,taskId:item.id,deleted:true});assert.equal(store.state.tasks[0].deleted,true);assert.equal(service.repo.load(project.id).tasks[0].status,'synced');
  }finally{await server.close();}
});
