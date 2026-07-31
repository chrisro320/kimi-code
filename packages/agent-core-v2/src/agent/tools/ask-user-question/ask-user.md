Use this tool to ask the user questions with structured options during execution: collect preferences or requirements, resolve ambiguous or underspecified instructions, let the user decide between implementation approaches, or present concrete options when multiple valid directions exist.

**When NOT to use:**
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome

Overusing this tool interrupts the user's flow — use it only when the user's input genuinely changes your next action.

**Usage notes:**
- Users always have an "Other" option for custom input — don't create one yourself
- Use multi_select to allow multiple answers to be selected for a question
- Keep option labels concise (1-5 words); use descriptions for trade-offs and details
- Each question gets 2-4 meaningful, distinct options
- Question texts must be unique across the call, and option labels unique within each question
- Ask 1-4 questions at a time; group related questions to minimize interruptions
- If you recommend an option, list it first and append "(Recommended)" to its label
- The result is JSON: an `answers` object keyed by question text; each value is the chosen option's label (comma-separated for multi_select, or the user's own words for "Other"). If `answers` is empty and a `note` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question
