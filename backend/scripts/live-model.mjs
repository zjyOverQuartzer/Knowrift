import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LearningService } from '../core/service.mjs';
const key=process.env.DASHSCOPE_API_KEY;
if(!key){console.log('SKIP：未配置 DASHSCOPE_API_KEY，未调用真实模型。');process.exit(0);}
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zhixi-live-'));
const service=new LearningService(home,{environmentKey:key});
const settings=service.repo.settings();settings.demo=false;if(process.env.DASHSCOPE_BASE_URL)settings.baseUrl=process.env.DASHSCOPE_BASE_URL;if(process.env.DASHSCOPE_MODEL)settings.model=process.env.DASHSCOPE_MODEL;service.repo.saveSettings(settings);
try{
  const check=await service.testModel();console.log(JSON.stringify({connection:true,model:check.model,response:check.text}));
  const p=service.createProject({name:'真实百炼联调'});const session=await service.startSession({projectId:p.id,topic:'Java 线程池',demo:false});
  await service.answer({projectId:p.id,sessionId:session.id,content:'线程数未达到核心线程数时，通常先尝试新建线程；达到后先尝试队列，入队失败时再看最大线程数与拒绝策略。具体还要检查运行状态。'});
  const summary=await service.endSession({projectId:p.id,sessionId:session.id});
  service.writeFile({projectId:p.id,file:'notes/工具联调来源.md',content:'# 联调材料\n\n这是一条明确的测试约定：复测时必须更换任务队列容量。',expectedRevision:null});
  await service.agent({projectId:p.id,sessionId:session.id,content:'执行文件任务：必须先使用 read_file 读取 notes/工具联调来源.md，将其中的测试约定整理成 Markdown，用 write_file 写入 summaries/agent-tool-check.md（新文件 expectedRevision 为 null），报告真实路径。仅执行这个任务。'});
  const actual=service.readFile({projectId:p.id,file:'summaries/agent-tool-check.md'});if(!actual.revision||!actual.content.includes('队列容量'))throw new Error('真实工具调用未写入预期内容');
  const state=service.repo.load(p.id);
  console.log(JSON.stringify({diagnosis:true,summaryWritten:fs.existsSync(summary.absolutePath),agentToolWrite:true,toolCalls:state.audit.filter(a=>['read_file','write_file'].includes(a.tool)).map(a=>({tool:a.tool,path:a.detail.path})),messages:state.sessions[0].messages.length,credentialPrinted:false,home}));
}catch(e){console.error(JSON.stringify({verified:false,code:e.code,message:e.message}));process.exitCode=1;}
