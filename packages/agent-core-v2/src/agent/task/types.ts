export type AgentTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost'
  | 'input_required'
  | 'expansion_denied';

export const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
  'expansion_denied',
]);
export type AgentTaskSettlementStatus = 'completed' | 'failed' | 'timed_out' | 'killed' | 'input_required';

export interface AgentTaskSettlement {
  readonly status: AgentTaskSettlementStatus;
  readonly stopReason?: string;
  readonly editingCandidate?: {
    readonly draft: import('#/session/subagent/worktree').EditingCandidateDraft;
    readonly acknowledgePersisted?: () => Promise<void>;
  };
}

export interface AgentTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface AgentTaskInfoByKind {}

export type AgentTaskKind = Extract<keyof AgentTaskInfoByKind, string>;

export type AgentTaskInfo = AgentTaskInfoByKind[AgentTaskKind];

export interface AgentTaskSink {
  readonly signal: AbortSignal;
  appendOutput(chunk: string): void;
  settle(settlement: AgentTaskSettlement): Promise<boolean>;
}

export interface AgentTask {
  readonly idPrefix: string;
  readonly kind: AgentTaskKind;
  readonly description: string;
  readonly timeoutMs?: number;

  start(sink: AgentTaskSink): void | Promise<void>;
  onDetach?(): void;
  forceStop?(): Promise<void>;
  toInfo(base: AgentTaskInfoBase): AgentTaskInfo;
}
