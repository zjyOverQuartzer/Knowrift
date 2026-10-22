import fs from 'node:fs';
import path from 'node:path';
import { id, stamp, readJson, saveJson, atomicWrite, WorkspaceFiles, fault } from './storage.mjs';

export const EMPTY_PROJECT = { sessions: [], gaps: [], feedback: [], strategies: [], tasks: [], audit: [], memoryCandidates: [], memoryPaused: false, activeStrategyId: null };
export class Repository {
  constructor(home) {
    this.home = path.resolve(home); fs.mkdirSync(this.home, { recursive: true });
    fs.mkdirSync(path.join(this.home, 'personal'), { recursive: true });
    this.registryFile = path.join(this.home, 'projects.json');
  }
  projects() { return readJson(this.registryFile, []); }
  project(projectId) {
    const p = this.projects().find(p => p.id === projectId);
    if (!p) throw fault('项目不存在', 'NOT_FOUND');
    if (!fs.existsSync(p.root)) throw fault('项目目录不可用，请恢复目录或重新选择项目', 'PROJECT_UNAVAILABLE');
    return p;
  }
  create(name, directory) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw fault('项目名称需为1至80个字符');
    const projectId = id();
    const root = directory ? path.resolve(directory) : path.join(this.home, 'workspaces', `${name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 30)}-${projectId.slice(0, 8)}`);
    fs.mkdirSync(root, { recursive: true });
    if (this.projects().some(p => fs.existsSync(p.root) && fs.realpathSync(p.root) === fs.realpathSync(root))) throw fault('该目录已经属于一个项目');
    if (fs.existsSync(path.join(root, '.zhixi', 'state.json'))) throw fault('该目录已有知隙数据，请通过导入现有项目恢复');
    const project = { id: projectId, name: name.trim(), root: fs.realpathSync(root), archived: false, createdAt: stamp() };
    for (const folder of ['summaries', 'notes', 'references']) fs.mkdirSync(path.join(root, folder), { recursive: true });
    saveJson(path.join(root, '.zhixi', 'state.json'), EMPTY_PROJECT);
    for (const file of ['MEMORY.md', 'PROJECT_PROMPT.md']) if (!fs.existsSync(path.join(root, file))) atomicWrite(path.join(root, file), '');
    saveJson(this.registryFile, [...this.projects(), project]); return project;
  }
  import(root) {
    root = fs.realpathSync(root);
    if (!fs.existsSync(path.join(root, '.zhixi', 'state.json'))) throw fault('目录中没有知隙项目');
    const known = this.projects().find(p => p.root === root); if (known) return known;
    const project = { id: id(), name: path.basename(root), root, archived: false, createdAt: stamp() };
    saveJson(this.registryFile, [...this.projects(), project]); return project;
  }
  patchProject(projectId, patch) {
    const all = this.projects(); const p = all.find(p => p.id === projectId); if (!p) throw fault('项目不存在');
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 80)) throw fault('项目名称无效');
    if (patch.name !== undefined) p.name = patch.name.trim();
    if (typeof patch.archived === 'boolean') p.archived = patch.archived;
    saveJson(this.registryFile, all); return p;
  }
  load(projectId) { return { ...structuredClone(EMPTY_PROJECT), ...readJson(path.join(this.project(projectId).root, '.zhixi', 'state.json'), EMPTY_PROJECT) }; }
  mutate(projectId, callback) {
    const state = this.load(projectId); const result = callback(state);
    saveJson(path.join(this.project(projectId).root, '.zhixi', 'state.json'), state); return result;
  }
  audit(projectId, tool, detail, status = 'success') {
    this.mutate(projectId, s => { s.audit.unshift({ id: id(), time: stamp(), tool, detail, status }); s.audit = s.audit.slice(0, 500); });
  }
  files(projectId) { return new WorkspaceFiles(this.project(projectId).root, (tool, detail) => this.audit(projectId, tool, detail)); }
  personalFiles() { return new WorkspaceFiles(path.join(this.home, 'personal')); }
  settings() { return { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash', demo: true, cloudUrl: '', email: '', timezone: 'Asia/Shanghai', emailEnabled: true, reviewHour: 9, ...readJson(path.join(this.home, 'settings.json'), {}) }; }
  saveSettings(settings) { saveJson(path.join(this.home, 'settings.json'), settings); }
}
