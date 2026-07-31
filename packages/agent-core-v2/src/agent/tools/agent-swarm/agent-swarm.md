Launch multiple subagents from one prompt template, existing agent resumes, or both.

Use AgentSwarm when many subagents run the same kind of task over different inputs. The placeholder is exactly `{{item}}`: `prompt_template` `Review {{item}} for likely regressions.` with `items` `["src/a.ts", "src/b.ts"]` launches two subagents with those concrete prompts. For a few differently-shaped tasks, make separate `Agent` calls in one message instead.

`resume_agent_ids` continues existing subagents (e.g. failed or timed out): map each agent id to its resume prompt (usually `continue`). You may combine `resume_agent_ids` with `items`; do not duplicate resumed work in `items`.

Enforced — violations are rejected before any subagent starts: at least 2 `items` unless `resume_agent_ids` is passed; `items` requires `prompt_template` containing `{{item}}`; the filled-in prompts must be distinct.

Use enough subagents to keep work focused and parallel — up to 128 subagents, queued automatically; safe to split large tasks into many clear, independent items.

If `AgentSwarm` is called, that call must be the only tool call in the response.
