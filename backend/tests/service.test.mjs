import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LearningService } from '../core/service.mjs';
import { evaluationCases } from '../fixtures/evaluation.mjs';

const reply = content => Response.json({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
function fixture(handler) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'zhixi-service-'));
  const service=new LearningService(home,{environmentKey:'fixture-not-a-real-key',fetcher:async(url,options)=>handler(JSON.parse(options.body),options.signal)});
  const project=service.createProject({name:'服务逻辑验收'});service.repo.saveSettings({...service.repo.settings(),demo:false});return{service,project,home};
}
const question = { question:'请说明有界队列与扩容的关系。',scope:'线程数与队列条件' };
const assessment = (evidence, extra={}) => ({feedback:'已根据原回答检查',assessment:'incorrect',knowledge:'线程池扩容条件',evidence,explanation:'需结合队列条件分析。',needs_clarification:true,next_question:'如果换成无界队列呢？',...extra});

test('注入模型桩验证5个主问题、最多2次追问、提示证据与自动总结',async()=>{
  const {service,project,home}=fixture(body=>{
    const system=body.messages[0].content;const last=body.messages.at(-1).content;
    if(last.includes('只返回 JSON'))return reply(question);
    if(system.includes('提供一个简短提示'))return reply('先核对队列是否已满。');
    if(system.includes('已保存对话生成 Markdown'))return reply('## 定制归纳\n先核对队列条件。');
    return reply(assessment('独立回答'));
  });
  const args={projectId:project.id};const session=await service.startSession({...args,topic:'Java 并发'});const original=session.messages[0].content;
  await service.hint({...args,sessionId:session.id});
  for(let i=0;i<15;i++)await service.answer({...args,sessionId:session.id,content:'独立回答'});
  const state=service.repo.load(project.id);const saved=state.sessions[0];assert.equal(saved.mainIndex,5);assert.equal(saved.status,'completed');assert.equal(state.gaps[0].history.length,15);
  assert.equal(state.gaps[0].history[0].question,original);assert.equal(state.gaps[0].history[0].assisted,true);assert.equal(state.gaps[0].history[3].assisted,false);
  assert.equal(saved.summaryPaths.length,1);assert.match(service.readFile({...args,file:saved.summaryPaths[0]}).content,/定制归纳/);
  const restarted=new LearningService(home,{environmentKey:''});assert.equal(restarted.repo.load(project.id).sessions[0].status,'completed');
});

test('模型错误不丢已发送回答，重试不重复插入，跳过不能判为掌握',async()=>{
  let fails=true;
  const {service,project}=fixture(body=>{
    if(body.messages.at(-1).content.includes('只返回 JSON'))return reply(question);
    if(fails)return Response.json({error:{code:'AllocationQuota.FreeTierOnly',message:'fixture-not-a-real-key'}},{status:403});
    return reply(assessment('跳过这道题',{assessment:'correct',needs_clarification:false}));
  });
  const args={projectId:project.id};const s=await service.startSession({...args,topic:'并发'});
  await assert.rejects(service.answer({...args,sessionId:s.id,content:'跳过这道题',action:'skip'}),e=>e.message.includes('免费额度')&&!e.message.includes('fixture-not-a-real-key'));
  assert.equal(service.repo.load(project.id).sessions[0].messages.filter(m=>m.role==='user').length,1);
  fails=false;await service.answer({...args,sessionId:s.id,content:'跳过这道题',action:'skip'});
  const state=service.repo.load(project.id);assert.equal(state.sessions[0].messages.filter(m=>m.role==='user').length,1);assert.equal(state.gaps[0].status,'待确认');
  assert.ok(state.audit.some(a=>a.tool==='model_request_failed'&&a.status==='failed'));
});

