/**
 * Cached output of a user-configured external statusline command.
 *
 * Mirrors the `git-status.ts` async-cache pattern: a 2s TTL and an
 * `onChange` callback on new output, but spawns `/bin/sh -c <command>`
 * with the current statusline state piped in as one line of JSON on
 * stdin. Any failure — spawn error, timeout, non-zero exit, empty
 * stdout — resolves to `null` so the caller hides the row instead of
 * surfacing an error into the TUI.
 */

import { execFile } from 'node:child_process';

import type { ManagedUsageRow } from '#/tui/components/messages/usage-panel';
import type { AgoraStatus, ResearchStatus } from '#/tui/types';

const REFRESH_TTL_MS = 2_000;
const SPAWN_TIMEOUT_MS = 1_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface CustomStatuslineAgentPayload {
  readonly agentId: string;
  readonly agentName: string;
  readonly startedAtMs: number;
  readonly tokens?: number;
}

export interface CustomStatuslinePayload {
  readonly weekly: ManagedUsageRow | null;
  readonly fiveHour: ManagedUsageRow | null;
  readonly lastCacheHit: number | null;
  readonly sessionCacheHit: number | null;
  readonly totalTokens: number;
  readonly lastReplyAt: number | null;
  readonly streamingPhase: string;
  /** Active Agora state; absent outside Agora and kept verbatim for custom consumers. */
  readonly agora?: AgoraStatus | null;
  /** Active /research state; absent outside an audit and kept verbatim for custom consumers. */
  readonly research?: ResearchStatus | null;
  /** Optional local-only dispatch observability; absent in older callers. */
  readonly dispatch?: {
    readonly active: number;
    readonly queued: number;
    readonly agents: readonly CustomStatuslineAgentPayload[];
    readonly reportedTokens: number | null;
  };
}

export interface CustomStatuslineCache {
  /** Returns the last successful command output, or `null` when none is available yet / the command failed. */
  getLine(payload: CustomStatuslinePayload): string | null;
}

export interface CustomStatuslineCacheOptions {
  readonly onChange?: () => void;
}

export function createCustomStatuslineCache(
  command: string,
  workDir: string,
  options: CustomStatuslineCacheOptions = {},
): CustomStatuslineCache {
  let line: string | null = null;
  let fetchedAt = 0;
  let pending = false;

  return {
    getLine: (payload) => {
      const now = Date.now();
      if (!pending && now - fetchedAt >= REFRESH_TTL_MS) {
        pending = true;
        void runCommand(command, workDir, payload).then((result) => {
          pending = false;
          fetchedAt = Date.now();
          const changed = result !== line;
          line = result;
          if (changed) options.onChange?.();
        });
      }
      return line;
    },
  };
}

function runCommand(
  command: string,
  workDir: string,
  payload: CustomStatuslinePayload,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        '/bin/sh',
        ['-c', command],
        {
          cwd: workDir,
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
        },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const firstLine = stdout.split('\n')[0]?.trim() ?? '';
          resolve(firstLine.length > 0 ? firstLine : null);
        },
      );
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}
