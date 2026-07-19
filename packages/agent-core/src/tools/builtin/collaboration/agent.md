Launch a subagent to handle a task. By default it runs as a same-process loop instance with its own context and wire file; configuration may route a subagent type to an external command backend instead. Delegating also keeps the bulk of intermediate work out of your own context — you get a conclusion back instead of a pile of dumps.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its `resume` id) over spawning a fresh instance — the resumed agent keeps its prior context.
- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.
- Subagents use a fixed 30-minute timeout. If one times out, resume the same agent instead of starting over.

When NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.

Optional `dispatch` metadata records your delegation decision: `rationale` explains why this is delegated; `scope` lists the workspace-relative files/directories/globs an editing subagent_type (`coder`, `coder-ex`, `frontend-artist`) may change — required for those types, and rejected if it overlaps another in-flight editing dispatch's scope. `quality_deficiencies` backs a `coder-ex` escalation with concrete failures in the prior result (not just task size or a preference for a stronger model). `review_reason` names the risk category that justifies a `reviewer` call. Each logical scope gets at most one `coder-ex` escalation and one `reviewer` repair; the runtime enforces this and queues or rejects launches that exceed it, so treat those responses as the actual outcome, not a bug.

Session dispatch mode (`/dispatch`) governs how proactive you should be: `auto` is the balanced default; `ask` and `off` mean the runtime will ask for confirmation before a multi-worker, editing, reviewer, or coder-ex dispatch (`off` asks even for an explicit request, since delegation intent is not otherwise verifiable) — expect and handle that confirmation step rather than treating it as a failure.
