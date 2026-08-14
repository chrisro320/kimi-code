---
"@moonshot-ai/kimi-code": patch
---

Cap the transcript's shell-command preview by rendered rows instead of newlines, and append the expand hint when rows are hidden. A one-line `a && b && c` command counted as a single logical line, so it wrapped to several rows and escaped the cap entirely, with no indication anything was truncated. Command and tool-result previews now collapse to a single row; Write content and Edit diffs keep a wider cap of their own, since every row of a diff carries information a `cd` prefix does not.
