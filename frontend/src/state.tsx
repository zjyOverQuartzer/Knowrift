import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Snapshot, View } from './types';

export async function invoke(action: string, args: Record<string, any> = {}) {
  const result = window.zhixi ? await window.zhixi.invoke(action, args) : await fetch('/__api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) }).then(r => r.json());
  if (!result.ok) throw Object.assign(new Error(result.error || '操作失败'), { code: result.code });
  return result.data;
}
type Context = { snap: Snapshot | null; view: View; setView: (v: View) => void; projectId: string; sessionId: string; setSessionId: (v: string) => void; busy: string; notice: { text: string; error: boolean } | null; notify: (text: string, error?: boolean) => void; refresh: (projectId?: string) => Promise<void>; act: (action: string, args?: Record<string, any>, success?: string) => Promise<any>; selectProject: (id: string) => Promise<void>; setExport: (v: Record<string, any> | null) => void; exportTarget: Record<string, any> | null };
const AppContext = createContext<Context>(null as unknown as Context);
export const useApp = () => useContext(AppContext);
export function AppProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null); const [view, setView] = useState<View>('workbench');
  const [projectId, setProjectId] = useState(''); const [sessionId, setSessionId] = useState(''); const [busy, setBusy] = useState('');
  const selectedProject = useRef(''); const snapshotRequest = useRef(0); const activeOperations = useRef(0);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null); const [exportTarget, setExport] = useState<Record<string, any> | null>(null);
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  const refresh = useCallback(async (requested?: string) => { const target = requested ?? selectedProject.current; const request = ++snapshotRequest.current; const s = await invoke('snapshot', target ? { projectId: target } : {}); if (request !== snapshotRequest.current) return; selectedProject.current = s.project?.id || ''; setSnap(s); setProjectId(selectedProject.current); }, []);
  useEffect(() => { refresh().catch(e => notify(e.message, true)); }, [refresh, notify]);
  useEffect(() => { const focus = () => { if (!busy) refresh().catch(e => notify(e.message, true)); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [busy, refresh, notify]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 6500); return () => clearTimeout(timer); }, [notice]);
  const selectProject = useCallback(async (value: string) => { selectedProject.current = value; setSessionId(''); setSnap(null); setProjectId(value); await refresh(value); }, [refresh]);
  const act = useCallback(async (action: string, args: Record<string, any> = {}, success?: string) => {
    activeOperations.current++; setBusy(action);
    try { const result = await invoke(action, { projectId, ...args }); await refresh(); if (result?.warning) notify(result.warning); else if (success) notify(success); return result; }
    catch (e: any) { notify(e.message || '操作失败', true); throw e; }
    finally { activeOperations.current--; if (!activeOperations.current) setBusy(''); }
  }, [projectId, refresh, notify]);
  return <AppContext.Provider value={{ snap, view, setView, projectId, sessionId, setSessionId, busy, notice, notify, refresh, act, selectProject, setExport, exportTarget }}>{children}</AppContext.Provider>;
}
