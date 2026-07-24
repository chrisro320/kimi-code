Use this tool to maintain a structured TODO list through a multi-step task. Use it proactively and often when progress tracking helps — long-running investigations and implementations with several tool calls. In plan mode, write the plan to the plan file rather than tracking it here.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them
- Capturing new multi-step instructions as todos
- Mark exactly one item `in_progress` before starting it; mark it `done` immediately after finishing — do not batch completions at the end

**When NOT to use:**
- Single-shot answers that complete in one or two tool calls
- Trivial requests where tracking adds no clarity
- Purely conversational or informational replies

**Avoid churn:**
- Update only after real progress — do not re-call when nothing meaningful has changed.
- Unsure of the current state? Call query mode (omit `todos`) to check before deciding what to update.
- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.

**How to use:**
- `todos: [...]` replaces the full list; statuses: pending / in_progress / done. Call with no `todos` argument to retrieve the current list without changing it; `todos: []` clears it.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- Keep exactly one task `in_progress` while work is underway.
- Mark `done` only when fully accomplished. Never mark a task `done` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.
- On a blocker, keep the blocked task `in_progress` or add a new pending task describing what must be resolved.
