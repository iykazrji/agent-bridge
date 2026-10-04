export type Provider = 'codex' | 'claude';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface Session {
  id: string;
  provider: Provider;
  repo: string;
  workflow: string;
  role: string | null;
  nativeId: string | null;
  managed: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export interface RegisterSessionInput {
  provider: Provider;
  repo: string;
  workflow: string;
  role?: string;
  nativeId?: string;
}

export interface Task {
  id: string;
  requesterSessionId: string;
  workerSessionId: string;
  workflow: string;
  repo: string;
  provider: Provider;
  prompt: string;
  model: string | null;
  parentTaskId: string | null;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  ownerToken: string | null;
  leaseUntil: number | null;
  timeoutMs: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  nativeId: string | null;
  commitSha: string | null;
  artifactDir: string;
  resultPath: string;
  logPath: string;
}

export interface CreateTaskInput {
  provider: Provider;
  repo: string;
  workflow: string;
  prompt: string;
  requesterSessionId?: string;
  role?: string;
  model?: string;
  timeoutMs?: number;
  parentTaskId?: string;
  commitSha?: string;
}

export interface Claim {
  task: Task;
  token: string;
  leaseUntil: number;
}

export interface FinishTaskInput {
  status: 'succeeded' | 'failed';
  result?: string;
  error?: string;
  nativeId?: string;
  commitSha?: string;
  artifactDir?: string;
  resultPath?: string;
  logPath?: string;
}

export interface InboxMessage {
  id: string;
  recipientSessionId: string;
  taskId: string | null;
  senderSessionId: string | null;
  kind: 'message' | 'task_succeeded' | 'task_failed' | 'task_interrupted';
  body: string;
  createdAt: number;
  acknowledgedAt: number | null;
}

export interface SessionContext {
  session: Session;
  relatedSessions: Session[];
  tasks: Task[];
  messages: InboxMessage[];
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  payload: string;
  createdAt: number;
}
