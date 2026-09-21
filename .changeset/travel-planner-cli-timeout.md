---
'@skillre/dsh-plugin-travel-planner': patch
---

Every AMap CLI call cost the full command timeout, which is what made a photo
look like it never loaded; the detail is a floating window again.

- **The CLI latency bug.** `createSubprocessExec` built its timeout budget and
  then awaited it in a `finally` block, so a call that finished in milliseconds
  still returned only when the timer fired — 45 s by default. Every uncached
  lookup paid it once per CLI invocation: a single `searchPOI` (the photo
  lookup a detail card triggers) took ~90 s because `ensureReady` is one
  invocation and the search is another, and a twelve-place backfill took about
  eighteen minutes. The budget is now a ceiling: the call returns as soon as the
  child exits, a late timer is a no-op, and a timer that fires first still
  aborts the child and reports `timedOut`. Two regression tests cover both
  halves (`returns as soon as the child exits…`, `leaves a finished call alone
  when its timer finally fires`).
- **The detail window floats again.** Docking it as a column was rejected: it
  took width from the timeline. It is an absolutely placed card over the pane
  again — bottom-anchored full width when the pane is narrow, a side window at
  the bottom right once the pane is wider — still resizable from its inner edge
  with the size remembered, and the timeline keeps its full width in both
  layouts.
