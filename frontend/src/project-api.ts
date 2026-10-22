export type ServiceName = 'java' | 'python';
export type ServiceStatus = { state: 'starting' | 'ready' | 'failed' | 'stopped'; message: string };
export type RuntimeDescriptor = { mode: 'java' | 'legacy'; capabilities: { projectManagement: boolean; learning: boolean; importProject: boolean; export: boolean }; services: Partial<Record<ServiceName, ServiceStatus>> };
export type ManagedProject = { id: string; name: string; root: string; archived: boolean; availability: 'available' | 'missing' | 'unreadable' | 'invalid' };
export type CreateProject = { name: string; directory?: string; clientRequestId: string };
export type ProjectPatch = { name?: string; archived?: boolean };
export type ProjectApi = {
  list(): Promise<ManagedProject[]>;
  get(id: string): Promise<ManagedProject>;
  create(input: CreateProject): Promise<ManagedProject>;
  patch(id: string, patch: ProjectPatch): Promise<ManagedProject>;
  openFolder(id: string): Promise<{ opened: boolean }>;
};
