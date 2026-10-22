import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { Busy, Empty } from './components';
import { baseExamples, endpointSuffix, protocolLabels } from './model-api';
import type { ModelProfile, ModelProtocol, ModelSettingsState, ModelTestResult, SaveModelProfile } from './model-api';
import type { RuntimeDescriptor } from './project-api';
import './model-settings.css';

type Draft = SaveModelProfile & { hasKey: boolean };
const fromProfile = (profile: ModelProfile): Draft => ({ ...profile, expectedRevision: profile.revision, keyAction: profile.hasKey ? 'keep' : 'clear', apiKey: '' });
const empty = (): Draft => ({ id: crypto.randomUUID(), name: '', protocol: 'openai-compatible', baseUrl: '', model: '', anthropicAuth: 'x-api-key', workspaceId: '', expectedRevision: 0, hasKey: false, keyAction: 'clear', apiKey: '' });
const noProfiles: ModelSettingsState = { profiles: [], activeProfileId: null };

export default function ModelSettings({ runtime }: { runtime: RuntimeDescriptor }) {
  const api = window.zhixi!.modelSettings;
  const [state, setState] = useState<ModelSettingsState>(noProfiles);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const ready = runtime.services.java?.state === 'ready';
  const agentReady = runtime.services.python?.state === 'ready';
  const active = state.profiles.find(item => item.id === state.activeProfileId);
  const result = draft && !dirty && results[draft.id]?.revision === draft.expectedRevision ? results[draft.id] : null;
  const refresh = useCallback(async (target?: string, replace = false) => {
    const current = ++sequence.current;
    const value = await api.list();
    if (current !== sequence.current) return;
    setState(value);
    setDraft(old => {
      if (old && !replace) return old;
      const found = value.profiles.find(item => item.id === (target || old?.id)) || value.profiles[0];
      return found ? fromProfile(found) : null;
    });
    setLoading(false);
  }, [api]);
  useEffect(() => {
    if (!ready) { setLoading(false); return; }
    setLoading(true); refresh().catch(cause => { setError(cause.message); setLoading(false); });
    return () => { sequence.current++; };
  }, [ready, refresh]);
  const discard = () => !dirty || window.confirm('放弃尚未保存的模型配置修改？');
  const select = (profile?: ModelProfile) => {
    if (!discard()) return;
    setDraft(profile ? fromProfile(profile) : empty()); setDirty(!profile); setError(''); setMessage('');
  };
  const update = (change: Partial<Draft>) => { setDraft(old => old ? { ...old, ...change } : old); setDirty(true); setError(''); setMessage(''); };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const save = () => perform(async () => {
    if (!draft) return;
    const saved = await api.save(draft);
    setDraft(fromProfile(saved)); setDirty(false);
    setState(old => ({ ...old, profiles: [...old.profiles.filter(item => item.id !== saved.id), saved] }));
    setResults(old => { const next = { ...old }; delete next[saved.id]; return next; });
    setMessage('模型配置已保存；可测试连接或设为当前配置。');
  });
  const test = async () => {
    if (!draft) return;
    const selected = draft; setTesting(selected.id); setError(''); setMessage('');
    try {
      const response = await api.test(selected.id, selected.expectedRevision);
      setResults(old => ({ ...old, [selected.id]: response }));
    } catch (cause) {
      setResults(old => ({ ...old, [selected.id]: { profileId: selected.id, revision: selected.expectedRevision, ok: false, code: (cause as {code?: string}).code || 'SERVICE_UNAVAILABLE', message: cause instanceof Error ? cause.message : '连接测试失败', latencyMs: 0, preview: '' } }));
    } finally { setTesting(null); }
  };
  const remove = () => {
    if (!draft || !window.confirm(`删除“${draft.name}”配置？${draft.id === state.activeProfileId ? '当前配置选择也会清空。' : ''}`)) return;
    const selected = draft;
    void perform(async () => { await api.remove(selected.id, selected.expectedRevision); setDirty(false); await refresh('', true); setMessage('模型配置已删除。'); });
  };
  return <section className="model-settings" aria-label="模型设置">
    <div className="model-settings-heading"><div><h1>模型设置</h1><p className="muted">保存多套连接配置，选择一套供所有项目使用。</p></div><button disabled={!ready || busy} onClick={() => { if (discard()) { setDirty(false); void perform(() => refresh(undefined, true)); } }}><RefreshCw size={15}/>重新加载配置</button></div>
    <div className="model-active surface"><Settings2 size={20}/><div><strong>全局当前配置</strong><p data-testid="active-model">{active ? `${active.name} · ${active.model}` : '尚未选择'}</p></div>{active ? <button disabled={!ready || busy} onClick={() => void perform(async () => { setState(await api.activate(null)); setMessage('已清空当前配置选择。'); })}>清空选择</button> : null}</div>
    {!ready ? <p role="alert" className="model-error">项目服务尚未就绪，暂时无法读取或保存模型配置。请通过上方服务状态重试。</p> : null}
    {error ? <p role="alert" className="model-error">{error}</p> : null}
    {message ? <p role="status" className="model-message">{message}</p> : null}
    <div className="model-layout"><aside className="surface model-profile-list"><div className="model-list-heading"><h2>连接配置</h2><button className="icon-button" aria-label="新增模型配置" disabled={!ready || busy} onClick={() => select()}><Plus size={19}/></button></div>
      {loading ? <Busy label="正在读取配置"/> : state.profiles.length ? state.profiles.map(profile => <button key={profile.id} className={draft?.id === profile.id ? 'selected' : ''} disabled={busy || !ready} onClick={() => select(profile)}><span><strong>{profile.name}</strong><small>{protocolLabels[profile.protocol]}</small><small>{profile.model}</small></span>{state.activeProfileId === profile.id ? <CheckCircle2 size={16} aria-label="当前配置"/> : null}</button>) : <p className="muted">还没有模型配置。</p>}
      <button disabled={!ready || busy} onClick={() => select()}><Plus size={15}/>新增配置</button>
    </aside><div className="surface model-editor">{draft ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="model-editor-heading"><h2>{draft.expectedRevision ? '编辑连接配置' : '新增连接配置'}</h2><span className="muted">{dirty ? '有未保存的修改' : '已保存'}</span></div>
      <fieldset disabled={!ready || busy}><div className="model-form-grid">
        <label>配置名称<input aria-label="配置名称" required maxLength={80} value={draft.name} onChange={event => update({ name: event.target.value })} placeholder="例如：百炼学习模型"/></label>
        <label>接口协议<select aria-label="接口协议" value={draft.protocol} onChange={event => update({ protocol: event.target.value as ModelProtocol })}>{Object.entries(protocolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="model-wide">基础地址<input aria-label="模型基础地址" type="url" required maxLength={2048} value={draft.baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder={baseExamples[draft.protocol]}/></label>
        <div className="model-endpoint model-wide"><small>最终请求地址</small><code data-testid="model-endpoint">{draft.baseUrl.trim() ? draft.baseUrl.trim().replace(/\/+$/, '') + endpointSuffix[draft.protocol] : baseExamples[draft.protocol] + endpointSuffix[draft.protocol]}</code><small>远程使用 HTTPS；本机回环地址可使用 HTTP。填写基础地址，无需填写末尾接口路径。</small></div>
        <label className="model-wide">模型标识<input aria-label="模型标识" required maxLength={200} value={draft.model} onChange={event => update({ model: event.target.value })} placeholder="填写提供商的模型 ID"/></label>
        {draft.protocol === 'anthropic' ? <><label>Anthropic 鉴权<select aria-label="Anthropic 鉴权" value={draft.anthropicAuth} onChange={event => update({ anthropicAuth: event.target.value as Draft['anthropicAuth'] })}><option value="x-api-key">x-api-key</option><option value="bearer">Authorization Bearer</option></select></label><label>工作区 ID（可选）<input aria-label="Anthropic 工作区 ID" maxLength={200} value={draft.workspaceId} onChange={event => update({ workspaceId: event.target.value })} placeholder="多工作区密钥需要填写"/></label></> : null}
        <label>密钥操作<select aria-label="密钥操作" value={draft.keyAction} onChange={event => update({ keyAction: event.target.value as Draft['keyAction'], apiKey: '' })}><option value="keep" disabled={!draft.hasKey}>保留已保存密钥</option><option value="replace">输入新密钥</option><option value="clear">清除密钥 / 本机免密</option></select></label>
        <label>API Key <small>{draft.hasKey ? '已配置，不回显' : '尚未配置'}</small><input aria-label="模型 API Key" type="password" autoComplete="new-password" disabled={draft.keyAction !== 'replace'} required={draft.keyAction === 'replace'} maxLength={8192} value={draft.apiKey || ''} onChange={event => update({ apiKey: event.target.value })} placeholder="仅输入本套配置的密钥"/></label>
      </div></fieldset>
      <p className="model-key-note muted">密钥加密保存在本机。更改协议或基础地址后，请重新输入密钥；本机免密服务可选择清除密钥。</p>
      <div className="button-row model-actions"><button className="primary" type="submit" disabled={!ready || busy || !dirty}>{busy ? '正在保存…' : '保存配置'}</button><button type="button" disabled={!ready || busy || dirty || !draft.expectedRevision || !!testing || !agentReady} onClick={() => void test()}>{testing === draft.id ? <Busy label="正在测试…"/> : '测试连接'}</button><button type="button" disabled={!ready || busy || dirty || !draft.expectedRevision || state.activeProfileId === draft.id} onClick={() => void perform(async () => { setState(await api.activate(draft.id)); setMessage('已设为全局当前配置。'); })}>设为当前配置</button>{draft.expectedRevision ? <button className="model-delete" type="button" aria-label="删除模型配置" disabled={!ready || busy} onClick={remove}><Trash2 size={15}/>删除配置</button> : null}</div>
      {dirty ? <p className="muted model-test-note">保存后即可测试连接或设为当前配置。</p> : !agentReady ? <p className="muted model-test-note">智能服务尚未就绪，仍可保存和切换配置；连接测试需等待服务就绪。</p> : <p className="muted model-test-note">测试会发起一次真实模型请求，可能产生少量调用费用。</p>}
      {result ? <div className={`model-test-result ${result.ok ? 'success' : 'failure'}`} role="status" data-testid="model-test-result"><strong>{result.ok ? '连接测试成功' : '连接测试失败'}{result.latencyMs ? ` · ${result.latencyMs} ms` : ''}</strong><p>{result.message}</p>{result.preview ? <pre>{result.preview}</pre> : null}{!result.ok ? <small>{result.code}</small> : null}</div> : !testing && draft.expectedRevision && !dirty ? <p className="muted" data-testid="model-untested">此配置尚未测试；可直接设为当前配置。</p> : null}
    </form> : <Empty><Settings2 size={32}/><h2>添加第一套模型配置</h2><p>填写访问地址、模型标识和密钥，保存后测试连接。</p><button className="primary" disabled={!ready} onClick={() => select()}>添加模型配置</button></Empty>}</div></div>
  </section>;
}
