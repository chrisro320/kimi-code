export interface AgoraRecoveryDetails {
  readonly runId?: string;
  readonly insertedTask?: string;
}

/** Render local-only recovery guidance without exposing an in-process capability. */
export function formatAgoraRecoveryInstructions(details: AgoraRecoveryDetails): string {
  const messages = [
    details.runId === undefined ? undefined : `Known run id ${details.runId}.`,
    details.insertedTask === undefined ? undefined : `Known inserted task ${details.insertedTask}.`,
  ].filter((message): message is string => message !== undefined);
  if (details.insertedTask !== undefined) {
    const task = details.insertedTask.replaceAll("'", "'\\''");
    messages.push(
      `From the project root, run \`python3 ./.trellis/scripts/task.py agora-cancel '${task}'\` to recover the Trellis task.`,
    );
  }
  return messages.length === 0 ? '' : ` ${messages.join(' ')}`;
}
