import type { ReactNode } from 'react';
import { X, LoaderCircle } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp, invoke } from './state';
export function Markdown({ content }: { content: string }) {
  const { snap, setSessionId, setView, notify } = useApp();
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => /^zhixi:\/\/session\/[a-z0-9-]+$/i.test(url) ? url : defaultUrlTransform(url)} components={{ a: ({ href, children }) => <a href={href} onClick={e => {
    e.preventDefault();
    if (href?.startsWith('zhixi://session/')) { const id = href.slice('zhixi://session/'.length); if (snap?.data?.sessions.some(s => s.id === id)) { setSessionId(id); setView('workbench'); } else notify('当前项目中未找到来源对话', true); }
    else if (href?.startsWith('https://')) invoke('openReference', { url: href }).catch(() => notify('参考链接：' + href));
  }}>{children}</a> }}>{content}</ReactMarkdown></div>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) { return <div className="modal-shade" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={19}/></button></header>{children}</section></div>; }
export function Busy({ label = '正在处理' }: { label?: string }) { return <span className="busy"><LoaderCircle size={16} className="spin"/>{label}</span>; }
export const date = (value: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const attempt = (promise: Promise<any>) => { promise.catch(() => {}); };
