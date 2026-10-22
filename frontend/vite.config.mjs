import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LearningService } from '@knowrift/backend';
const frontendRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig({ root: frontendRoot, base: './', plugins: [react(), {
  name: 'zhixi-local-preview',
  async configureServer(server) {
    if (process.env.ZHIXI_BACKEND_MODE === 'java') return;
    const service = new LearningService(process.env.ZHIXI_HOME || path.join(projectRoot, '.data/preview'));
    if (!service.repo.projects().length) { const p = service.createProject({ name: 'Java 后端学习' }); await service.startSession({ projectId: p.id, topic: 'Java 线程池', demo: true }); }
    server.middlewares.use('/__api', async (req, res) => {
      const origin = req.headers.origin;
      if (req.method !== 'POST' || !req.headers.host?.startsWith('127.0.0.1:') || (origin && origin !== `http://${req.headers.host}`) || !req.headers['content-type']?.includes('application/json')) { res.statusCode = 403; res.end('Forbidden'); return; }
      let body = '';
      try {
        for await (const chunk of req) { body += chunk; if (body.length > 2500000) throw new Error('请求过大'); }
        const { action, args = {} } = JSON.parse(body); let data;
        if (action === 'chooseDirectory') data = null;
        else if (action === 'openProjectFolder' || action === 'openExport') throw new Error('浏览器预览不支持系统文件操作，请使用桌面端');
        else if (action === 'export') {
          if (args.format === 'pdf') throw new Error('PDF 导出由桌面端本地打印引擎完成，请在桌面应用使用');
          const result = await service.exportContent(args); data = { download: result.buffer.toString('base64'), filename: `知隙学习记录.${args.format}` };
        } else data = await service.invoke(action, args);
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, data }));
      } catch (e) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: false, error: e.message, code: e.code })); }
    });
  }
}], server: { host: '127.0.0.1', port: 5173, strictPort: true } });
