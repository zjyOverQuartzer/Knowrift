import { _electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { serviceCommands, root } from '../scripts/services.mjs';
const { LocalServices } = createRequire(import.meta.url)('../desktop/runtime/services.cjs');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'knowrift-java-qa-'));
const home = path.join(output, '新版工作区');
const selectedDirectory = path.join(output, '已有资料 中文目录'); fs.mkdirSync(selectedDirectory);
fs.writeFileSync(path.join(selectedDirectory, 'MEMORY.md'), '保留用户原文\r\n', 'utf8');
const env = { ...process.env, ZHIXI_HOME: home, ZHIXI_BACKEND_MODE: 'java', DASHSCOPE_API_KEY: '', OPENAI_API_KEY: '' }; delete env.ELECTRON_RUN_AS_NODE;
let app;
let vite;
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function childServices(pid) {
  const script = `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('java.exe','python.exe') } | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress`;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const value = result.trim() ? JSON.parse(result) : [];
  const candidates = Array.isArray(value) ? value : [value], parents = new Set([pid]), owned = [];
  let added = true;
  while (added) { added = false; for (const child of candidates) if (!parents.has(child.ProcessId) && parents.has(child.ParentProcessId)) { parents.add(child.ProcessId); owned.push(child); added = true; } }
  return owned;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function ownedServices() { return childServices(await app.evaluate(() => process.pid)); }
async function gone(children) {
  const until = Date.now() + 12000;
  while (Date.now() < until && children.some(child => alive(child.ProcessId))) await wait(100);
  assert.deepEqual(children.filter(child => alive(child.ProcessId)), [], 'owned services must exit');
}
async function launch(customEnv = env) {
  app = await _electron.launch({ args: ['.'], cwd: root, env: customEnv, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  assert.equal(await page.title(), '知隙 · 看见知识的缺口');
  assert.ok(customEnv.ZHIXI_DEV_URL ? page.url().startsWith(customEnv.ZHIXI_DEV_URL) : page.url().startsWith('file:'));
  return page;
}
async function ready(page) {
  await page.locator('[data-service="java"][data-state="ready"]').waitFor({ timeout: 65000 });
  await page.locator('[data-service="python"][data-state="ready"]').waitFor({ timeout: 65000 });
}
async function createProject(page, name, directory) {
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  if (directory) {
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
    await page.getByRole('button', { name: '选择本地目录', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('input[aria-label="项目目录"]')?.value === expected, directory);
    assert.equal(await page.getByLabel('项目目录', { exact: true }).inputValue(), directory);
  }
  await page.getByRole('dialog').getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
}
try {
  // Real Java HTTP protocol, authentication, and idempotency, outside the renderer.
  const services = new LocalServices(serviceCommands(), path.join(output, '协议验证'));
  try {
    await services.start('java'); const entry = services.entries.get('java');
    assert.equal((await fetch(`http://127.0.0.1:${entry.port}/health/ready`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${entry.port}/api/v1/projects`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const input = { name: '幂等项目', clientRequestId: crypto.randomUUID() };
    const one = await services.request('/api/v1/projects', 'POST', input);
    assert.equal((await services.request('/api/v1/projects', 'POST', input)).id, one.id);
    await assert.rejects(services.request('/api/v1/projects', 'POST', { ...input, name: '不同参数' }), { code: 'REQUEST_CONFLICT' });
    assert.equal((await services.request('/api/v1/projects')).length, 1);
    await assert.rejects(services.request(`/api/v1/projects/${one.id}`, 'PATCH', { archived: 'true' }), { code: 'INVALID_INPUT' });
  } finally { await services.stopAll(); }
  let page = await launch(); await ready(page);
  await page.getByRole('heading', { name: '创建第一个学习项目', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '学习工作台', exact: true }).isDisabled(), true);
  assert.equal(fs.existsSync(path.join(home, 'projects.json')), false);
  await createProject(page, '默认目录项目');
  await createProject(page, '已有资料项目', selectedDirectory);
  assert.equal(fs.readFileSync(path.join(selectedDirectory, 'MEMORY.md'), 'utf8'), '保留用户原文\r\n');
  assert.equal(fs.existsSync(path.join(selectedDirectory, '.zhixi/state.json')), false);
  assert.equal(fs.existsSync(path.join(selectedDirectory, '.zhixi/project.db')), true);
  await page.getByRole('button', { name: '重命名项目', exact: true }).click();
  await page.getByLabel('项目新名称').fill('中文重命名项目');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('heading', { name: '中文重命名项目', exact: true }).waitFor();
  await page.getByRole('button', { name: '归档当前项目', exact: true }).click();
  await page.getByRole('button', { name: '取消归档', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消归档', exact: true }).click();
  await page.getByRole('button', { name: '归档当前项目', exact: true }).waitFor();
  await app.evaluate(({ shell }) => { shell.openPath = async () => ''; });
  await page.getByRole('button', { name: '打开项目目录', exact: true }).click();
  await page.locator('.project-list').getByRole('button', { name: '默认目录项目', exact: true }).click();
  await page.getByRole('heading', { name: '默认目录项目', exact: true }).waitFor();
  await page.locator('.project-list').getByRole('button', { name: '中文重命名项目', exact: true }).click();
  await page.getByRole('heading', { name: '中文重命名项目', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'projects.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 720));
  await page.screenshot({ path: path.join(output, 'projects-narrow.png') });
  const moved = selectedDirectory + '-moved'; fs.renameSync(selectedDirectory, moved);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByText('目录已丢失，请恢复到原路径后重新加载', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重命名项目', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'unavailable.png') });
  fs.renameSync(moved, selectedDirectory);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByText('目录可用', { exact: true }).waitFor();
  // Kill only the service process owned by this Electron instance, then retry through real controls.
  let children = await ownedServices(); assert.ok(children.some(child => child.Name === 'java.exe')); assert.ok(children.some(child => child.Name === 'python.exe'));
  const python = children.find(child => child.Name === 'python.exe');
  execFileSync('taskkill.exe', ['/PID', String(python.ProcessId), '/F'], { windowsHide: true });
  await gone(children.filter(child => child.Name === 'python.exe'));
  await page.getByRole('button', { name: '重试智能服务', exact: true }).click();
  await page.locator('[data-service="python"][data-state="ready"]').waitFor({ timeout: 65000 });
  const java = children.find(child => child.Name === 'java.exe');
  execFileSync('taskkill.exe', ['/PID', String(java.ProcessId), '/F'], { windowsHide: true });
  await page.getByRole('heading', { name: '项目服务尚未就绪', exact: true }).waitFor();
  await page.getByRole('button', { name: '重试项目服务', exact: true }).click(); await ready(page);
  await page.getByRole('heading', { name: '中文重命名项目', exact: true }).waitFor();
  children = await ownedServices();
  await app.close(); app = null; await gone(children);
  page = await launch(); await ready(page);
  await page.locator('.project-list').getByRole('button', { name: '中文重命名项目', exact: true }).click();
  await page.getByRole('heading', { name: '中文重命名项目', exact: true }).waitFor();
  children = await ownedServices(); const parent = app.process(); const mainPid = await app.evaluate(() => process.pid);
  const disconnected = new Promise(resolve => parent.once('exit', resolve));
  execFileSync('taskkill.exe', ['/PID', String(mainPid), '/F'], { windowsHide: true });
  await Promise.race([disconnected, wait(5000)]); app = null; await gone(children);
  page = await launch(); await ready(page);
  await page.locator('.project-list').getByRole('button', { name: '中文重命名项目', exact: true }).waitFor();
  await app.close(); app = null;
  // Exercise the actual development origin and verify Vite never creates legacy data.
  process.env.ZHIXI_BACKEND_MODE = 'java'; process.env.VITE_ZHIXI_BACKEND_MODE = 'java';
  const previewHome = path.join(output, 'vite-隔离验证'); process.env.ZHIXI_HOME = previewHome;
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: path.join(root, 'frontend/vite.config.mjs'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen(); const devUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await fetch(devUrl);
  await fetch(devUrl + '/__api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'snapshot' }) });
  assert.equal(fs.existsSync(previewHome), false, 'Java Vite must not initialize a legacy repository');
  page = await launch({ ...env, ZHIXI_DEV_URL: devUrl }); await ready(page);
  await page.locator('.project-list').getByRole('button', { name: '中文重命名项目', exact: true }).waitFor();
  await app.close(); app = null; await vite.close(); vite = null;
  const legacyHome = path.join(output, '旧工作区'); fs.mkdirSync(legacyHome); fs.writeFileSync(path.join(legacyHome, 'projects.json'), '[]');
  page = await launch({ ...env, ZHIXI_HOME: legacyHome });
  await page.getByText('该工作区包含旧版登记数据，请选择独立的新版工作区后重新启动', { exact: true }).waitFor();
  assert.equal(fs.existsSync(path.join(legacyHome, 'app.db')), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scenarios: ['real-java-http', 'authentication', 'idempotency', 'create-default-and-selected', 'preserve-files', 'rename', 'archive-restore', 'switch-project', 'missing-directory', 'service-crash-retry', 'restart', 'parent-crash-cleanup', 'vite-isolation', 'development-origin-ipc', 'legacy-root-guard'], rendererErrors: errors, viewports: ['1540x980', '1040x720'], output, home }));
} catch (error) {
  console.error(error.stack);
  if (app) { for (const page of await app.windows()) { console.error((await page.locator('body').innerText()).slice(0, 5000)); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); } }
  console.error('QA output: ' + output); process.exitCode = 1;
} finally { if (app) await app.close(); if (vite) await vite.close(); }
