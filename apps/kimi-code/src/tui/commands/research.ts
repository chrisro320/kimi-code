import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

const RESEARCH_INVOCATION = [
  'The user explicitly invoked /research.',
  'Use the ReferenceAudit tool to investigate the supplied focus with read-only evidence gathering; do not automatically invoke Agora.',
  'Keep this audit session-scoped. Do not materialize or modify a Trellis task unless an active task already requires it and the user explicitly approves that follow-up.',
  'If any audit subagent is unavailable because of quota, provider, routing, timeout, or another runtime failure, continue the missing track with the main model and its permitted tools.',
  'Mark every such track as "main-model fallback (not independent consensus)", state why fallback was used, preserve unresolved unknowns, and never count the fallback as independent corroboration or multi-agent consensus.',
].join(' ');

export async function handleResearchCommand(host: SlashCommandHost, args: string): Promise<void> {
  const argument = args.trim();
  const action = argument.toLowerCase();

  if (action === 'status') {
    const research = host.state.appState.research;
    if (research === null || research === undefined) {
      host.showStatus('No research audit is active.');
      return;
    }
    const degraded = research.fallbackReason === undefined
      ? ''
      : ` · main-model fallback: ${research.fallbackReason}`;
    host.showStatus(`Research ${research.phase} · ${research.focus}${degraded}`);
    return;
  }

  if (action === 'cancel') {
    const research = host.state.appState.research;
    if (research === null || research === undefined) {
      host.showStatus('No research audit is active.');
      return;
    }
    if (host.session === undefined) {
      host.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    host.setAppState({ research: { ...research, phase: 'cancelling' } });
    try {
      await host.session.cancel();
      host.setAppState({ research: null });
      host.showStatus('Research audit cancelled.');
    } catch (error) {
      host.setAppState({ research });
      host.showError(`Failed to cancel research audit: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (argument.length === 0) {
    host.showError('Usage: /research <focus> | /research status | /research cancel');
    return;
  }
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.setAppState({
    research: {
      focus: argument,
      phase: 'starting',
      startedAtMs: Date.now(),
    },
  });
  host.sendNormalUserInput(`${RESEARCH_INVOCATION}\n\nResearch focus supplied by the user:\n${argument}`);
}
