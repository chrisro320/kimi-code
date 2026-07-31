Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating keeps the bulk of intermediate file contents out of your own context — you get a conclusion back, not a pile of dumps.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked in: state the goal, list what you know, hand over specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt; don't make the subagent search for what you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding: if the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- To continue a subagent's earlier work, resume it (pass its `resume` id) rather than spawning fresh — the resumed agent keeps its prior context.
- A subagent's result is only visible to you, not the user; summarize the relevant parts in your own reply.
- Subagents have a fixed 2-hour timeout; on timeout, resume the same agent.

When NOT to use Agent: skip delegation for trivial work — reading a known path, searching a small known set, or one- to two-step tasks. Delegation has a context-handoff cost; it pays off only on substantial tasks.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway to finish manually — both undo the context savings.
