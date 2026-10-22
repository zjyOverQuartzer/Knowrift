import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelClient, validateBaseUrl } from '../core/model.mjs';
import { WorkspaceFiles } from '../core/storage.mjs';

test('兼容模型请求的真实 HTTP 工具循环与越权拒绝',async()=>{
  let round=0;const observed=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);observed.push(body);let message;
    if(round++===0)message={role:'assistant',content:null,tool_calls:[{id:'t1',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'summaries/result.md',content:'# 工具生成总结',expectedRevision:null})}},{id:'t2',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'../outside.md',content:'x',expectedRevision:null})}}]};
    else message={role:'assistant',content:'已完成授权目录内写入。'};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{total_tokens:10}}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const root=fs.mkdtempSync(path.join(os.tmpdir(),'zhixi-agent-'));const client=new ModelClient({baseUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture'},'test-only-not-a-real-key');const result=await client.agent([{role:'user',content:'写总结'}],new WorkspaceFiles(root));assert.match(result,/完成/);assert.equal(fs.readFileSync(path.join(root,'summaries/result.md'),'utf8'),'# 工具生成总结');assert.equal(observed[1].messages.some(m=>m.role==='tool'&&m.content.includes('PATH_DENIED')),true);}finally{await new Promise(r=>server.close(r));}
});
test('接口配置拒绝明文远程地址与 URL 内凭据',()=>{
  assert.throws(()=>validateBaseUrl('http://example.com/v1'),/HTTPS/);assert.throws(()=>validateBaseUrl('https://user:pass@example.com/v1'),/凭据/);assert.equal(validateBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/'),'https://dashscope.aliyuncs.com/compatible-mode/v1');
});
