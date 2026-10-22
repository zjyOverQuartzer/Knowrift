const fs = require('node:fs');
const path = require('node:path');

function secureStore(home, safeStorage) {
  const file = path.join(home, 'credentials.json');
  let queue = Promise.resolve();
  const serial = operation => { const task = queue.then(operation); queue = task.catch(() => {}); return task; };
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const available = () => safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(safeStorage.isEncryptionAvailable());
  const guarded = operation => serial(async () => {
    try { return await operation(); }
    catch { throw Object.assign(new Error('系统安全凭据服务或凭据文件不可用，请检查后重试；原配置会保留'), { code: 'CREDENTIAL_UNAVAILABLE' }); }
  });
  return {
    names: () => guarded(() => Object.keys(read())),
    get: name => guarded(async () => {
      const data = read(); if (!data[name]) return '';
      if (!await available()) throw new Error();
      const value = Buffer.from(data[name], 'base64');
      if (!safeStorage.decryptStringAsync) return safeStorage.decryptString(value);
      const decrypted = await safeStorage.decryptStringAsync(value);
      return typeof decrypted === 'string' ? decrypted : decrypted.result;
    }),
    set: (name, value) => guarded(async () => {
      if (!await available()) throw new Error();
      const data = read();
      if (!value) delete data[name];
      else data[name] = (await (safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(value) : Promise.resolve(safeStorage.encryptString(value)))).toString('base64');
      fs.mkdirSync(home, { recursive: true });
      const temp = `${file}.tmp`;
      const fd = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    })
  };
}
module.exports = { secureStore };
