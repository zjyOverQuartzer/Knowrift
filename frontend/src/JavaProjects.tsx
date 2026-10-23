import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Folder, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { Busy, Empty, Modal } from './components';
import type { ManagedProject, RuntimeDescriptor, ServiceName } from './project-api';

const availabilityText = { available: '目录可用', missing: '目录已丢失，请恢复到原路径后重新加载', unreadable: '目录或数据库不可读，请检查权限', invalid: '项目数据无效，请保留原文件并检查备份' };
const stateText = { starting: '正在启动', ready: '已就绪', failed: '启动失败或已中断', stopped: '未启动' };
const futureFeatures = ['学习工作台', '文档与文件', '记忆', '提示词', '定时任务', '策略优化'];
const ModelSettings = lazy(() => import('./ModelSettings'));

export default function JavaProjects({ runtime }: { runtime: RuntimeDescriptor }) {
  const bridge = window.zhixi!;
  const [view, setView] = useState<'projects' | 'settings'>('projects');
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Partial<Record<ServiceName, boolean>>>({});
  const request = useRef<{ signature: string; id: string } | null>(null);
  const refreshSequence = useRef(0);
  const project = projects.find(item => item.id === selected);
  const ready = runtime.capabilities.projectManagement && runtime.services.java?.state === 'ready';
  const refresh = useCallback(async (target?: string) => {
    const sequence = ++refreshSequence.current;
    const items = await bridge.projects.list();
    if (sequence !== refreshSequence.current) return;
    setProjects(items);
    setSelected(current => items.some(item => item.id === (target ?? current)) ? (target ?? current) : (items.find(item => !item.archived)?.id || items[0]?.id || ''));
    setLoading(false);
  }, [bridge]);
  useEffect(() => {
    if (!ready) { setLoading(false); return; }
    setLoading(true);
    refresh().catch(error => { setNotice({ text: error.message, error: true }); setLoading(false); });
    const focus = () => { refresh().catch(error => setNotice({ text: error.message, error: true })); };
    window.addEventListener('focus', focus);
    return () => { refreshSequence.current++; window.removeEventListener('focus', focus); };
  }, [ready, refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 6500); return () => clearTimeout(timer); }, [notice]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    try { await operation(); } catch (error) { setNotice({ text: error instanceof Error ? error.message : '操作失败', error: true }); }
    finally { setBusy(false); }
  };
  const create = () => perform(async () => {
    const signature = JSON.stringify([name.trim(), directory]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    const result = await bridge.projects.create({ name, ...(directory ? { directory } : {}), clientRequestId: request.current.id });
    await refresh(result.id); setCreating(false); setName(''); setDirectory(''); request.current = null; setView('projects');
    setNotice({ text: '项目已创建并保存', error: false });
  });
  const patch = (change: { name?: string; archived?: boolean }) => perform(async () => {
    if (!project) return;
    const result = await bridge.projects.patch(project.id, change);
    await refresh(result.id); setRename(null); setNotice({ text: '项目已更新', error: false });
  });
  const projectButton = (item: ManagedProject) => <button key={item.id} className={selected === item.id ? 'active' : ''} onClick={() => { setView('projects'); void perform(() => refresh(item.id)); }} disabled={busy || !ready}><Folder size={17}/><span>{item.name}</span>{item.availability !== 'available' ? <AlertCircle size={14} aria-label="目录不可用"/> : null}</button>;
  return <div className="app-shell java-projects"><aside className="sidebar">
    <div className="brand"><strong>知隙</strong><span>看见知识的缺口</span></div>
    <button className="primary new-session" disabled={!ready || busy} onClick={() => setCreating(true)}><Plus size={19}/>新建项目</button>
    <nav aria-label="主要功能"><button className={view === 'projects' ? 'active' : ''} onClick={() => setView('projects')}><Folder size={19}/>项目管理</button>{futureFeatures.map(label => <button key={label} disabled={!runtime.capabilities.learning} title="此版本暂未开放">{label}</button>)}<button className={view === 'settings' ? 'active' : ''} disabled={!runtime.capabilities.modelSettings} onClick={() => { setSettingsOpened(true); setView('settings'); }}><Settings2 size={19}/>设置</button></nav>
    <div className="sidebar-section-title"><span>我的项目</span></div>
    <div className="project-list">{projects.filter(item => !item.archived).map(projectButton)}{projects.some(item => item.archived) ? <details open={project?.archived || undefined}><summary>已归档项目</summary>{projects.filter(item => item.archived).map(projectButton)}</details> : null}</div>
    <footer className="workspace-footer"><Folder size={15}/><div><strong>本地工作区</strong><small title={project?.root}>{project?.root || '尚未创建项目'}</small></div></footer>
  </aside><div className="main-shell"><header className="app-header"><div className="breadcrumb"><Folder size={18}/><span>{view === 'settings' ? '全局配置' : project?.name || '知隙'}</span><span className="slash">/</span><strong>{view === 'settings' ? '模型设置' : '项目管理'}</strong></div>{view === 'projects' ? <button disabled={!ready || busy} onClick={() => void perform(() => refresh())}><RefreshCw size={16}/>重新加载</button> : null}</header>
    <main className="view-container project-overview"><section className="service-status" aria-label="本机服务状态">{(['java', 'python'] as const).map(service => {
      const status = runtime.services[service] || { state: 'stopped' as const, message: '' };
      return <div key={service}><strong>{service === 'java' ? '项目服务' : '智能服务'}</strong><span data-service={service} data-state={status.state}>{stateText[status.state]}</span>{status.message ? <p role="note">{status.message}</p> : null}{status.state === 'failed' || status.state === 'stopped' ? <button disabled={retrying[service]} onClick={() => {
        setRetrying(current => ({ ...current, [service]: true }));
        bridge.retryService(service).catch(error => setNotice({ text: error.message, error: true })).finally(() => setRetrying(current => ({ ...current, [service]: false })));
      }}>重试{service === 'java' ? '项目服务' : '智能服务'}</button> : null}</div>;
    })}</section>
    <div hidden={view !== 'projects'}>{!ready ? <Empty><h2>项目服务尚未就绪</h2><p>服务就绪后即可管理本地项目。已有项目文件会保留。</p></Empty> : loading ? <Empty><Busy label="正在读取项目"/></Empty> : project ? <section className="surface project-card">
      <span className="tag">{project.archived ? '已归档' : '当前项目'}</span><h1>{project.name}</h1><p className="project-path">{project.root}</p>
      <p role="note" className={project.availability === 'available' ? 'muted' : 'project-warning'}>{availabilityText[project.availability]}</p>
      <div className="button-row"><button disabled={busy || project.availability !== 'available'} onClick={() => setRename(project.name)}>重命名项目</button><button disabled={busy} onClick={() => void patch({ archived: !project.archived })}>{project.archived ? '取消归档' : '归档当前项目'}</button><button disabled={busy || project.availability !== 'available'} onClick={() => void perform(async () => { await bridge.projects.openFolder(project.id); })}>打开项目目录</button></div>
      <p className="muted project-next">项目已保存在本机。学习与文档功能将在后续版本开放。</p>
    </section> : <Empty><Folder size={36}/><h2>创建第一个学习项目</h2><p>选择名称和本地目录，重新启动后仍可继续管理。</p><button className="primary" onClick={() => setCreating(true)}>创建项目</button></Empty>}</div>
    {settingsOpened ? <div hidden={view !== 'settings'}><Suspense fallback={<Busy label="正在读取设置"/>}><ModelSettings runtime={runtime}/></Suspense></div> : null}
    </main></div>
    {creating ? <Modal title="新建学习项目" close={() => { if (!busy) setCreating(false); }}><form className="modal-body form-stack" onSubmit={event => { event.preventDefault(); void create(); }}><label>项目名称<input required maxLength={80} aria-label="项目名称" value={name} onChange={event => setName(event.target.value)}/></label><label>本地目录<input readOnly aria-label="项目目录" value={directory} placeholder="留空则使用默认工作区"/></label><button type="button" disabled={busy} onClick={() => void perform(async () => { const picked = await bridge.chooseDirectory(); if (picked) setDirectory(picked); })}><Folder size={16}/>选择本地目录</button><div className="button-row"><button className="primary" disabled={busy || !ready || !name.trim()}>创建项目</button><button disabled={!runtime.capabilities.importProject} title="此版本暂未开放" type="button">导入已有项目</button></div></form></Modal> : null}
    {rename !== null ? <Modal title="重命名项目" close={() => { if (!busy) setRename(null); }}><form className="modal-body form-stack" onSubmit={event => { event.preventDefault(); void patch({ name: rename }); }}><label>项目名称<input required maxLength={80} aria-label="项目新名称" value={rename} onChange={event => setRename(event.target.value)}/></label><button className="primary" disabled={busy || !rename.trim()}>保存名称</button></form></Modal> : null}
    {notice ? <div className={`toast ${notice.error ? 'error' : ''}`} role="status">{notice.error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}<span>{notice.text}</span></div> : null}
  </div>;
}
