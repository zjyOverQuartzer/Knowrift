import { lazy, Suspense, useEffect, useState } from 'react';
import type { RuntimeDescriptor } from './project-api';

const Legacy = lazy(async () => {
  const [{ default: App }, { AppProvider }] = await Promise.all([import('./App'), import('./state')]);
  return { default: () => <AppProvider><App/></AppProvider> };
});
const JavaProjects = lazy(() => import('./JavaProjects'));
export function Bootstrap() {
  const [runtime, setRuntime] = useState<RuntimeDescriptor | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const bridge = window.zhixi;
    if (!bridge) return;
    let active = true, receivedEvent = false;
    const off = bridge.onRuntimeStatus(value => { if (active) { receivedEvent = true; setRuntime(value); } });
    bridge.getRuntime().then(value => { if (active && !receivedEvent) setRuntime(value); }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; off(); };
  }, []);
  if (error) return <div className="empty" role="alert">{error}</div>;
  if (!window.zhixi && import.meta.env.VITE_ZHIXI_BACKEND_MODE === 'java') return <div className="empty">新版项目管理请通过桌面应用打开。</div>;
  if (window.zhixi && !runtime) return <div className="empty">正在连接本机服务…</div>;
  return <Suspense fallback={<div className="empty">正在读取本地空间…</div>}>{runtime?.mode === 'java' ? <JavaProjects runtime={runtime}/> : <Legacy/>}</Suspense>;
}
