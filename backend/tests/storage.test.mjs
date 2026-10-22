import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFiles, revision } from '../core/storage.mjs';
import { LearningService } from '../core/service.mjs';
import { toHtml, toDocx } from '../core/export.mjs';

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zhixi-test-'));
test('旧版拒绝创建和导入 SQLite 项目及未完成初始化目录', () => {
  const newHome = fixture(); fs.writeFileSync(path.join(newHome, 'app.db'), 'preserve-new-workspace');
  assert.throws(() => new LearningService(newHome), { code: 'DATA_ROOT_CONFLICT' });
  assert.equal(fs.existsSync(path.join(newHome, 'projects.json')), false);
  assert.equal(fs.readFileSync(path.join(newHome, 'app.db'), 'utf8'), 'preserve-new-workspace');
  const service = new LearningService(fixture(), { environmentKey: '' });
  for (const marker of ['project.db', 'creating.id']) {
    const root = fixture(); fs.mkdirSync(path.join(root, '.zhixi')); fs.writeFileSync(path.join(root, '.zhixi', marker), 'preserve');
    assert.throws(() => service.createProject({ name: '混用', directory: root }), { code: 'DIRECTORY_CONFLICT' });
    assert.throws(() => service.importProject({ directory: root }), { code: 'DIRECTORY_CONFLICT' });
    assert.equal(fs.readFileSync(path.join(root, '.zhixi', marker), 'utf8'), 'preserve');
    assert.equal(fs.existsSync(path.join(root, '.zhixi/state.json')), false);
  }
});
test('文件工具拒绝越界、内部目录及外部链接', () => {
  const root = fixture(); const outside = fixture(); fs.writeFileSync(path.join(outside, 'secret.md'), 'private'); const files = new WorkspaceFiles(root);
  assert.throws(() => files.read('../secret.md'), /内部|超出/);
  assert.throws(() => files.write('.zhixi/state.md', 'x', null), /内部/);
  assert.throws(() => files.read(path.join(outside, 'secret.md')), /相对路径/);
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.read('linked/secret.md'), /链接目标/);
  assert.throws(() => files.write('linked/new.md', 'no', null), /链接目标/);
  assert.equal(fs.existsSync(path.join(outside,'new.md')), false);
});
test('写文件 revision 检查、外部修改与旧版本恢复', () => {
  const root = fixture(); const files = new WorkspaceFiles(root);
  const first = files.write('notes/a.md', '# 初版', null);
  fs.writeFileSync(path.join(root, 'notes/a.md'), '# 用户修改', 'utf8');
  assert.throws(() => files.write('notes/a.md', '覆盖', first.revision), e => e.code === 'REVISION_CONFLICT');
  assert.equal(files.read('notes/a.md').content, '# 用户修改');
  files.write('notes/a.md', '# 合并版', revision('# 用户修改'));
  assert.equal(files.versions('notes/a.md')[0].content, '# 用户修改');
});
test('项目与会话重启恢复，自动总结重生成保留手动内容', async () => {
  const home = fixture(); const service = new LearningService(home, { environmentKey: '' });
  const p = service.createProject({ name: '回归项目' }); const session = await service.startSession({ projectId: p.id, topic: 'Java 线程池', demo: true });
  await service.answer({ projectId: p.id, sessionId: session.id, content: '我想先根据代码说明条件。' });
  const first = await service.endSession({ projectId: p.id, sessionId: session.id });
  const modified = service.writeFile({ projectId:p.id, file:first.path, content:'手动保留内容', expectedRevision:first.revision });
  const second = await service.summarize({ projectId:p.id, sessionId:session.id }); assert.notEqual(first.path, second.path);
  const restored = new LearningService(home, { environmentKey:'' });
  assert.equal(restored.repo.load(p.id).sessions[0].messages.some(m => m.role === 'user'), true);
  assert.equal(restored.readFile({ projectId:p.id,file:modified.path }).content, '手动保留内容');
  assert.equal(restored.repo.load(p.id).sessions[0].status,'completed');
});
test('提示词项目优先、用户回退、默认恢复，记忆作为 Markdown 内容源', async () => {
  const service = new LearningService(fixture(), { environmentKey:'' }); const p = service.createProject({ name:'提示词' });
  assert.equal(service.prompts({projectId:p.id}).scope,'default');
  service.savePrompt({projectId:p.id,scope:'user',content:'用户教学约定',expectedRevision:null});
  let prompts = service.prompts({projectId:p.id}); assert.equal(prompts.scope,'user');
  service.savePrompt({projectId:p.id,scope:'project',content:'项目约定',expectedRevision:prompts.project.revision});
  prompts = service.prompts({projectId:p.id}); assert.equal(prompts.effective,'项目约定');
  service.savePrompt({projectId:p.id,scope:'project',content:' ',expectedRevision:prompts.project.revision}); assert.equal(service.prompts({projectId:p.id}).scope,'user');
  const memory = service.memory({projectId:p.id}); service.saveMemory({projectId:p.id,content:'偏好代码例子',expectedRevision:memory.revision});
  assert.match((await service.context(p.id)).text,/偏好代码例子/);
  service.pauseMemory({projectId:p.id,paused:true}); assert.doesNotMatch((await service.context(p.id)).text,/偏好代码例子/);
});
test('离线保存任务保留待同步状态，不假报已启用', async () => {
  const service = new LearningService(fixture(), { environmentKey:'' }); const p = service.createProject({name:'任务'});
  await service.saveTask({projectId:p.id,task:{title:'复习',body:'预备正文',frequency:'daily',localTime:'2026-10-23T09:00',timezone:'Asia/Shanghai'}});
  const task = service.repo.load(p.id).tasks[0]; assert.equal(task.status,'pending_sync'); assert.match(task.syncError,/配置/);
});
test('导出真正 DOCX 容器，HTML 去除脚本和危险链接', async () => {
  const markdown = '# 中文学习记录\n\n|知识点|状态|\n|---|---|\n|线程池|待确认|\n\n```java\nint n = 1;\n```\n\n<script>alert(1)</script>\n\n[链接](javascript:alert(1))';
  const html = toHtml(markdown); assert.doesNotMatch(html,/<script>/); assert.doesNotMatch(html,/href="javascript/); assert.match(html,/中文学习记录/);
  const buffer = await toDocx(markdown); assert.equal(buffer.subarray(0,2).toString(),'PK'); assert.ok(buffer.length > 1000);
});
test('未核实反馈、未验证策略不得直接启用', async () => {
  const service = new LearningService(fixture(), { environmentKey:'' }); const p = service.createProject({name:'策略'});
  const feedback = service.feedback({projectId:p.id,text:'疑似误判'});
  await assert.rejects(service.createStrategy({projectId:p.id,feedbackId:feedback.id}),/核对/);
  const verified = service.feedback({projectId:p.id,text:'已核对的歧义',verified:true});
  const strategy = await service.createStrategy({projectId:p.id,feedbackId:verified.id});
  assert.throws(() => service.activateStrategy({projectId:p.id,strategyId:strategy.id}),/真实评测/);
  service.reviewCase({projectId:p.id,strategyId:strategy.id,caseId:'case-1',reviewed:true,expected:'correct'});
  assert.equal(service.repo.load(p.id).strategies[0].reviewedCases.length,1);
  service.rollbackStrategy({projectId:p.id}); assert.equal(service.repo.load(p.id).activeStrategyId,null);
});
