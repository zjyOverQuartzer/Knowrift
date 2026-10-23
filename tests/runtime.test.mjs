import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { LocalServices } = createRequire(import.meta.url)('../desktop/runtime/services.cjs');
const fixture = fileURLToPath(new URL('./fixtures/local-service.cjs', import.meta.url));
const command = (mode = 'healthy', service = 'java') => ({ executable: process.execPath, args: [fixture, mode, service] });
test('dynamic ports, private token, duplicate startup and graceful cleanup', async () => {
  const services = new LocalServices({ java: command(), python: command('healthy', 'python') }, 'unused', { stopTimeout: 1000 });
  try {
    await services.startAll(); assert.equal(services.status().java.state, 'ready'); assert.equal(services.status().python.state, 'ready');
    const entry = services.entries.get('java');
    const pid = entry.child.pid;
    await Promise.all([services.start('java'), services.start('java')]); assert.equal(services.entries.get('java').child.pid, pid);
    assert.equal((await fetch(`http://127.0.0.1:${entry.port}/health/ready`)).status, 401);
    assert.equal((await services.request('/health/ready')).ready, true);
    assert.ok(!JSON.stringify(services.status()).includes(entry.token));
  } finally { await services.stopAll(); }
  assert.equal(services.status().java.state, 'stopped');
});
test('Python failure does not block Java; failed service can be retried', async () => {
  const services = new LocalServices({ java: command(), python: command('crash', 'python') }, 'unused', { stopTimeout: 1000 });
  try {
    await services.startAll(); assert.equal(services.status().java.state, 'ready'); assert.equal(services.status().python.state, 'failed');
    services.commands.python = command('healthy', 'python'); await services.start('python'); assert.equal(services.status().python.state, 'ready');
  } finally { await services.stopAll(); }
});
for (const mode of ['badprotocol', 'badhealth', 'hang']) test(`rejects ${mode} and cleans up its process`, async () => {
  const services = new LocalServices({ java: command(mode) }, 'unused', { startTimeout: mode === 'hang' ? 500 : 10000, stopTimeout: 1000 });
  try {
    await assert.rejects(services.start('java'));
    assert.equal(services.status().java.state, 'failed');
    assert.notEqual(services.entries.get('java').child.exitCode, null);
  } finally { await services.stopAll(); }
});
test('unexpected Java exit disables requests and supports manual restart', async () => {
  const services = new LocalServices({ java: command() }, 'unused', { stopTimeout: 1000 });
  try {
    await services.start('java'); const child = services.entries.get('java').child;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    assert.equal(services.status().java.state, 'failed'); await assert.rejects(services.request('/health/ready'));
    await services.start('java'); assert.equal(services.status().java.state, 'ready');
  } finally { await services.stopAll(); }
});
