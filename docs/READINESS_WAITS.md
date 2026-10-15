# Asynchronous readiness — 0.13.1

The reported Remix run `47e01b32dfde5bffb243a4d1aa4958f6` dispatched Compile, then waited ten seconds for `role:button|Compile` to become enabled. The current page said `Compiling...`; the later user screenshot showed `Compiled`. The wait therefore measured a missing old accessible name, not a compilation failure. The old default for unspecified waits was also only six seconds. Increasing a sleep alone would not repair a renamed selector.

## Behavior

- Observations prefer test IDs, then element IDs, then role/name targets. This avoids tying an action to a button's changing caption when an ID exists.
- `wait_for` defaults to 60,000 ms and permits 500–120,000 ms. Ordinary `assert` retains a 6,000-ms default and 30,000-ms maximum. Explicit deadlines are honored.
- Polling reads every 250 ms and ends when the condition remains true for at least 300 ms. Successful short jobs return early. There is no unconditional minute-long sleep or global network-idle assumption.
- For an exact role/name target resolved before a click or during a wait, the content script keeps a bounded document-scoped weak node reference. That wait follows the same node even if its caption changes before the first poll. Stable IDs remain selector-based so rerenders can replace the node. Detached handles cannot authorize input or select a vaguely similar control.
- Evidence includes `waitedMs`, `timeoutMs`, `polls`, `missingPolls`, `checkedTarget` and the actual measured value. Scope/run/cancellation checks run on every read; width is unchanged.
- Expiry is `wait_timeout` with `pending: true`, rather than an application assertion failure. In live automation only, a text wait also yields `wait_changed` when its measured text changes and remains different for 500 ms without meeting the condition. This lets the agent inspect a newly completed/error status rather than sit on a guessed status literal until the deadline. The new state is not inferred to be success.
- Live Eino automation preserves the original inconclusive step and may inspect fresh evidence after at most two timeout/status-change handoffs per run. Repeating the same inconclusive condition against unchanged evidence is rejected. A third handoff stops with `needs_review`. Reviewed fixed QA plans continue their original condition polling and stop for review on expiry rather than silently modifying the approved sequence. Final assertions never use the early status-change handoff.
- Only reads are polled. Compile, deploy, submit and transaction actions are never replayed by this recovery path. An enabled button is only readiness: final artifact/status/receipt assertions remain mandatory. Real assertion failures remain failed and take precedence in diagnosis over an earlier readiness timeout.
- Agent S is instructed to return control for condition polling when work is visibly busy. Its handoff does not establish a pass.

## Verification

The actual Chrome/content-script probe waited over 13 seconds while the same button changed from Compile to Compiling to Compiled before the first wait poll; it verified the artifact, one compile request and unchanged width 1111. It also checked a missing target yields a readiness timeout, changed status text returns early as inconclusive, a wrong result remains `assertion_failed`, and cancellation interrupts polling.

Actual Dots 3 acceptance through the built extension, Go native host and Eino controller completed the owned 20-second asynchronous fixture with seven recorded steps and five passing assertions. The readiness tool waited 16,347 ms with its new 60-second default. Independent page checks confirmed a completed job, artifact, exactly one compile request and preserved width. Evidence: `.tools/live-checks/paced-live-run-laLktn/run.json` and `timing-state.json`. Dots handled every model request; no Qwen fallback was needed in this run.

A later actual Dots run (`paced-live-run-JQIBKf`) exposed a guessed status literal: it waited for `Compilation complete` while the page reported `Compilation succeeded`. The 120-second timeout remained recorded and the agent subsequently verified the real outcomes without recompiling. The acceptance wrapper rejected this run because it incorrectly required a *successful* long wait even for the recovery case. That wrapper condition was corrected; the old result was retained. This observation also led to the early `wait_changed` handoff, checked in Chromium and unit tests without interpreting a changed status as a pass.

Final-build actual Dots recovery acceptance (`paced-live-run-moJsLn`, run `07b8388d64259373b2e76400171a2fd1`) passed eight recorded steps and six actual assertions in 107,160 ms. Its short wait expired after 1,007 ms and remains `wait_timeout`/`pending` in the saved run. The controller re-observed and the later assertions verified the completed job, artifact and exactly one request. Independent state measured a 20,003.7-ms job and unchanged width 1422. All model requests used Dots; no Qwen fallback was needed. The model's descriptive label mentioned a longer wait, but the actual ledger contains one short wait followed by assertions; the evidence claim here follows those calls, not the label.

This fixture simulates compiler UI timing. It is not a Solidity compiler or EVM. These changes do not establish that the complete real Remix token/deployment workflow has passed.

Final regressions passed: 57 JavaScript checks, the Go race suite, three Agent S restricted-dispatch checks, and five focused Chrome checks covering credential setup, MFA/readiness/tab isolation, mandatory privacy, IDE controls and repeated current-width execution. The first filtered Chrome attempt omitted its required credential-setup test and stopped with a clarification; including that prerequisite passed all five. The entire browser suite was not rerun.

Reproduce with the built host/extension and a saved OpenRouter key:

```powershell
node tests/fixtures/visual-server.mjs
# In another terminal:
node scripts/test-condition-waits.mjs
node scripts/test-live-run.mjs tests/fixtures/timing-live-request.json --automation-live --fast --eino
node scripts/test-live-run.mjs tests/fixtures/timing-recovery-request.json --automation-live --fast --eino --expect-readiness-recovery
```

The live harness uses isolated browser/data profiles, removes copied encrypted key files on teardown and restores the existing native-host registration. Run native-host harnesses serially. `--fast` only removes this isolated run's between-step inspection gap; it does not shorten readiness deadlines or change saved user settings.
