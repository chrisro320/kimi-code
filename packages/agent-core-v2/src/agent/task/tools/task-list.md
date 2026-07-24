List background tasks and their current status.

Discovers which background tasks exist and where each one stands: task ID, status, and description, plus the command, PID, and (once finished) exit code for shell tasks, and a stop reason for any task that ended early.

Guidelines:

- After a context compaction, or whenever unsure which tasks are running or what their IDs are, re-enumerate with this tool instead of guessing a task ID.
- Default `active_only=true` lists non-terminal tasks — including `input_required` tasks awaiting an explicit scope decision (actionable, not still executing). Pass `active_only=false` only to see finished tasks; the result may then include `lost` tasks (left over from a previous process, no longer inspectable or controllable — treat them as already terminated).
- `limit` caps how many tasks are returned: 1-100, default 20.
- Lists tasks only, not their output — locate the task ID here, then call `TaskOutput` for output and details.
- Read-only and changes no state — always safe to call, including in plan mode.
