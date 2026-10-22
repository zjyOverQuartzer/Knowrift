const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { secureStore: createSecureStore } = require('./runtime/credentials.cjs');
let window, service, quitting = false, tray;
let localServices, shutdownStarted = false, shutdownComplete = false;
const backendMode = process.env.ZHIXI_BACKEND_MODE === 'java' ? 'java' : 'legacy';
const approvedExports = new Set();
const devUrl = process.env.ZHIXI_DEV_URL;
const exportControllers = new Map();
app.setName('知隙');
if (process.env.ZHIXI_HOME) { const profile = path.join(process.env.ZHIXI_HOME, '.electron'); fs.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); }
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
app.setAppUserModelId('cn.zhixi.desktop');

async function secureStore(home) {
  return createSecureStore(home, safeStorage);
}
async function printPdf(html) {
  const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try { await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); await printWindow.webContents.executeJavaScript('document.fonts.ready'); return await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true }); }
  finally { printWindow.destroy(); }
}
async function exportDocument(args) {
  const format = ['md','html','pdf','docx'].includes(args.format) ? args.format : null; if (!format) throw new Error('导出格式无效');
  const picked = await dialog.showSaveDialog(window, { title: '导出学习记录', defaultPath: `知隙学习记录.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (picked.canceled || !picked.filePath) return { cancelled: true };
  const operationId = args.operationId || 'export'; const controller = new AbortController(); exportControllers.set(operationId, controller);
  try {
    const result = await service.exportContent(args);
    const buffer = format === 'pdf' ? await printPdf(result.buffer.toString('utf8')) : result.buffer;
    if (controller.signal.aborted) return { cancelled: true };
    fs.writeFileSync(picked.filePath, buffer); approvedExports.add(picked.filePath);
    return { filePath: picked.filePath, bytes: buffer.length, saved: true };
  } finally { exportControllers.delete(operationId); }
}
function makeWindow() {
  window = new BrowserWindow({ width: 1540, height: 980, minWidth: 1040, minHeight: 720, title: '知隙', icon: path.join(__dirname, 'assets/icon.png'), backgroundColor: '#ffffff', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide(); } });
  if (devUrl && new URL(devUrl).hostname === '127.0.0.1') window.loadURL(devUrl); else window.loadFile(path.join(__dirname, '../frontend/dist/index.html'));
  window.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(false));
}
function trustedSender(event) {
  const origin = event.senderFrame?.url || '';
  const trusted = origin === pathToFileURL(path.join(__dirname, '../frontend/dist/index.html')).href || (devUrl && new URL(origin).origin === new URL(devUrl).origin);
  if (event.sender !== window?.webContents || !trusted) throw new Error('拒绝未知页面请求');
}
const runtime = () => ({ mode: backendMode, capabilities: { projectManagement: true, modelSettings: true, learning: backendMode === 'legacy', importProject: backendMode === 'legacy', export: backendMode === 'legacy' }, services: localServices?.status() || {} });
function registerBridge(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { trustedSender(event); return { ok: true, data: await handler(...args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code || 'ERROR' }; }
  });
}
app.whenReady().then(async () => {
  if (!primaryInstance) return;
  const home = process.env.ZHIXI_HOME || path.join(app.getPath('userData'), 'workspace');
  registerBridge('zhixi:runtime', () => runtime());
  registerBridge('zhixi:retry-service', async name => {
    if (!localServices || !['java', 'python'].includes(name)) throw new Error('服务名称无效');
    await localServices.start(name); return runtime();
  });
  if (backendMode === 'java') {
    const { serviceCommands } = await import('../scripts/services.mjs');
    const { LocalServices } = require('./runtime/services.cjs');
    const commands = serviceCommands();
    if (fs.existsSync(path.join(home, 'projects.json'))) commands.java = { error: '该工作区包含旧版登记数据，请选择独立的新版工作区后重新启动' };
    localServices = new LocalServices(commands, home);
    const { ModelSettings } = require('./runtime/model-settings.cjs');
    const modelSettings = new ModelSettings(localServices, await secureStore(home));
    localServices.on('status', () => { if (localServices.status().java?.state === 'ready') modelSettings.reconcile().catch(() => {}); });
    registerBridge('zhixi:model-settings', (action, args = {}) => {
      if (action === 'list') return modelSettings.list();
      if (action === 'save') return modelSettings.save(args);
      if (action === 'remove') return modelSettings.remove(args.id, args.expectedRevision);
      if (action === 'activate') return modelSettings.activate(args.profileId);
      if (action === 'test') return modelSettings.test(args.id, args.expectedRevision);
      throw Object.assign(new Error('模型配置操作无效'), { code: 'INVALID_INPUT' });
    });
    localServices.on('status', () => { if (window && !window.isDestroyed()) window.webContents.send('zhixi:runtime-status', runtime()); });
    registerBridge('zhixi:projects', async (action, args = {}) => {
      if (action === 'list') return localServices.request('/api/v1/projects');
      if (action === 'create') return localServices.request('/api/v1/projects', 'POST', args);
      if (!['get', 'patch', 'openFolder'].includes(action) || typeof args.id !== 'string') throw new Error('项目操作无效');
      const route = `/api/v1/projects/${encodeURIComponent(args.id)}`;
      if (action === 'get') return localServices.request(route);
      if (action === 'patch') return localServices.request(route, 'PATCH', args.patch);
      const project = await localServices.request(route);
      if (project.availability !== 'available') throw new Error('项目目录不可用');
      const error = await shell.openPath(project.root); if (error) throw new Error(error);
      return { opened: true };
    });
    registerBridge('zhixi:choose-directory', async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    // Java mode never enters the legacy invoke path.
    registerBridge('zhixi:invoke', () => { throw Object.assign(new Error('当前版本尚未开放此功能'), { code: 'CAPABILITY_UNAVAILABLE' }); });
    makeWindow();
    localServices.startAll().catch(() => {});
  } else {
  const { LearningService } = await import('@knowrift/backend');
  service = new LearningService(home, { secrets: await secureStore(home) });
  if (!service.repo.projects().length) { const p = service.createProject({ name: 'Java 后端学习' }); await service.startSession({ projectId: p.id, topic: 'Java 线程池', demo: true }); }
  ipcMain.handle('zhixi:invoke', async (event, action, args = {}) => {
    try {
      const origin = event.senderFrame?.url || '';
      const trusted = origin === pathToFileURL(path.join(__dirname, '../frontend/dist/index.html')).href || (devUrl && new URL(origin).origin === new URL(devUrl).origin);
      if (event.sender !== window?.webContents || !trusted) throw new Error('拒绝未知页面请求');
      if (action === 'chooseDirectory') { const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }); return { ok: true, data: result.canceled ? null : result.filePaths[0] }; }
      if (action === 'export') return { ok: true, data: await exportDocument(args) };
      if (action === 'cancel') { for (const c of exportControllers.values()) c.abort(); }
      if (action === 'openProjectFolder') { const root = service.repo.project(args.projectId).root; await shell.openPath(root); return { ok: true, data: { opened: true } }; }
      if (action === 'openPersonalFolder') { const root = path.join(service.repo.home, 'personal'); const error = await shell.openPath(root); if (error) throw new Error(error); return { ok: true, data: { opened: true, path: root } }; }
      if (action === 'openExport') { if (!approvedExports.has(args.filePath)) throw new Error('该文件不是本次导出结果'); await shell.openPath(args.filePath); return { ok: true, data: { opened: true } }; }
      if (action === 'openReference') { const url = new URL(args.url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('链接无效'); await shell.openExternal(url.href); return { ok: true, data: { opened: true } }; }
      return { ok: true, data: await service.invoke(action, args) };
    } catch (e) { return { ok: false, error: e.message, code: e.code || 'ERROR' }; }
  });
  makeWindow();
  }
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 2; y < 30; y++) for (let x = 2; x < 30; x++) {
    const i = (y * 32 + x) * 4; const mark = (x >= 9 && x <= 12 && y >= 9 && y <= 23) || (y >= 9 && y <= 12 && x >= 9 && x <= 23) || (x >= 20 && x <= 23 && y >= 17 && y <= 23);
    pixels[i] = mark ? 255 : 246; pixels[i + 1] = mark ? 255 : 119; pixels[i + 2] = mark ? 255 : 52; pixels[i + 3] = 255;
  }
  const image = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
  tray = new Tray(image.resize({ width: 16, height: 16 })); tray.setToolTip('知隙 · 看见知识的缺口');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开知隙', click: () => window.show() }, { label: '完全退出', click: () => { quitting = true; app.quit(); } }])); tray.on('double-click', () => window.show());
  const notified = new Set();
  if (backendMode === 'legacy') setInterval(async () => {
    for (const project of service.repo.projects().filter(p => !p.archived)) {
      try {
        await service.syncTasks({ projectId: project.id });
        const due = service.repo.load(project.id).gaps.filter(g => g.dueAt && g.dueAt <= new Date().toISOString() && g.history.some(h => h.assessment && !h.demo));
        const daily = `${project.id}:${new Date().toISOString().slice(0,10)}`;
        if (due.length && !notified.has(daily) && Notification.isSupported()) { new Notification({ title: '知隙复习提醒', body: `${project.name}有 ${due.length} 个知识点待复习` }).show(); notified.add(daily); }
      } catch { /* 项目离线或目录不可用时保留数据，由界面呈现状态。 */ }
    }
  }, 60000).unref();
});
app.on('before-quit', event => {
  quitting = true;
  if (localServices && !shutdownComplete) {
    event.preventDefault();
    if (!shutdownStarted) { shutdownStarted = true; localServices.stopAll().finally(() => { shutdownComplete = true; app.quit(); }); }
  }
});
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('activate', () => { if (window) window.show(); else makeWindow(); });
