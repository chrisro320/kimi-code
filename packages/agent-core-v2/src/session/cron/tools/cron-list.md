List all cron jobs currently scheduled in this session.

Shows every pending cron task — recurring jobs and one-shot reminders — scheduled with `CronCreate`. Each record carries:

- `id` — the task id (a ULID). Pass to `CronDelete`, or quote it in user-facing messages when asking for confirmation.
- `cron` — the verbatim 5-field cron expression as scheduled.
- `humanSchedule` — plain-English rendering (e.g. `every 5 minutes`).
- `prompt` — the scheduled prompt text, JSON-encoded so embedded newlines stay on one line; truncated to 200 UTF-8 bytes with `…(truncated)`. Use it to recall a task's purpose after context compaction, and as the source for the `CronCreate` refresh ritual.
- `nextFireAt` — local ISO timestamp with numeric offset for the next fire **after jitter has been applied** (actual fire may land slightly off a round `:00` / `:30` mark); `null` if no fire in the next 5 years (should not happen for `CronCreate` tasks, which validate).
- `recurring` — `true` for cadenced jobs, `false` for one-shots.
- `ageDays` — `(now - createdAt) / day`, two decimal places; useful when judging whether a long-running cron is still relevant.
- `stale` — `true` when a recurring task is older than 7 days: the system **auto-deletes it after this fire**, so this is the final delivery. To resume the schedule, call `CronCreate` again with the original `cron` and `prompt` (the `prompt` row carries it for this purpose). One-shots are never marked stale.

Guidelines:

- Read-only and never mutates state — always safe to call (including in plan mode).
- Users cannot manage cron tasks directly; route cancel/modify requests through the model (`CronDelete` / `CronCreate` on their behalf).
- Empty case returns `cron_jobs: 0\nNo cron jobs scheduled.`. Tasks survive a resume of the same session but do not bleed into new sessions.
- After a context compaction, or whenever unsure which jobs are live, re-enumerate with this tool rather than guessing ids.
- Records are separated by a `---` line, in the order they were scheduled.
