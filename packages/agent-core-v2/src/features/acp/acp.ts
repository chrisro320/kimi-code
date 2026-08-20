/**
 * `acp` domain — public Agent-scoped ACP service contract.
 *
 * The service owns the optional per-agent sidecar and registers the ACP
 * context manager. Activation remains controlled by the existing
 * `contextManager` config section.
 */

import { createDecorator } from '#/_base/di/instantiation';

export const ACP_MANAGER_ID = 'acp-kernel';
export const ACP_MANAGER_VERSION = '1';

export type AcpHealth = 'healthy' | 'degraded';

export interface AcpStatus {
  readonly managerId: string;
  readonly managerVersion: string;
  readonly health: AcpHealth;
  readonly refs: number;
  readonly blocks: number;
  readonly activeBlocks: number;
  readonly contextUsage?: number;
  readonly foldedTokens?: number;
  readonly reason?: string;
}

export interface AcpMutationResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface IAcpService {
  readonly _serviceBrand: undefined;

  isActive(): boolean;
  status(): AcpStatus;
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** Disk-derived status: loads and validates the sidecar instead of returning
   *  the in-memory snapshot, which holds constructor defaults between a restart
   *  and the first turn. An in-memory runtime degradation still wins over a
   *  healthy disk read; a corrupt sidecar degrades the live status. */
  statusSnapshot(): Promise<AcpStatus>;
  statusReport(): Promise<AcpMutationResult>;
  compress(input: {
    readonly ranges: readonly {
      readonly startRef: string;
      readonly endRef: string;
      readonly summary: string;
      readonly topic?: string;
    }[];
    /** Id of the compress tool call being served; recorded on the created
     *  blocks so the kernel keeps the call/result pair visible (and hides it
     *  only once every block it produced has been distilled away). */
    readonly toolCallId?: string;
    /** Abort signal from the serving tool call; once it fires the mutation
     *  is abandoned before persistence (all-or-nothing). */
    readonly signal?: AbortSignal;
  }): Promise<AcpMutationResult>;
  decompress(input: {
    readonly blockId: string;
    readonly full?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<AcpMutationResult>;
  search(input: { readonly query: string; readonly limit?: number }): Promise<AcpMutationResult>;
  reset(): Promise<void>;
}

export const IAcpService = createDecorator<IAcpService>('acpService');
