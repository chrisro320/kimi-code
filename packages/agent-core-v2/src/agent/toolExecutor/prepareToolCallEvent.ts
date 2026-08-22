import { Emitter } from '#/_base/event';
import { BugIndicatingError } from '#/errors';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type { ExecutableTool, ExecutableToolResult } from '#/tool/toolContract';

import type {
  PrepareToolCallDecision,
  PrepareToolCallEvent,
  ToolExecutionHookContext,
} from './toolHooks';

export class PrepareToolCallEventImpl implements PrepareToolCallEvent {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;

  private _vetoResult: ExecutableToolResult | undefined;
  private _updatedArgs: unknown;
  private _open = true;

  constructor(context: ToolExecutionHookContext) {
    this.turnId = context.turnId;
    this.signal = context.signal;
    this.trace = context.trace;
    this.toolCall = context.toolCall;
    this.toolCalls = context.toolCalls;
    this.tool = context.tool;
    this.args = context.args;
  }

  veto(result: ExecutableToolResult): void {
    this.assertOpen('veto');
    this._vetoResult ??= result;
  }

  setUpdatedArgs(args: unknown): void {
    this.assertOpen('setUpdatedArgs');
    this._updatedArgs ??= args;
  }

  get vetoResult(): ExecutableToolResult | undefined {
    return this._vetoResult;
  }

  get updatedArgs(): unknown {
    return this._updatedArgs;
  }

  closeRegistration(): void {
    this._open = false;
  }

  private assertOpen(statement: string): void {
    if (!this._open) {
      throw new BugIndicatingError(`${statement} can NOT be called asynchronously`);
    }
  }
}

export class PrepareToolCallEmitter extends Emitter<PrepareToolCallEvent> {
  async firePrepare(
    context: ToolExecutionHookContext,
  ): Promise<PrepareToolCallDecision | undefined> {
    if (this.isDisposed || this._listeners === undefined || this._listeners.size === 0) {
      return undefined;
    }

    const event = new PrepareToolCallEventImpl(context);
    try {
      for (const entry of Array.from(this._listeners)) {
        await entry.listener.call(entry.thisArg, event);
        if (event.vetoResult !== undefined) {
          return { veto: event.vetoResult, updatedArgs: event.updatedArgs };
        }
      }
      return event.updatedArgs === undefined ? undefined : { updatedArgs: event.updatedArgs };
    } finally {
      event.closeRegistration();
    }
  }
}
