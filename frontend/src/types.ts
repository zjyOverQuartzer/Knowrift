export type Message = { id: string; role: 'user' | 'assistant'; content: string; time: string; assisted?: boolean };
export type Session = { id: string; topic: string; createdAt: string; updatedAt: string; messages: Message[]; status: string; mainIndex: number; followUps: number; demo: boolean; summaryPaths: string[]; promptScope: string; reviewGapId?: string | null };
export type Gap = { id: string; knowledge: string; topic: string; status: string; dueAt: string; history: Array<Record<string, any>> };
export type Project = { id: string; name: string; root: string; archived: boolean };
export type Snapshot = { projects: Project[]; project: Project | null; settings: Record<string, any>; files: { path: string; size: number }[]; data: { sessions: Session[]; gaps: Gap[]; tasks: Record<string, any>[]; audit: Record<string, any>[]; feedback: Record<string, any>[]; strategies: Record<string, any>[]; memoryCandidates: Record<string, any>[]; memoryPaused: boolean; activeStrategyId: string | null } | null; evaluationCases: Record<string, any>[] };
export type View = 'workbench' | 'files' | 'memory' | 'prompts' | 'tasks' | 'strategies' | 'settings' | 'audit';
declare global { interface Window { zhixi?: { platform: string; invoke: (action: string, args?: Record<string, any>) => Promise<{ ok: boolean; data?: any; error?: string; code?: string }> } } }
