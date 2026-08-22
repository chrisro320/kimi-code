import { AsyncEmitter, type IWaitUntilData } from '#/_base/event';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { BeforeToolExecuteEmitter } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { PrepareToolCallEmitter } from '#/agent/toolExecutor/prepareToolCallEvent';
import type {
  BeforeExecuteDecision,
  PrepareToolCallDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  ToolExecutionHookContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import { OrderedHookSlot } from '#/hooks';

export interface ToolExecutorEventStubs {
  readonly executor: IAgentToolExecutorService;
  readonly didExecuteSlot: OrderedHookSlot<ToolDidExecuteContext>;
  firePrepare(
    context: ToolExecutionHookContext,
  ): Promise<PrepareToolCallDecision | undefined>;
  fireBeforeExecute(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined>;
  fireWillExecute(
    data: IWaitUntilData<WillExecuteToolEvent>,
    signal: AbortSignal,
  ): Promise<void>;
}

export function stubToolExecutorEvents(): ToolExecutorEventStubs {
  const prepareEmitter = new PrepareToolCallEmitter();
  const beforeEmitter = new BeforeToolExecuteEmitter();
  const willEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  const didExecuteSlot = new OrderedHookSlot<ToolDidExecuteContext>();
  const executor: IAgentToolExecutorService = {
    _serviceBrand: undefined,
    execute: async function* () {},
    onPrepareToolCall: prepareEmitter.event,
    onBeforeExecuteTool: beforeEmitter.event,
    onWillExecuteTool: willEmitter.event,
    hooks: { onDidExecuteTool: didExecuteSlot },
    recordDupType: () => {},
    registerToolCallGuard: () => ({ dispose() {} }),
    registerUnavailableToolDescriber: () => ({ dispose() {} }),
    registerMissingToolDescriber: () => ({ dispose() {} }),
  };
  return {
    executor,
    didExecuteSlot,
    firePrepare: (context) => prepareEmitter.firePrepare(context),
    fireBeforeExecute: (context) => beforeEmitter.fireBeforeExecute(context),
    fireWillExecute: (data, signal) => willEmitter.fireAsync(data, signal),
  };
}
