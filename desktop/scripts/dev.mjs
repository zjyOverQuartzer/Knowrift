import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';
const root = fileURLToPath(new URL('../../', import.meta.url));
const javaMode = process.argv.includes('--java');
const env = { ...process.env, ...(javaMode ? { ZHIXI_BACKEND_MODE: 'java', ZHIXI_HOME: process.env.ZHIXI_HOME || path.join(root, '.data/java-dev'), VITE_ZHIXI_BACKEND_MODE: 'java' } : {}) };
const frontend = path.join(root, 'frontend');
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const viteCli = path.join(path.dirname(frontendRequire.resolve('vite/package.json')), 'bin/vite.js');
const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1'], { cwd: frontend, stdio: 'inherit', env, windowsHide: true });
let ready = false;
for (let i = 0; i < 50; i++) {
  if (vite.exitCode !== null) throw new Error('前端开发服务器启动失败，请查看上方日志');
  try { if ((await fetch('http://127.0.0.1:5173')).ok) { ready = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!ready) { vite.kill(); throw new Error('前端开发服务器未在10秒内就绪'); }
const desktop = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...env, ZHIXI_DEV_URL: 'http://127.0.0.1:5173' } });
desktop.on('exit', code => { vite.kill(); process.exitCode = code || 0; });
process.on('SIGINT', () => { desktop.kill(); vite.kill(); });
process.on('SIGTERM', () => { desktop.kill(); vite.kill(); });
