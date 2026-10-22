const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); });
class LocalServices extends EventEmitter {
  constructor(commands, home, { startTimeout = 60000, stopTimeout = 10000 } = {}) {
    super(); this.commands = commands; this.home = home; this.startTimeout = startTimeout; this.stopTimeout = stopTimeout;
    this.entries = new Map(); this.stopping = false;
  }
  status() {
    return Object.fromEntries(['java', 'python'].map(name => {
      const entry = this.entries.get(name);
      return [name, { state: entry?.state || 'stopped', message: entry?.message || '' }];
    }));
  }
  changed() { this.emit('status', this.status()); }
  async startAll() { this.stopping = false; return Promise.allSettled(['java', 'python'].map(name => this.start(name))); }
  start(name) {
    if (!['java', 'python'].includes(name) || this.stopping) return Promise.reject(new Error('无法启动本机服务'));
    const previous = this.entries.get(name);
    if (previous?.state === 'starting') return previous.startPromise;
    if (previous?.state === 'ready') return Promise.resolve();
    // Retry is serialized with cleanup so a timed-out process cannot retain the workspace lock.
    const entry = { state: 'starting', message: '', token: randomBytes(32).toString('hex'), instanceId: randomUUID(), child: null, port: null };
    this.entries.set(name, entry); this.changed();
    entry.startPromise = (async () => {
      if (previous?.child) await this.stopEntry(previous);
      const command = this.commands[name];
      if (!command) throw new Error('服务启动配置缺失');
      if (command.error) throw new Error(command.error);
      const child = spawn(command.executable, command.args || [], { cwd: command.cwd, env: command.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      entry.child = child;
      // Never relay raw service output to the renderer or logs: it may contain request data.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      await new Promise((resolve, reject) => {
        let pending = '', settled = false, checking = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => finish(new Error('本机服务未在等待时间内就绪，请检查运行环境后重试')), this.startTimeout);
        child.once('error', () => finish(new Error('无法启动本机服务，请检查运行环境')));
        child.once('exit', () => {
          // On Windows the venv launcher may exit before its Python worker.
          // Close the parent's pipe so that the worker's EOF watchdog also exits.
          child.stdin.end();
          if (this.entries.get(name) === entry && entry.state !== 'stopped') {
            entry.state = this.stopping ? 'stopped' : 'failed'; entry.message = this.stopping ? '' : '本机服务已退出，请重试'; this.changed();
          }
          finish(new Error('本机服务在就绪前退出'));
        });
        child.stdout.on('data', async bytes => {
          if (settled) return;
          pending += bytes.toString('utf8');
          if (pending.length > 1024 * 1024) { finish(new Error('服务启动输出异常')); return; }
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            let ready; try { ready = JSON.parse(line); } catch { continue; }
            if (ready.type !== 'ready' || settled || checking) continue;
            if (ready.service !== name || ready.protocolVersion !== 1 || ready.instanceId !== entry.instanceId || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) { finish(new Error('本机服务协议或实例不匹配')); return; }
            checking = true; entry.port = ready.port;
            try {
              const health = await this.requestEntry(entry, '/health/ready');
              if (health.ready !== true || health.service !== name || health.instanceId !== entry.instanceId || health.protocolVersion !== 1) throw new Error('本机服务探活校验失败');
              finish();
            } catch { finish(new Error('本机服务探活校验失败')); }
          }
        });
        child.stdin.write(JSON.stringify({ token: entry.token, instanceId: entry.instanceId, protocolVersion: 1, home: this.home }) + '\n');
      });
      if (child.exitCode !== null || this.stopping) throw new Error('本机服务已停止');
      entry.state = 'ready'; entry.message = ''; this.changed();
    })().catch(async error => {
      entry.state = 'failed'; entry.message = error.message; this.changed();
      await this.stopEntry(entry);
      throw error;
    });
    return entry.startPromise;
  }
  async requestEntry(entry, route, method = 'GET', body, timeoutMs = 10000) {
    const response = await fetch(`http://127.0.0.1:${entry.port}${route}`, { method, headers: { Authorization: `Bearer ${entry.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message || '本机服务请求失败'), { code: result.code || 'SERVICE_ERROR' });
    return result;
  }
  async request(route, method = 'GET', body, timeoutMs = 10000) {
    const entry = this.entries.get('java');
    if (entry?.state !== 'ready') throw Object.assign(new Error('项目服务尚未就绪，请检查服务状态后重试'), { code: 'SERVICE_UNAVAILABLE' });
    try { return await this.requestEntry(entry, route, method, body, timeoutMs); }
    catch (error) { if (!error.code) throw Object.assign(new Error('项目服务连接失败，请重试'), { code: 'SERVICE_UNAVAILABLE' }); throw error; }
  }
  async testModel(id, expectedRevision, apiKey) {
    const peer = this.entries.get('python');
    if (peer?.state !== 'ready') throw Object.assign(new Error('智能服务尚未就绪，请检查状态后重试'), { code: 'SERVICE_UNAVAILABLE' });
    return this.request(`/internal/model-profiles/${encodeURIComponent(id)}/test`, 'POST', { expectedRevision, apiKey,
      peer: { port: peer.port, token: peer.token, instanceId: peer.instanceId, protocolVersion: 1 } }, 70000);
  }
  async stopEntry(entry) {
    const child = entry.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (entry.port) this.requestEntry(entry, '/internal/shutdown', 'POST', {}).catch(() => {});
    child.stdin.end();
    await Promise.race([exited, delay(this.stopTimeout)]);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', resolve); killer.once('exit', resolve);
        });
      } else child.kill('SIGKILL');
      await Promise.race([exited, delay(2000)]);
    }
  }
  async stopAll() {
    this.stopping = true;
    await Promise.allSettled([...this.entries.values()].map(entry => this.stopEntry(entry)));
    for (const entry of this.entries.values()) { entry.state = 'stopped'; entry.message = ''; }
    this.changed();
  }
}
module.exports = { LocalServices };
