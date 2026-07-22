Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. `0 9 * * *` means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete. Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false

Best for near-term reminders — a task only fires while its session is still alive (see Session lifetime), so favor near times (hours to a few days) over weeks/months ahead.

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests: `*/5 * * * *` (every 5 min), `0 9 * * 1-5` (weekdays at 9am local). Use for periodic polling, workday rituals, and anything the user described as recurring.

## Avoid :00/:30 minute marks; the system also jitters automatically

Every "9am"/"hourly" request defaults to `0 9`/`0 *` — landing every user's fleet on the API at the same instant. When the request is approximate, pick a non-round minute instead:
  "every morning around 9" → "57 8 * * *" (not "0 9 * * *"); "hourly" → "7 * * * *" (not "0 * * * *")
Only use :00/:30 when the user names that exact time and means it ("at 9:00 sharp").

On top of that manual choice, the scheduler also applies deterministic anti-herd jitter per task id regardless: recurring fires shift **forward** by ≤ min(10% of the period, 15 min); a one-shot landing exactly on :00/:30 is pulled **earlier** by ≤90s. This is a safety net, not a substitute for picking a non-round minute yourself.

## Coalesce semantics

Fires are delivered only while the session is idle — one held during an active turn fires at the next idle moment, never mid-turn. If the scheduler slept past multiple ideal fire times (laptop closed, long turn), only **one** fire is delivered, with `coalescedCount` showing how many were collapsed. Treat `coalescedCount > 1` as "only the latest state matters," not as N separate runs.

## Cron-fire envelope

When a task fires, the scheduled prompt is re-injected wrapped in a parseable XML envelope:

```
<cron-fire jobId="..." cron="..." recurring="true|false" coalescedCount="N" stale="true|false">
<prompt>
your original prompt text, verbatim
</prompt>
</cron-fire>
```

`stale="true"` means the task is past its 7-day threshold (see below).

## 7-day stale behavior

A recurring task alive for more than 7 days fires one final time with `stale: true`, then the system auto-deletes it — that flag is your notice this is the last delivery. To keep the schedule going, call `CronCreate` again with the same `cron` and `prompt` (resets `createdAt`, starts a fresh 7-day window). One-shot tasks are never marked stale.

## Session lifetime

Cron tasks live in the current kimi CLI session, persisted under the session homedir; `kimi resume` of the same session reloads them and resumes from each task's `createdAt` (offline fire times collapse via `coalescedCount`/`stale` as above). Tasks do **not** carry into a brand-new session — scoped to the resumed session id, not the working directory.

## Limits

A session holds at most 50 live cron tasks (rejected beyond that); the `prompt` body is also capped (see its parameter description). Expressions with no fire in the next 5 years are rejected at create time.

## Returned fields

`id` (8-hex, needed by `CronDelete`), `cron` (normalized expression), `humanSchedule` (English summary), `recurring`, `nextFireAt` (local ISO timestamp with numeric offset, or null).

## Tell the user how to cancel or modify

After creating a task, proactively tell the user how to cancel or modify it later — they have no self-service UI, only the model. Include the task `id` so they can reference it.
