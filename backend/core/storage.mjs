import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const id = () => crypto.randomUUID();
export const stamp = () => new Date().toISOString();
export const revision = text => crypto.createHash('sha256').update(text).digest('hex');
export function fault(message, code = 'INVALID_INPUT') { return Object.assign(new Error(message), { code }); }
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${id()}.tmp`;
  try { fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function readJson(file, initial) {
  if (!fs.existsSync(file)) return structuredClone(initial);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw fault(`数据文件损坏，请保留原文件并从备份恢复：${file}`, 'CORRUPT_DATA'); }
}
export function saveJson(file, data) { atomicWrite(file, JSON.stringify(data, null, 2)); }
export const textOf = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const TEXT_FILE = /\.(md|txt|json|java|py|ts|tsx|js|mjs|cjs|jsx|yaml|yml|xml|sql|properties|log)$/i;
export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function checkedPath(root, relative, { internal = false } = {}) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) throw fault('路径必须是项目内相对路径', 'PATH_DENIED');
  const parts = relative.split(/[\\/]/);
  if (!internal && parts.some(p => p.startsWith('.') || p.includes(':'))) throw fault('不可访问内部文件或隐藏目录', 'PATH_DENIED');
  const canonicalRoot = fs.realpathSync(root);
  const candidate = path.resolve(canonicalRoot, relative);
  if (!inside(canonicalRoot, candidate)) throw fault('路径超出授权项目', 'PATH_DENIED');
  let current = candidate;
  while (!fs.existsSync(current) && current !== path.dirname(current)) current = path.dirname(current);
  if (!inside(canonicalRoot, fs.realpathSync(current))) throw fault('链接目标超出授权项目', 'PATH_DENIED');
  return candidate;
}

export class WorkspaceFiles {
  constructor(root, audit = () => {}) { this.root = root; this.audit = audit; }
  list(relative = '') {
    const base = checkedPath(this.root, relative);
    const result = [];
    const visit = dir => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const full = path.join(dir, item.name);
        const rel = path.relative(this.root, full).split(path.sep).join('/');
        if (item.isDirectory() && result.length < 300) visit(full);
        else if (item.isFile() && TEXT_FILE.test(item.name) && result.length < 300) result.push({ path: rel, size: fs.statSync(full).size });
      }
    };
    visit(base); this.audit('list_files', { path: relative, count: result.length }); return result;
  }
  read(relative) {
    const file = checkedPath(this.root, relative);
    if (!TEXT_FILE.test(file)) throw fault('仅支持文本文件', 'TYPE_DENIED');
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) throw fault('文本超过 2MB，请缩小文件');
    const content = textOf(file);
    this.audit('read_file', { path: relative });
    return { path: relative, content, revision: fs.existsSync(file) ? revision(content) : null };
  }
  write(relative, content, expectedRevision) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw fault('写入文本无效或超过 2MB');
    if (!/\.(md|txt)$/i.test(relative)) throw fault('Agent 写工具仅支持 Markdown 和纯文本', 'TYPE_DENIED');
    const file = checkedPath(this.root, relative);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const actual = old === null ? null : revision(old);
    if (expectedRevision !== actual) throw Object.assign(fault('文件已被其他编辑修改。请重新加载后比较，原文件未覆盖。', 'REVISION_CONFLICT'), { current: actual, proposed: content });
    if (old !== null) {
      const backup = path.join(this.root, '.history', revision(relative), `${Date.now()}-${id()}.md`);
      atomicWrite(backup, old);
    }
    atomicWrite(file, content);
    this.audit('write_file', { path: relative, revision: revision(content) });
    return { path: relative, content, revision: revision(content), absolutePath: file };
  }
  search(query) {
    if (typeof query !== 'string' || !query.trim()) return [];
    const hits = [];
    for (const file of this.list()) {
      if (file.size > 2 * 1024 * 1024) continue;
      const lines = textOf(checkedPath(this.root, file.path)).split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 100; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) hits.push({ path: file.path, line: i + 1, text: lines[i].slice(0, 250) });
    }
    this.audit('search_files', { query, count: hits.length }); return hits;
  }
  versions(relative) {
    checkedPath(this.root, relative);
    const dir = path.join(this.root, '.history', revision(relative));
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse().map(name => ({ id: name, content: textOf(path.join(dir, name)) })) : [];
  }
}
