Cancel a scheduled cron job by id.

The `id` is the 8-hex value returned by `CronCreate`, or shown in the `id:` column of `CronList` — quote it verbatim, no prefix.

Behaviour by task kind:

- **Recurring task** (`recurring: true`): stops all future fires immediately; the scheduler picks up the deletion on its next tick.
- **One-shot task** (`recurring: false`): cancels the pending fire if it has not happened yet. Fired one-shots auto-delete themselves, so `CronDelete` on one returns "no cron job with id ...".

Not-found is reported as an error (not a silent no-op) so you can correct yourself — call `CronList` to see which ids are live rather than re-trying a stale one.

Refresh pattern (keep a stale recurring schedule going): stale recurring tasks are auto-deleted after their final fire — there is nothing for `CronDelete` to remove. Call `CronCreate` with the same `cron` and `prompt`; use `CronList`'s `prompt` field to recall the original text after a context compaction. `CronDelete` remains the right call for live tasks (recurring not yet stale, one-shot still pending).

Guidelines:

- Users have no `/cron` command or self-service UI; they must ask the model. Confirm deletions done on their behalf and report the result plainly.
- Deletion is irreversible — a wrongly deleted task must be re-created with `CronCreate`.
- Unsure which id is current (e.g. after a context compaction)? Call `CronList` first rather than guessing.
