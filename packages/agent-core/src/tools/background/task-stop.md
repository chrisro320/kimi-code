Stop a running or `input_required` background task.

Use only when a task must genuinely be cancelled. Long runtime, slow progress, or an empty buffered output log does not mean a task is stuck — for a task that may still be healthy, inspect it with `TaskOutput` and keep waiting for its completion notification instead.

Guidelines:
- Before stopping, inspect the configured timeout, live task/process status, recent output or file/test activity, reported token/usage headroom when available, and whether the backend can resume after termination.
- Stop only for: actual timeout, process failure, explicit user cancellation, independently verified no-progress, or an immediate safety or ownership violation.
- Except for an immediate safety violation, obtain explicit user confirmation before a destructive stop; warn that terminating an external CLI may make its session impossible to resume.
- Preserve recoverable session, route, workspace, and diff metadata before termination when the task kind exposes it. Stopping an `input_required` task changes its status but retains its persisted candidate bundle.
- General-purpose stop capability for any background task — not a bash-specific kill.
- Destructive and may leave partial side effects — never use it merely to shorten a wait.
- If the task has already finished, simply returns its current status.
