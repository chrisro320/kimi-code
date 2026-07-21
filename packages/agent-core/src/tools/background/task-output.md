Retrieve or resolve a background task snapshot.

Use the default `inspect` action after `Bash(run_in_background=true)` or `Agent(run_in_background=true)` to check progress, inspect an `input_required` editing candidate, or read a task that has already completed. Use `approve_scope_expansion` or `deny_scope_expansion` only with the exact candidate hash and requested scope reported by inspect.

Guidelines:
- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.
- By default this tool is non-blocking and returns a current status/output snapshot — that is the normal way to use it.
- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.
- Use block=true only when the user explicitly asked you to wait for the task. Never block on a task you launched in the current turn — if you need its result right away, it should have been a foreground call.
- If a block=true call returns `retrieval_status: timeout` (the task is still running), do not block on the same task again. Continue with other work or hand back to the user — the completion notification arrives on its own.
- Scope approval or denial is a mutating action and requires explicit permission. Identical repeated resolution is idempotent; stale, mismatched, corrupt, or conflicting candidates fail closed without workspace mutation.
- Candidate bundles are retained after approval, denial, stop, or conflict; this tool never auto-cleans them.
- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.
- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports `status: completed` on a zero exit, or `status: failed` with its non-zero `exit_code` — judge that failure from the `exit_code`, because a plain command failure carries no `stop_reason` and no `terminal_reason`. `terminal_reason` is a categorical label emitted only when the end is not an ordinary exit: `timed_out` when the deadline aborted it, `stopped` when it was explicitly stopped, or `failed` when it errored without producing an exit code; the `stopped` and `failed` cases also carry a human-readable `stop_reason`. A task that finished on its own with a clean exit carries neither `stop_reason` nor `terminal_reason`.
- The full, never-truncated log is always available at output_path; use the `Read` tool with that path to page through it, whether or not the preview was truncated.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.
