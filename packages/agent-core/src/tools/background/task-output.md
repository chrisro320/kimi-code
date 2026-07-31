Retrieve or resolve a background task snapshot.

Default `inspect` after `Bash(run_in_background=true)`, `Agent(run_in_background=true)`, or `AskUserQuestion(background=true)`: check progress, inspect an `input_required` editing candidate, or read a completed task. Use `approve_scope_expansion` / `deny_scope_expansion` only with the exact candidate hash and requested scope reported by inspect.

Guidelines:
- Prefer automatic completion notifications; use this tool only when you need task output before the notification arrives.
- Non-blocking by default — returns a current status/output snapshot; that is the normal usage.
- Do not use it to wait for a result you need — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is a deliberate progress check you act on without blocking.
- `block=true` only when the user explicitly asked you to wait; never block on a task launched this turn. If `block=true` returns `retrieval_status: timeout`, do not block on the same task again — continue or hand back; the completion notification arrives on its own.
- Scope approval/denial is mutating and requires explicit permission. Identical repeats are idempotent; stale, mismatched, corrupt, or conflicting candidates fail closed without workspace mutation. Candidate bundles are retained after approval, denial, stop, or conflict — never auto-cleaned.
- Returns structured metadata, a fixed-size output preview, and `output_path` for the full log; page through it with `Read` whether or not the preview was truncated.
- Terminal metadata explains why the task ended: clean zero exit → `status: completed`; non-zero → `status: failed` with `exit_code` (judge from the code — a plain command failure carries no `stop_reason` and no `terminal_reason`). `terminal_reason` appears only when the end is not an ordinary exit: `timed_out`, `stopped`, or `failed` (errored without an exit code); `stopped` and `failed` also carry a human-readable `stop_reason`.
- Primary read path for the generic background task system, not just bash.
