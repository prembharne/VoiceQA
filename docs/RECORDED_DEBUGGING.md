# Evidence-backed recorded-run debugging

VoiceQA 0.10.0 adds **Investigate with AI** to completed run records. The selected model can read the specific historical run, inspect the currently shared page and produce an evidence-linked assessment. Investigation never reruns submissions or rewrites the recorded verdict.

## Scope and evidence

The button sends `agent.query` with the selected `runId`. Go checks that the run is terminal, its primary origin matches the shared website, and every recorded page origin is currently approved. A run cannot expand investigation scope. The UI attaches the recorded run for subsequent Ask questions; **Detach recorded run** or New chat removes that context.

The model gets a bounded `read_run` tool with `query`:

- `summary`: request, timeline references, observation previews and recorded error.
- `failures`: at most eight compact failure verdicts.
- `steps:OFFSET`: paginated timeline references, twenty per page.
- `step:ID`: the specific action, measured verdict and sanitized diagnostic/network metadata.
- `observation:ID`: an earlier retained page snapshot.

Only IDs from that selected run can be read. Filled values, HTTP bodies, credential values and screenshot artifact contents are excluded. URL-carried credentials/query/fragment values are removed. Event metadata uses a whitelist. Large histories remain selectively accessible instead of losing their index to the evidence limit.

## Assessment contract

Answers cite available historical evidence and separate **recorded facts**, **hypotheses** and **next checks**. Categories are application behavior, expectation, target/evidence, transport, scope/session or unknown, with observed/hypothesis/insufficient-evidence confidence. A blocked selector decision after successful actions cannot support an application-defect classification; one local correction is allowed before returning an unsupported assessment error. These guards do not prove every model statement is correct, and browser records cannot establish an implementation-level server root cause.

Timeout/cancellation messages distinguish investigations and live tool decisions from QA planning. A live decision timeout retains completed actions and explicitly reports that the unfinished response was not executed.

## Actual model acceptance — 14 October 2026

The selected model was `nvidia/nemotron-3-super-120b-a12b:free`, using isolated copied credentials/settings and actual chat/history/button interactions.

- Recorded incorrect-price run: correctly identified the independently expected **$410** and observed **$435** as an application-behavior discrepancy. Evidence: `.tools/live-checks/paced-live-run-d05ekV/debug-answer.json`.
- Recorded blocked-target run: correctly identified **target_or_evidence**, with observed confidence, after a local classification correction. Two `read_run` calls and one local validation feedback item were recorded. Evidence: `.tools/live-checks/paced-live-run-HY30KT/debug-answer.json` and its UI screenshot.
- Both checks preserved the current page text and the historical verdict, and produced no runtime errors or spoken announcements.

The earlier `.tools/live-checks/paced-live-run-G6pUgf/` attempt incorrectly classified the blocked selector as application behavior. That failed acceptance result drove the classification guard. A separate harness wait initially ignored clarification/error replies and later mistook the historical error for a new investigation error; response/error detection now handles those paths explicitly. Those attempts are not counted as passes.

Reproduce against an owned port-4178 seed and an actual saved run with `node scripts/test-live-run.mjs SEED.json --debug-run=RUN.json --expect-category=target_or_evidence`. The harness invokes the UI, checks actual model usage, evidence references, classification and unchanged state. It makes no static substitute for the model answer.
