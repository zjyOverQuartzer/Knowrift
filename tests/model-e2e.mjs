import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from '../scripts/services.mjs';

// All credentials and models in this test are local fixtures, never real provider credentials.
const key1 = 'fixture-chat-key-not-real', key2 = 'fixture-anthropic-key-not-real';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'knowrift-model-qa-'));
const home = path.join(output, '模型配置 中文工作区');
const env = { ...process.env, ZHIXI_HOME: home, ZHIXI_BACKEND_MODE: 'java', OPENAI_API_KEY: 'must-not-be-used', DASHSCOPE_API_KEY: 'must-not-be-used' };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [], requests = [], logs = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let app;
const remote = http.createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw); requests.push({ path: request.url, headers: request.headers, body });
  if (body.model === 'blocked-fixture') return;
  if (body.model === 'rate-limit-fixture') { response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: key1 })); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  const supplied = request.headers['x-api-key'] || request.headers.authorization?.replace(/^Bearer /, '') || '本机免密';
  const content = `连接成功 ${supplied}`;
  if (request.url.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  else if (request.url.endsWith('/messages')) response.end(JSON.stringify({ content: [{ type: 'text', text: content }] }));
  else if (request.url.endsWith('/api/chat')) response.end(JSON.stringify({ message: { content }, done: true }));
  else response.end('{}');
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${remote.address().port}`;
function children(pid) {
  const script = "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('java.exe','python.exe') } | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress";
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(raw || '[]'), all = Array.isArray(parsed) ? parsed : [parsed], parents = new Set([pid]), owned = [];
  let found = true; while (found) { found = false; for (const child of all) if (!parents.has(child.ProcessId) && parents.has(child.ParentProcessId)) { parents.add(child.ProcessId); owned.push(child); found = true; } }
  return owned;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function close() {
  const owned = children(await app.evaluate(() => process.pid));
  await app.close(); app = null;
  const until = Date.now() + 12000; while (Date.now() < until && owned.some(child => alive(child.ProcessId))) await wait(100);
  assert.deepEqual(owned.filter(child => alive(child.ProcessId)), []);
}
async function launch() {
  app = await _electron.launch({ args: ['.'], cwd: root, env, timeout: 30000 });
  app.process().stdout?.on('data', value => logs.push(value.toString()));
  app.process().stderr?.on('data', value => logs.push(value.toString()));
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  assert.equal(await page.title(), '知隙 · 看见知识的缺口'); assert.ok(page.url().startsWith('file:'));
  await page.locator('[data-service="java"][data-state="ready"]').waitFor({ timeout: 65000 });
  await page.locator('[data-service="python"][data-state="ready"]').waitFor({ timeout: 65000 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor();
  return page;
}
async function add(page, name, protocol, model, key) {
  await page.getByRole('button', { name: '新增配置', exact: true }).click();
  await page.getByLabel('配置名称', { exact: true }).fill(name);
  await page.getByLabel('接口协议', { exact: true }).selectOption(protocol);
  await page.getByLabel('模型基础地址', { exact: true }).fill(base + (protocol === 'ollama' ? '' : '/v1'));
  await page.getByLabel('模型标识', { exact: true }).fill(model);
  if (protocol === 'anthropic') await page.getByLabel('Anthropic 工作区 ID', { exact: true }).fill('workspace-fixture');
  if (key) { await page.getByLabel('密钥操作', { exact: true }).selectOption('replace'); await page.getByLabel('模型 API Key', { exact: true }).fill(key); }
  await save(page);
}
async function save(page) {
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('模型配置已保存；可测试连接或设为当前配置。', { exact: true }).waitFor();
}
async function select(page, name) { await page.locator('.model-profile-list').getByRole('button').filter({ hasText: name }).click(); }
async function testConnection(page, success = true) {
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByTestId('model-test-result').filter({ hasText: success ? '连接测试成功' : '连接测试失败' }).waitFor({ timeout: 72000 });
}
try {
  let page = await launch();
  await page.getByRole('heading', { name: '添加第一套模型配置', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '学习工作台', exact: true }).isDisabled(), true);
  await add(page, '兼容接口', 'openai-compatible', 'chat-fixture', key1);
  await page.getByRole('button', { name: '设为当前配置', exact: true }).click();
  await page.getByTestId('active-model').filter({ hasText: '兼容接口' }).waitFor();
  assert.equal(requests.length, 0, 'saving and activation never call a model');
  await testConnection(page);
  assert.equal(requests.at(-1).path, '/v1/chat/completions');
  assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + key1);
  assert.equal((await page.getByTestId('model-test-result').innerText()).includes(key1), false);
  await add(page, 'Anthropic 配置', 'anthropic', 'anthropic-fixture', key2);
  await testConnection(page);
  assert.equal(requests.at(-1).path, '/v1/messages'); assert.equal(requests.at(-1).headers['x-api-key'], key2);
  assert.equal(requests.at(-1).headers['anthropic-workspace-id'], 'workspace-fixture');
  assert.equal(requests.at(-1).body.max_tokens, 1024);
  assert.match(await page.getByTestId('active-model').innerText(), /兼容接口/);
  await page.getByLabel('Anthropic 鉴权', { exact: true }).selectOption('bearer'); await save(page); await testConnection(page);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + key2);
  await add(page, '本机 Ollama', 'ollama', 'ollama-fixture'); await testConnection(page);
  assert.equal(requests.at(-1).path, '/api/chat'); assert.equal(requests.at(-1).headers.authorization, undefined);
  assert.equal(requests.at(-1).body.stream, false);
  await page.getByRole('button', { name: '设为当前配置', exact: true }).click();
  await page.getByTestId('active-model').filter({ hasText: '本机 Ollama' }).waitFor();
  await page.getByLabel('配置名称', { exact: true }).fill('本机模型重命名'); await save(page);
  await page.getByTestId('active-model').filter({ hasText: '本机模型重命名' }).waitFor();
  await page.getByLabel('模型标识', { exact: true }).fill('rate-limit-fixture'); await save(page); await testConnection(page, false);
  assert.match(await page.getByTestId('model-test-result').innerText(), /MODEL_RATE_LIMITED/);
  assert.equal((await page.getByTestId('model-test-result').innerText()).includes(key1), false);
  await page.screenshot({ path: path.join(output, 'model-error.png') });
  await page.getByLabel('模型标识', { exact: true }).fill('ollama-fixture'); await save(page);
  await page.getByLabel('模型基础地址', { exact: true }).fill(base + '/api/chat');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请填写基础地址' }).waitFor();
  await page.getByRole('button', { name: '重新加载配置', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('input[aria-label="模型基础地址"]')?.value === expected, base);
  await select(page, '兼容接口');
  await page.getByLabel('模型基础地址', { exact: true }).fill(base + '/v2');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '重新输入或显式清除密钥' }).waitFor();
  await page.getByRole('button', { name: '重新加载配置', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('input[aria-label="模型基础地址"]')?.value === expected, base + '/v1');
  const publicState = await page.evaluate(() => window.zhixi.modelSettings.list());
  assert.equal(publicState.profiles.length, 3);
  assert.equal(JSON.stringify(publicState).includes('credentialRef'), false);
  assert.equal(JSON.stringify(publicState).includes(key1), false);
  const encrypted = fs.readFileSync(path.join(home, 'credentials.json'), 'utf8');
  assert.equal(encrypted.includes(key1), false); assert.equal(encrypted.includes(key2), false);
  for (const file of ['app.db', 'app.db-wal']) if (fs.existsSync(path.join(home, file))) {
    const bytes = fs.readFileSync(path.join(home, file)); assert.equal(bytes.includes(Buffer.from(key1)), false); assert.equal(bytes.includes(Buffer.from(key2)), false);
  }
  // A Python failure leaves Java config management available.
  let owned = children(await app.evaluate(() => process.pid));
  execFileSync('taskkill.exe', ['/PID', String(owned.find(child => child.Name === 'python.exe').ProcessId), '/F'], { windowsHide: true });
  await page.locator('[data-service="python"][data-state="failed"]').waitFor();
  await page.getByLabel('配置名称', { exact: true }).fill('兼容接口已保存'); await save(page);
  assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '重试智能服务', exact: true }).click();
  await page.locator('[data-service="python"][data-state="ready"]').waitFor({ timeout: 65000 });
  await testConnection(page);
  // Java retry also reloads the persisted profile metadata, with no legacy fallback.
  await page.getByLabel('模型标识', { exact: true }).fill('blocked-fixture'); await save(page);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  const beforeCrash = Date.now() + 10000; while (requests.at(-1)?.body.model !== 'blocked-fixture' && Date.now() < beforeCrash) await wait(50);
  assert.equal(requests.at(-1).body.model, 'blocked-fixture');
  owned = children(await app.evaluate(() => process.pid));
  execFileSync('taskkill.exe', ['/PID', String(owned.find(child => child.Name === 'java.exe').ProcessId), '/F'], { windowsHide: true });
  await page.locator('[data-service="java"][data-state="failed"]').waitFor();
  assert.equal(await page.getByLabel('配置名称', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '重试项目服务', exact: true }).click();
  await page.locator('[data-service="java"][data-state="ready"]').waitFor({ timeout: 65000 });
  await page.getByLabel('配置名称', { exact: true }).waitFor();
  await page.getByLabel('模型标识', { exact: true }).fill('chat-fixture'); await save(page);
  await testConnection(page);
  await page.locator('.view-container').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'model-settings.png') });
  await page.getByTestId('model-test-result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'model-test-success.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 720));
  await page.locator('.view-container').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'model-settings-narrow.png') });
  const callsBeforeRestart = requests.length;
  await close(); page = await launch();
  await page.getByTestId('active-model').filter({ hasText: '本机模型重命名' }).waitFor();
  assert.equal(requests.length, callsBeforeRestart);
  await select(page, '兼容接口已保存');
  await page.getByTestId('model-untested').waitFor();
  assert.equal(await page.getByLabel('模型 API Key', { exact: true }).inputValue(), '');
  await testConnection(page); assert.equal(requests.at(-1).headers.authorization, 'Bearer ' + key1);
  await select(page, '本机模型重命名');
  await page.getByRole('button', { name: '删除模型配置', exact: true }).click();
  await page.getByTestId('active-model').filter({ hasText: '尚未选择' }).waitFor();
  assert.equal((await page.evaluate(() => window.zhixi.modelSettings.list())).profiles.length, 2);
  // Keep the test running while navigating and writing project data, then shut down all services.
  await select(page, '兼容接口已保存');
  await page.getByLabel('模型标识', { exact: true }).fill('blocked-fixture'); await save(page);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  const until = Date.now() + 10000; while (requests.at(-1)?.body.model !== 'blocked-fixture' && Date.now() < until) await wait(50);
  assert.equal(requests.at(-1).body.model, 'blocked-fixture');
  await page.getByRole('button', { name: '项目管理', exact: true }).click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('测试期间创建的项目');
  await page.getByRole('dialog').getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('heading', { name: '测试期间创建的项目', exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '正在测试…', exact: true }).waitFor();
  const stoppedAt = Date.now(); await close(); const shutdownMs = Date.now() - stoppedAt;
  assert.ok(shutdownMs < 12500, `shutdown took ${shutdownMs} ms`);
  assert.deepEqual(errors, []);
  for (const key of [key1, key2, 'must-not-be-used']) assert.equal(logs.join('').includes(key), false);
  assert.equal(fs.existsSync(path.join(home, 'projects.json')), false);
  console.log(JSON.stringify({ passed: true, rendererErrors: errors, protocols: ['openai-compatible', 'anthropic-x-api-key', 'anthropic-bearer', 'ollama'], requests: requests.length, scenarios: ['zero-project-settings', 'save-activate-without-network', 'real-http-protocols', 'endpoint-validation', 'credential-target-change', 'encrypted-persistence', 'error-redaction', 'python-failure-save-and-retry', 'java-retry', 'restart-restoration', 'delete-active-clears-choice', 'project-write-during-model-test', 'pending-test-shutdown'], shutdownMs, viewports: ['1540x980', '1040x720'], browser: 'Browser plugin not available; existing Playwright Electron workflow', output }));
} catch (error) {
  console.error(error.stack);
  if (app) for (const page of await app.windows()) { console.error((await page.locator('body').innerText()).slice(-6000)); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  console.error('QA output: ' + output); process.exitCode = 1;
} finally { if (app) await close(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
