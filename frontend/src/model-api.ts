export type ModelProtocol = 'openai-compatible' | 'anthropic' | 'ollama';
export type ModelProfile = { id: string; name: string; protocol: ModelProtocol; baseUrl: string; model: string; anthropicAuth: 'x-api-key' | 'bearer'; workspaceId: string; hasKey: boolean; revision: number };
export type ModelSettingsState = { profiles: ModelProfile[]; activeProfileId: string | null };
export type SaveModelProfile = Omit<ModelProfile, 'hasKey' | 'revision'> & { expectedRevision: number; keyAction: 'keep' | 'replace' | 'clear'; apiKey?: string };
export type ModelTestResult = { profileId: string; revision: number; ok: boolean; code: string; message: string; preview: string; latencyMs: number };
export type ModelSettingsApi = {
  list(): Promise<ModelSettingsState>;
  save(input: SaveModelProfile): Promise<ModelProfile>;
  remove(id: string, expectedRevision: number): Promise<{ deleted: boolean }>;
  activate(profileId: string | null): Promise<ModelSettingsState>;
  test(id: string, expectedRevision: number): Promise<ModelTestResult>;
};
export const protocolLabels: Record<ModelProtocol, string> = { 'openai-compatible': 'Chat Completions 兼容', anthropic: 'Anthropic Messages', ollama: 'Ollama 原生 Chat' };
export const endpointSuffix: Record<ModelProtocol, string> = { 'openai-compatible': '/chat/completions', anthropic: '/messages', ollama: '/api/chat' };
export const baseExamples: Record<ModelProtocol, string> = { 'openai-compatible': 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', ollama: 'http://127.0.0.1:11434' };
