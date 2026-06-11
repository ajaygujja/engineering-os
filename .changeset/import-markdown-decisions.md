---
"engineering-os": minor
---

Import architecture decisions from Markdown docs. `eos init` now parses ADRs from `docs/`, `adr/`, and `decisions/` folders (both inline `**Decision**` sections and Nygard-style `## Decision` files) into the decision store, so `eos_recall_decision` can answer "why did we choose X?". Decision search is now token-based and ranked, so natural-language queries match (not just exact substrings), and `eos_recall_decision` now surfaces a decision's trade-offs/consequences.
