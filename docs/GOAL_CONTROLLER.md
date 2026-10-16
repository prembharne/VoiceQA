# Goal-driven recovery — 0.14.0

A live automation request remains the goal throughout the run. The Eino controller repeatedly observes the current page, asks for one grounded action, executes it, records its outcome, and uses fresh evidence for the next decision. There is no precomputed click script in live mode. Dots 3 remains primary; Agent S3 with the authorized Qwen 3.7 Flash model handles visual subtasks, and Qwen is the authorized Dots availability fallback.

## What changes

- A rejected DOM proposal, invalid Agent S response, unsupported visual intent or stale visual target returns correction feedback to the goal loop before input. It no longer ends the run after three proposal corrections. A failed visual worker is closed; the controller returns to DOM observation before considering another visual handoff.
- A cropped screenshot disables the visual lane for that run and returns to DOM tools, without changing browser width or pretending the screenshot is usable. Scope/cancellation errors remain terminal. Unsupported selector prefixes receive immediate actionable feedback instead of spending a control lookup deadline.
- Agent S asks Qwen for a single typed JSON method/arguments envelope. A restricted adapter frames that envelope for upstream Agent S. The existing AST dispatcher still validates literal arguments and its browser-only method allowlist; generated Python is never evaluated or executed.
- A repeated click is eligible only when current browser evidence identifies non-submitting UI navigation, such as a tab, tree item or popup opener. Each unchanged action/state permits at most two additional attempts. Form submissions, opaque canvas clicks and consequential controls do not qualify. Rejection supplies feedback so the agent can inspect results or choose another route.
- Browser errors distinguish confirmed `not_dispatched` input from `uncertain` input. Confirmed non-dispatch can be retried within the same bounds. The dispatch marker is set **before** sending input, so a lost acknowledgment does not permit replay. Submission identities are committed when input may actually dispatch, rather than during preflight alone.
- Readiness expiry/status change is inconclusive evidence, retained with its measured result. The controller may inspect and continue without replaying the job trigger. It cannot repeat the same inconclusive wait against unchanged evidence.
- Actual failed assertions remain recorded failures. The agent can inspect them and continue remaining work; neither retries nor later successful checks erase them. A completed set of checks with any failed assertion has overall status `failed`. Historical regression witnesses are recorded once so they do not trap the agent in a verification loop.
- Exact requested text/source must be copied without reformatting. For a unique literal following an explicit exact-content directive in the trusted request, the controller restores whitespace-only model formatting before input. It does not rewrite generated content or resolve ambiguous passages. A reformatted expectation is rejected; observed output cannot become its own oracle. Editable INPUT/TEXTAREA checks require `value`, rather than checking their empty displayed text, so an invalid assertion source is rejected before it can become a misleading application failure.
- An agent-reported blocker receives two opportunities to inspect or use another approach before becoming final. Required scope, credential and cancellation boundaries still apply immediately.

Each recovery records its source, reason, original goal, attempt and remaining recovery budget in the run's agent events. Recovery feedback is not presented as a browser read. Actual observations and tool reads retain their separate evidence ledgers. The model receives the goal, recent actions, earlier observed outcomes, read results, latest correction and recorded-failure state on every decision.

## Limits and completion

The reviewed action budget remains 1–120, default 60, with the existing 20-minute run deadline. The shared recovery budget is `max(8, min(24, maxActions))`. Visual decisions use the reviewed action budget instead of a separate hard stop at 16; six-turn visual bursts return to DOM. Browser read calls retain their existing separate budget. These bounds prevent an unavailable model or unchanged interface from looping indefinitely or spending without limit.

Goal completion requires local outcome assertions and the existing late coverage review. Agent S `done`, dispatched input, a transaction submission and a model's narrative are not proof of success. A real application defect may prevent a successful goal; the run must report it rather than alter expectations or application data to manufacture success. Cancellation, unavailable credentials/permissions, uncertain consequential input and exhausted budgets can still end a run with a clear partial record.

Reviewed fixed QA plans retain their approved sequence and expected values. Their missing-target visual grounding can fall back to DOM if visual proposal generation fails before input. They do not become an unreviewed live action sequence. Read-only investigations can continue with DOM tools after visual inspection fails; they gain no write permissions.

## Reproduction

Build the extension and host, install the optional Agent S runtime, and save the OpenRouter key. Run the local fixture server, then the live harness in another terminal:

```powershell
node tests/fixtures/visual-server.mjs
node scripts/test-live-run.mjs tests/fixtures/goal-recovery-live.json --automation-live --fast --eino --visual-agent --goal-recovery
```

The owned fixture deliberately ignores its first New file click when `?cold=1` is set. The actual AI must recover, create `RouterProbe.sol`, enter its source, invoke the fixture build, use the visual-only canvas control and independently verify outcomes. The wrapper checks click counts, exactly one file creation, routing, assertions and unchanged viewport. The fixture's build is a UI simulation, not Solidity compilation or EVM deployment. The harness isolates browser/data profiles, removes encrypted test-key copies and restores native registration. Run native-host harnesses serially.

For the negative control, run `node tests/fixtures/live-read-workspace.mjs --incorrect-status` and then, serially after the preceding harness finishes:

```powershell
node scripts/test-live-run.mjs tests/fixtures/goal-defect-live.json --automation-live --fast --eino --live-reads --expect-status-defect --expect-continued-failure
```

This uses actual AI to discover native field constraints, save once, refresh, detect incorrect persisted status and continue independent checks. The wrapper requires an actual passed assertion after the recorded failed check, with overall status still `failed` and one saved release.

Current execution evidence is recorded in [validation](VALIDATION.md). This release does not claim universal task completion or a verified full Remix ERC-20 deployment journey.
