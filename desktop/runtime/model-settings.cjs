const { randomUUID } = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(message), { code });
const isId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const publicProfile = ({ credentialRef, ...profile }) => ({ ...profile, hasKey: !!credentialRef });
const normalized = value => { try { return new URL(value.trim().replace(/\/+$/, '')).href.replace(/\/+$/, ''); } catch { return value; } };

class ModelSettings {
  constructor(services, secrets) { this.services = services; this.secrets = secrets; this.queue = Promise.resolve(); this.testing = false; }
  serial(operation) { const task = this.queue.then(operation); this.queue = task.catch(() => {}); return task; }
  async internal() {
    const items = await this.services.request('/internal/model-profiles');
    if (!Array.isArray(items) || items.some(item => !isId(item.id) || item.credentialRef != null && !item.credentialRef.startsWith(`model-profile/${item.id}/`))) throw fail('SERVICE_UNAVAILABLE', '模型配置读取失败，请重新加载');
    return items;
  }
  reconcile() { return this.serial(async () => {
    const profiles = await this.internal();
    const used = new Set(profiles.map(item => item.credentialRef).filter(Boolean));
    for (const name of await this.secrets.names()) {
      if (/^model-profile\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(name) && !used.has(name)) await this.secrets.set(name, '');
    }
  }); }
  list() { return this.services.request('/api/v1/model-profiles'); }
  save(input) { return this.serial(async () => {
    if (!input || !isId(input.id) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0
      || !['keep', 'replace', 'clear'].includes(input.keyAction)) throw fail('INVALID_INPUT', '配置保存参数无效');
    const profiles = await this.internal(), old = profiles.find(item => item.id === input.id);
    if ((old?.revision || 0) !== input.expectedRevision) throw fail('PROFILE_CONFLICT', '配置已变化，请重新加载后编辑');
    const fields = ['name', 'protocol', 'baseUrl', 'model', 'anthropicAuth', 'workspaceId'];
    const body = { expectedRevision: input.expectedRevision };
    for (const field of fields) {
      if (typeof input[field] !== 'string') throw fail('INVALID_INPUT', '模型配置字段无效');
      body[field] = input[field];
    }
    if (input.keyAction === 'keep' && old?.credentialRef && (old.protocol !== input.protocol || normalized(old.baseUrl) !== normalized(input.baseUrl))) throw fail('INVALID_INPUT', '协议或基础地址已变化，请重新输入或显式清除密钥');
    let staged = null;
    body.credentialRef = input.keyAction === 'keep' ? old?.credentialRef || null : null;
    if (input.keyAction === 'replace') {
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(input.apiKey)) throw fail('INVALID_INPUT', '请输入有效密钥，密钥中不能包含空白或控制字符');
      staged = `model-profile/${input.id}/${randomUUID()}`;
      await this.secrets.set(staged, input.apiKey);
      body.credentialRef = staged;
    }
    let saved;
    try { saved = await this.services.request(`/api/v1/model-profiles/${input.id}`, 'PUT', body); }
    catch (error) {
      // A lost response may follow a successful commit. Only authoritative reads permit cleanup.
      let after;
      try { after = await this.internal(); } catch { throw error; }
      const current = after.find(item => item.id === input.id);
      const matches = current && current.revision === input.expectedRevision + 1 && current.credentialRef === body.credentialRef
        && current.name === input.name.trim() && current.model === input.model.trim() && current.protocol === input.protocol
        && normalized(current.baseUrl) === normalized(input.baseUrl)
        && (input.protocol !== 'anthropic' || current.anthropicAuth === input.anthropicAuth && current.workspaceId === input.workspaceId.trim());
      if (matches) saved = publicProfile(current);
      else {
        if (staged && !after.some(item => item.credentialRef === staged)) await this.secrets.set(staged, '').catch(() => {});
        throw error;
      }
    }
    if (old?.credentialRef && old.credentialRef !== body.credentialRef) await this.secrets.set(old.credentialRef, '').catch(() => {});
    return saved;
  }); }
  remove(id, expectedRevision) { return this.serial(async () => {
    if (!isId(id) || !Number.isInteger(expectedRevision)) throw fail('INVALID_INPUT', '配置删除参数无效');
    const old = (await this.internal()).find(item => item.id === id);
    try { await this.services.request(`/api/v1/model-profiles/${id}`, 'DELETE', { expectedRevision }); }
    catch (error) { const after = await this.internal(); if (after.some(item => item.id === id)) throw error; }
    if (old?.credentialRef) await this.secrets.set(old.credentialRef, '').catch(() => {});
    return { deleted: true };
  }); }
  activate(profileId) {
    if (profileId !== null && !isId(profileId)) throw fail('INVALID_INPUT', '当前配置标识无效');
    return this.serial(() => this.services.request('/api/v1/model-settings/active', 'PUT', { profileId }));
  }
  async test(id, expectedRevision) {
    if (!isId(id) || !Number.isInteger(expectedRevision)) throw fail('INVALID_INPUT', '连接测试参数无效');
    if (this.testing) throw fail('TEST_BUSY', '已有连接测试正在进行，请稍后再试');
    this.testing = true;
    try {
      const snapshot = await this.serial(async () => {
        const profile = (await this.internal()).find(item => item.id === id);
        if (!profile) throw fail('PROFILE_NOT_FOUND', '模型配置不存在，请重新加载');
        if (profile.revision !== expectedRevision) throw fail('PROFILE_CONFLICT', '配置已变化，请重新加载后测试');
        const key = profile.credentialRef ? await this.secrets.get(profile.credentialRef) : '';
        if (profile.credentialRef && !key) throw fail('CREDENTIAL_UNAVAILABLE', '无法读取该配置的密钥，请重新输入并保存');
        return { key, revision: profile.revision };
      });
      return await this.services.testModel(id, snapshot.revision, snapshot.key);
    } finally { this.testing = false; }
  }
}
module.exports = { ModelSettings };