test('无法对应原回答的模型引用保持待确认，下一次请求使用新提示词',async()=>{
  const prompts=[];const {service,project}=fixture(body=>{prompts.push(body.messages[0].content);return reply(body.messages.at(-1).content.includes('只返回 JSON')?question:assessment('并非用户原话',{assessment:'correct',needs_clarification:false}));});
  const args={projectId:project.id};const s=await service.startSession({...args,topic:'并发'});
  service.savePrompt({...args,scope:'project',content:'请先要求用户举例。',expectedRevision:service.prompts(args).project.revision});
  await service.answer({...args,sessionId:s.id,content:'这是我的真实回答'});assert.match(prompts.at(-1),/请先要求用户举例/);assert.equal(service.repo.load(project.id).gaps[0].status,'待确认');
  assert.notEqual(service.repo.load(project.id).sessions[0].messages[0].promptRevision,service.repo.load(project.id).sessions[0].messages.at(-1).promptRevision);
});

test('可取消长请求，已生成的数据仍然保留',async()=>{
  let entered;const started=new Promise(r=>entered=r);const {service,project}=fixture((body,signal)=>{if(body.messages.at(-1).content.includes('只返回 JSON'))return reply(question);entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));});
  const args={projectId:project.id};const s=await service.startSession({...args,topic:'并发'});const pending=service.answer({...args,sessionId:s.id,content:'需要保留的回答'});await started;service.cancel();await assert.rejects(pending,/取消/);assert.equal(service.repo.load(project.id).sessions[0].messages.at(-1).content,'需要保留的回答');
});
test('用户暂停或删除复习摘要后，后续学习不会擅自恢复',async()=>{
  const {service,project}=fixture(()=>reply(question));const args={projectId:project.id};
  service.repo.mutate(project.id,s=>s.gaps.push({id:'g',knowledge:'队列',status:'待复测',dueAt:'2026-10-23T00:00:00Z',history:[{assessment:'incorrect',demo:false}]}));
  await service.queueDigest(project.id);const taskId=service.repo.load(project.id).tasks[0].id;
  await service.patchTask({...args,taskId,enabled:false});await service.queueDigest(project.id);assert.equal(service.repo.load(project.id).tasks[0].enabled,false);
  await service.patchTask({...args,taskId,deleted:true});await service.queueDigest(project.id);assert.equal(service.repo.load(project.id).tasks[0].deleted,true);
  await service.patchTask({...args,taskId,deleted:false,enabled:true});assert.equal(service.repo.load(project.id).tasks[0].enabled,true);assert.equal(service.repo.load(project.id).tasks[0].deleted,undefined);
});

test('注入模型桩验证40次对照、人工启用、配置变更阻止启用与版本回退',async()=>{
  let count=0;const {service,project}=fixture(body=>{
    if(!body.messages.at(-1).content.includes('题目：'))return reply('候选策略：先确认队列条件。');
    count++;const item=evaluationCases.find(c=>body.messages.at(-1).content.includes(c.question));assert.ok(item);const isAfter=body.messages[0].content.includes('候选辅助策略');
    return reply({assessment:!isAfter&&item===evaluationCases[10]?(item.expected==='correct'?'incorrect':'correct'):item.expected,reason:'测试桩固定输出，不能证明真实学习改善',needs_clarification:false,follow_up:''});
  });
  const args={projectId:project.id};const feedback=service.feedback({...args,text:'测试核对记录',verified:true});const strategy=await service.createStrategy({...args,feedbackId:feedback.id});
  for(const c of evaluationCases)service.reviewCase({...args,strategyId:strategy.id,caseId:c.id,reviewed:true,expected:c.expected});
  const report=await service.evaluateStrategy({...args,strategyId:strategy.id});assert.equal(count,40);assert.equal(report.beforeCorrect,9);assert.equal(report.afterCorrect,10);assert.equal(report.passed,true);
  service.activateStrategy({...args,strategyId:strategy.id});assert.match((await service.context(project.id)).text,/先确认队列条件/);
  service.rollbackStrategy(args);assert.equal(service.repo.load(project.id).activeStrategyId,null);service.rollbackStrategy({...args,strategyId:strategy.id});assert.equal(service.repo.load(project.id).activeStrategyId,strategy.id);
  service.savePrompt({...args,scope:'project',content:'新教学风格',expectedRevision:service.prompts(args).project.revision});assert.throws(()=>service.activateStrategy({...args,strategyId:strategy.id}),/当前模型与提示词/);
});
