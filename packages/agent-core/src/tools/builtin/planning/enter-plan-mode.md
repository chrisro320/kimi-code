Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off via ExitPlanMode before writing code prevents wasted effort.

Use it when ANY of these conditions apply:

1. New Feature Implementation - e.g. "Add a caching layer to the API"
2. Multiple Valid Approaches - e.g. "Optimize database queries" (indexing vs rewrite vs caching)
3. Code Modifications - e.g. "Refactor auth module to support OAuth"
4. Architectural Decisions - e.g. "Add WebSocket support"
5. Multi-File Changes - more than 2-3 files
6. Unclear Requirements - need exploration to understand scope
7. User Preferences Matter - user input would materially change the implementation approach

Permission mode notes:
- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.
- Use it only when planning itself adds value (see ExitPlanMode's description for the full approval-flow-by-mode rules).

When NOT to use:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- User gave very specific, detailed instructions
- Pure research/exploration tasks

Once in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → `ExitPlanMode`) and enforces read-only access. For non-trivial tasks with unclear codebase structure or code paths, use `Agent(subagent_type="explore")` to investigate first when the `Agent` tool is available.
