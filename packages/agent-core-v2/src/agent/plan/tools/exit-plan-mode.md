Use this tool when you are in plan mode, have finished writing your plan to the plan file, and are ready for user approval.

## How This Tool Works
- The plan must already be written to the plan file specified in the plan mode reminder.
- This tool does NOT take the plan content as a parameter — it reads the plan from the file.
- The user sees the plan file contents when reviewing. In auto permission mode, the tool reads the file and exits plan mode without asking.

## When to Use
Only for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.

## What a good plan contains
Specific, verifiable steps grounded in the actual codebase — real files, functions, and commands, in a sensible order; each concrete enough to act on and to check. Avoid vague filler like "improve performance" or "add tests" — say what to change and where.

## Multiple Approaches
If your plan offers alternatives, pass them via the `options` parameter so the user can choose which to execute — see the `options` parameter for format, count, and reserved labels. In yolo and manual modes the user sees all options alongside the host's Reject and Revise controls.

## Before Using
- Auto permission mode: do NOT use AskUserQuestion — make the best decision from available context; this tool then exits plan mode without asking. In yolo and manual modes it still presents the plan for approval.
- Non-auto mode with unresolved questions, or multiple approaches not yet narrowed down: use AskUserQuestion first, then write the plan (for the chosen approach only).
- Do NOT use AskUserQuestion to ask "Is this plan OK?" or "Should I proceed?" — that is exactly what this tool does.
- If rejected, revise based on feedback and call ExitPlanMode again.
