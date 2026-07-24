Launch a subagent to handle a task. By default it runs as a same-process loop instance with its own context and wire file; configuration may route a subagent type to an external command backend. Delegating keeps the bulk of intermediate work out of your own context — you get a conclusion back, not a pile of dumps.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked in: state the goal, list what you know, hand over specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt; don't make the subagent search for what you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding: if the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- To continue a subagent's earlier work, resume it (pass its `resume` id) rather than spawning fresh — the resumed agent keeps its prior context.
- For fixable defects, missing requirements, or failed validation, resume the same agent with that concrete evidence before considering replacement or escalation.
- A subagent's result is only visible to you, not the user; summarize the relevant parts in your own reply.
- Subagents have a fixed 30-minute timeout; on timeout, resume the same agent.

When NOT to use Agent: skip delegation for trivial work — reading a known path, searching a small known set, or one- to two-step tasks. Delegation has a context-handoff cost; it pays off only on substantial tasks.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway to finish manually — both undo the context savings.

Optional `dispatch` metadata records the delegation decision: `rationale` (why delegated); `scope` (workspace-relative files/directories/globs an editing subagent_type — `coder`, `coder-ex`, `frontend-artist` — may change; required for those types, rejected on overlap with an in-flight editing scope); `quality_deficiencies` (concrete failures in the prior result backing a `coder-ex` escalation); `review_reason` (risk category justifying a `reviewer` call). Each logical scope gets at most one `coder-ex` escalation and one `reviewer` repair; the runtime queues or rejects excess launches — treat that as the actual outcome, not a bug.

Session dispatch mode (`/dispatch`): `auto` is the balanced default; `ask` and `off` make the runtime ask for confirmation before multi-worker, editing, reviewer, or coder-ex dispatches (`off` asks even for explicit requests) — expect that confirmation step; it is not a failure.
