import { _electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import http from 'node:http';
const output = process.env.ZHIXI_QA_OUTPUT || path.join(os.tmpdir(), 'zhixi-qa'); fs.mkdirSync(output,{recursive:true});
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zhixi-e2e-'));
const env={...process.env,ZHIXI_HOME:home,DASHSCOPE_API_KEY:'',OPENAI_API_KEY:''};delete env.ELECTRON_RUN_AS_NODE;
const launchOptions={...(process.env.ZHIXI_TEST_EXECUTABLE?{executablePath:process.env.ZHIXI_TEST_EXECUTABLE,args:[]}:{args:['.']}),cwd:process.cwd(),env,timeout:30000};
let app;let receivedCredential=false;
const mockModel=http.createServer(async(req,res)=>{for await(const part of req){}receivedCredential=req.headers.authorization==='Bearer zhixi-qa-not-a-real-key';res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'连接成功（本地测试桩）'}}]}));});
await new Promise(r=>mockModel.listen(0,'127.0.0.1',r));
try{
  app=await _electron.launch(launchOptions);
  app.process().stderr?.on('data',d=>process.stderr.write(d));
  const page=await app.firstWindow();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.getByRole('heading',{name:'从一个问题，发现理解的缺口'}).waitFor();
  await page.screenshot({path:path.join(output,'workbench.png')});
  await page.getByLabel('输入你的回答').fill('我希望先看代码示例，再解释队列和线程数的关系。');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('示例模式只演示追问与记录流程',{exact:false}).waitFor();
  await page.getByRole('button',{name:'结束本轮并生成总结'}).click();
  await page.getByRole('status').filter({hasText:'Markdown 总结已生成'}).waitFor();
  await page.locator('.message').first().hover();await page.getByLabel('选择消息',{exact:true}).first().check();await page.getByRole('button',{name:'导出所选',exact:true}).click();
  for(const [format,label] of [['md','Markdown'],['html','HTML'],['pdf','PDF'],['docx','Word']]){
    const destination=path.join(output,`ui-selected.${format}`);await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},destination);
    await page.locator('.format-options button').filter({hasText:new RegExp('^'+label)}).click();await page.getByRole('button',{name:'选择位置并导出',exact:true}).click();await page.getByText('已保存：'+destination,{exact:true}).waitFor();assert.ok(fs.statSync(destination).size>30);
  }
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});await page.getByRole('button',{name:'选择位置并导出',exact:true}).click();await page.getByRole('button',{name:'选择位置并导出',exact:true}).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'文档与文件',exact:true}).click();
  await page.locator('.file-list button').filter({hasText:'summaries/'}).first().click();
  const editor=page.getByLabel('文件内容');await editor.waitFor();const original=await editor.inputValue();
  await editor.fill(original+'\n\n用户手动补充：保留这段内容。');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已保存本地文件'}).waitFor();
  await page.screenshot({path:path.join(output,'files.png')});
  await page.getByRole('button',{name:'查看历史版本',exact:true}).click();await page.getByRole('button',{name:'载入此版本到编辑器',exact:true}).first().waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'记忆',exact:true}).click();await page.getByLabel('记忆内容').fill('我偏好代码示例和条件分析。');
  await page.getByRole('button',{name:'保存记忆'}).click();await page.getByRole('status').filter({hasText:'记忆已保存'}).waitFor();
  await page.getByRole('button',{name:'提示词',exact:true}).click();await page.getByLabel('自定义提示词').fill('请每次只问一个问题，并优先使用 Java 代码示例。');
  await page.getByRole('button',{name:'保存提示词'}).click();await page.getByRole('paragraph').filter({hasText:'请每次只问一个问题，并优先使用 Java 代码示例。'}).waitFor();
  await page.getByRole('button',{name:'定时任务',exact:true}).click();await page.getByRole('button',{name:'新建任务',exact:true}).click();
  await page.getByLabel('任务名称').fill('离线复习任务');await page.getByLabel('邮件正文').fill('提醒我复习线程池。');await page.getByRole('button',{name:'确认保存任务'}).click();
  await page.getByText('待同步',{exact:true}).waitFor();await page.screenshot({path:path.join(output,'tasks.png')});
  const taskRow=page.getByRole('row').filter({hasText:'离线复习任务'});await taskRow.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('邮件正文').fill('更新后的预备正文');await page.getByLabel('重复规则').selectOption('daily');await page.getByRole('button',{name:'确认保存任务',exact:true}).click();await taskRow.getByText('更新后的预备正文',{exact:true}).waitFor();await taskRow.getByRole('button',{name:'暂停任务',exact:true}).click();await taskRow.getByText('暂停待同步',{exact:true}).waitFor();await taskRow.getByRole('button',{name:'恢复任务',exact:true}).click();await taskRow.getByText('待同步',{exact:true}).waitFor();
  await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByLabel('任务名称').fill('离线取消验证');await page.getByLabel('邮件正文').fill('删除同步前仍显示状态');await page.getByRole('button',{name:'确认保存任务',exact:true}).click();const deleting=page.getByRole('row').filter({hasText:'离线取消验证'});await deleting.getByRole('button',{name:'删除',exact:true}).click();await deleting.getByText('删除待同步',{exact:true}).waitFor();await deleting.getByText('云端取消尚未确认',{exact:true}).waitFor();
  await page.getByRole('button',{name:'策略优化',exact:true}).click();await page.getByLabel('问题反馈').fill('题目未说明队列类型，条件不足，已对照资料核对。');
  await page.getByLabel('我已通过资料或实际记录核对上述问题').check();await page.getByRole('button',{name:'保存反馈并生成候选'}).click();
  await page.getByText('候选规则（示例，待验证）',{exact:false}).waitFor();await page.screenshot({path:path.join(output,'strategies.png')});
  assert.equal(await page.getByRole('button',{name:'确认启用此版本'}).isDisabled(),true);
  await page.getByRole('button',{name:'核对样例（0/20）',exact:true}).click();const firstCase=page.locator('.cases-list .evidence').first();await firstCase.getByRole('checkbox').check();await page.getByRole('button',{name:'核对样例（1/20）',exact:true}).waitFor();await firstCase.getByRole('checkbox').uncheck();await page.getByRole('button',{name:'关闭',exact:true}).click();
  // 以下为导出与安全存储的主进程专用诊断，交互验收由上方真实控件完成。
  const pdf=await app.evaluate(async({BrowserWindow})=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});try{await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html lang="zh"><meta charset="UTF-8"><body style="font-family:Microsoft YaHei"><h1>知隙中文导出验证</h1><p>线程池与任务队列</p></body></html>'));return(await w.webContents.printToPDF({pageSize:'A4'})).toString('base64');}finally{w.destroy();}});
  fs.writeFileSync(path.join(output,'native-print.pdf'),Buffer.from(pdf,'base64'));
  const {LearningService}=await import('@knowrift/backend');const service=new LearningService(home,{environmentKey:''});const p=service.repo.projects()[0];const s=service.repo.load(p.id).sessions[0];
  for(const format of ['md','html','docx']){const result=await service.exportContent({projectId:p.id,sessionId:s.id,format});fs.writeFileSync(path.join(output,`learning.${format}`),result.buffer);}
  const html=await service.exportContent({projectId:p.id,sessionId:s.id,format:'pdf'});
  const actualPdf=await app.evaluate(async({BrowserWindow},html)=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});try{await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));return(await w.webContents.printToPDF({pageSize:'A4',printBackground:true,preferCSSPageSize:true})).toString('base64');}finally{w.destroy();}},html.buffer.toString());
  fs.writeFileSync(path.join(output,'learning.pdf'),Buffer.from(actualPdf,'base64'));
  const fixture=fs.readFileSync(new URL('./fixtures/export-layout.md',import.meta.url),'utf8');service.writeFile({projectId:p.id,file:'notes/排版验收.md',content:fixture,expectedRevision:null});
  for(const format of ['md','html','docx','pdf']){
    const result=await service.exportContent({projectId:p.id,file:'notes/排版验收.md',format});
    if(format!=='pdf')fs.writeFileSync(path.join(output,`layout.${format}`),result.buffer);
    else{const printed=await app.evaluate(async({BrowserWindow},html)=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});try{await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));return(await w.webContents.printToPDF({pageSize:'A4',printBackground:true,preferCSSPageSize:true})).toString('base64');}finally{w.destroy();}},result.buffer.toString());fs.writeFileSync(path.join(output,'layout.pdf'),Buffer.from(printed,'base64'));}
  }
  const secure=await app.evaluate(async({safeStorage})=>{const value='zhixi-qa-not-a-real-key';const encrypted=await safeStorage.encryptStringAsync(value);const decoded=await safeStorage.decryptStringAsync(encrypted);return{roundtrip:(typeof decoded==='string'?decoded:decoded.result)===value,encrypted:!encrypted.includes(Buffer.from(value))};});
  assert.equal(secure.roundtrip,true);assert.equal(secure.encrypted,true);assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByLabel('模型接口地址',{exact:true}).fill(`http://127.0.0.1:${mockModel.address().port}`);await page.getByLabel('模型密钥',{exact:true}).fill('zhixi-qa-not-a-real-key');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('status').filter({hasText:'配置已保存'}).waitFor();
  await page.getByRole('button',{name:'测试已保存的连接',exact:true}).click();await page.getByRole('status').filter({hasText:'连接成功（本地测试桩）'}).waitFor();assert.equal(receivedCredential,true);
  assert.equal(fs.readFileSync(path.join(home,'credentials.json'),'utf8').includes('zhixi-qa-not-a-real-key'),false);
  await page.getByRole('button',{name:'新建项目',exact:true}).click();await page.getByLabel('项目名称',{exact:true}).fill('独立项目B');await page.getByRole('button',{name:'创建项目',exact:true}).click();await page.getByRole('heading',{name:'准备开始诊断',exact:true}).waitFor();await page.getByLabel('选择主题',{exact:true}).fill('只属于项目B的主题');await page.getByRole('button',{name:'开始诊断',exact:true}).click();await page.getByRole('heading',{name:'只属于项目B的主题',exact:true}).waitFor();
  await page.locator('.project-list').getByRole('button',{name:'Java 后端学习',exact:true}).click();await page.locator('.breadcrumb').getByText('Java 后端学习',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'只属于项目B的主题',exact:true}).count(),0);
  await page.locator('.project-list').getByRole('button',{name:'独立项目B',exact:true}).click();await page.getByRole('heading',{name:'只属于项目B的主题',exact:true}).waitFor();await page.locator('.project-list').getByRole('button',{name:'Java 后端学习',exact:true}).click();await page.locator('.breadcrumb').getByText('Java 后端学习',{exact:true}).waitFor();
  await app.close();app=await _electron.launch(launchOptions);const reopened=await app.firstWindow();reopened.setDefaultTimeout(12000);await reopened.getByRole('heading',{name:'从一个问题，发现理解的缺口'}).waitFor();await reopened.getByRole('button',{name:'定时任务',exact:true}).click();await reopened.getByText('离线复习任务',{exact:true}).waitFor();await reopened.getByRole('button',{name:'设置',exact:true}).click();receivedCredential=false;await reopened.getByRole('button',{name:'测试已保存的连接',exact:true}).click();await reopened.getByRole('status').filter({hasText:'连接成功（本地测试桩）'}).waitFor();assert.equal(receivedCredential,true);
  console.log(JSON.stringify({electronUi:true,packaged:Boolean(process.env.ZHIXI_TEST_EXECUTABLE),scenarios:['diagnosis','summary','file-edit','history','memory','prompt','offline-task','strategy-gate','four-ui-exports','export-cancel','system-encryption','project-isolation','restart','saved-connection'],rendererErrors:errors,output,home}));
}catch(e){console.error(e.stack);if(app)console.error((await app.windows()).length+' windows');process.exitCode=1;}
finally{if(app)await app.close();await new Promise(r=>mockModel.close(r));}
