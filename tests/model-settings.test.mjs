import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { ModelSettings } = createRequire(import.meta.url)('../desktop/runtime/model-settings.cjs');
const { secureStore } = createRequire(import.meta.url)('../desktop/runtime/credentials.cjs');
const error = () => Object.assign(new Error('simulated unavailable'), { code: 'SERVICE_UNAVAILABLE' });
function fixture() {
  const id = randomUUID(), oldRef = `model-profile/${id}/${randomUUID()}`;
  const values = new Map([[oldRef, 'old-test-key'], ['model', 'legacy-value'], ['cloud', 'cloud-value']]);
  let failWrites = false, failed = false;
  const secrets = { names: async () => [...values.keys()], get: async ref => values.get(ref) || '', set: async (ref, key) => { if (failWrites) throw error(); if (key) values.set(ref, key); else values.delete(ref); } };
  const records = new Map([[id, { id, name: '原配置', protocol: 'openai-compatible', baseUrl: 'https://example.com/v1', model: 'test', anthropicAuth: 'x-api-key', workspaceId: '', credentialRef: oldRef, revision: 1 }]]);
  const services = {
    mode: 'success', calls: [],
    async request(route, method = 'GET', body) {
      this.calls.push({ route, method });
      if (route === '/internal/model-profiles') {
        if (this.mode === 'uncertain' && failed) throw error();
        return structuredClone([...records.values()]);
      }
      if (method === 'PUT') {
        if (this.mode === 'reject' || this.mode === 'uncertain') { failed = true; throw error(); }
        assert.equal(values.get(body.credentialRef), 'replacement-test-key', 'credential is staged before DB commit');
        assert.equal(values.get(oldRef), 'old-test-key', 'old credential survives until DB commit');
        const { expectedRevision, ...fields } = body;
        const record = { ...fields, id, revision: expectedRevision + 1 };
        records.set(id, record);
        if (this.mode === 'committed-disconnected') throw error();
        const { credentialRef, ...result } = record;
        return { ...result, hasKey: !!credentialRef };
      }
      if (method === 'DELETE') { if (this.mode === 'reject') throw error(); records.delete(id); return { deleted: true }; }
      throw new Error('unexpected route');
    },
    async testModel(profileId, revision, apiKey) { return { profileId, revision, ok: apiKey === 'old-test-key' }; }
  };
  const settings = new ModelSettings(services, secrets);
  const input = { ...records.get(id), expectedRevision: 1, keyAction: 'replace', apiKey: 'replacement-test-key' };
  return { id, oldRef, values, records, services, settings, input, setFailWrites: value => { failWrites = value; } };
}
test('replacement commits the reference before retiring the old encrypted entry', async () => {
  const f = fixture(); const saved = await f.settings.save(f.input);
  assert.equal(saved.revision, 2); assert.equal(saved.credentialRef, undefined);
  assert.equal(f.values.has(f.oldRef), false);
  assert.equal(f.values.get(f.records.get(f.id).credentialRef), 'replacement-test-key');
  assert.equal(f.values.get('model'), 'legacy-value');
});
test('definite DB rejection removes staging and retains original config and key', async () => {
  const f = fixture(); f.services.mode = 'reject';
  await assert.rejects(f.settings.save(f.input));
  assert.equal(f.records.get(f.id).revision, 1); assert.equal(f.values.get(f.oldRef), 'old-test-key');
  assert.equal(f.values.size, 3);
});
test('lost response after commit is resolved using authoritative metadata', async () => {
  const f = fixture(); f.services.mode = 'committed-disconnected';
  const saved = await f.settings.save(f.input);
  assert.equal(saved.revision, 2); assert.equal(f.values.has(f.oldRef), false);
  assert.equal(f.values.get(f.records.get(f.id).credentialRef), 'replacement-test-key');
});
test('uncertain commit retains staged credentials until a successful restart reconciliation', async () => {
  const f = fixture(); f.services.mode = 'uncertain';
  await assert.rejects(f.settings.save(f.input)); assert.equal(f.values.size, 4);
  await assert.rejects(f.settings.reconcile()); assert.equal(f.values.size, 4);
  f.services.mode = 'success'; await f.settings.reconcile();
  assert.equal(f.values.size, 3); assert.equal(f.values.get(f.oldRef), 'old-test-key');
  assert.equal(f.values.get('cloud'), 'cloud-value');
});
test('encryption failure never commits a profile; failed deletion keeps its key', async () => {
  const f = fixture(); f.setFailWrites(true);
  await assert.rejects(f.settings.save(f.input)); assert.equal(f.services.calls.some(call => call.method === 'PUT'), false);
  f.setFailWrites(false); f.services.mode = 'reject';
  await assert.rejects(f.settings.remove(f.id, 1)); assert.equal(f.values.has(f.oldRef), true);
});
test('changed target cannot reuse credentials and test snapshots reject stale revisions', async () => {
  const f = fixture();
  await assert.rejects(f.settings.save({ ...f.input, keyAction: 'keep', baseUrl: 'https://other.example.com/v1' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.settings.test(f.id, 0), { code: 'PROFILE_CONFLICT' });
  assert.equal((await f.settings.test(f.id, 1)).ok, true);
});
test('credential file updates serialize asynchronous encryption without losing other entries', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knowrift-credential-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mockEncryption = { isEncryptionAvailable: () => true, encryptStringAsync: async value => { await new Promise(resolve => setTimeout(resolve, 8)); return Buffer.from('mock-encrypted:' + value); }, decryptString: value => value.toString().slice('mock-encrypted:'.length) };
  const store = secureStore(home, mockEncryption);
  await Promise.all([store.set('one', 'value-one'), store.set('two', 'value-two'), store.set('legacy', 'old-value')]);
  assert.equal(await store.get('one'), 'value-one'); assert.equal(await store.get('two'), 'value-two');
  await store.set('one', ''); assert.deepEqual((await store.names()).sort(), ['legacy', 'two']);
  const unavailable = secureStore(home, { isEncryptionAvailable: () => false });
  const before = fs.readFileSync(path.join(home, 'credentials.json'));
  await assert.rejects(unavailable.set('two', 'new-value'), { code: 'CREDENTIAL_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(path.join(home, 'credentials.json')), before);
});
