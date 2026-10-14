# Browser automation workspace

VoiceQA 0.10.0 separates **QA & debugging** from **Browser automation**. Both can use Ask & investigate. QA retains reviewed test suites, assertions, accessibility/security checks and reports. Browser automation starts from the actual request and permissions: **no initial AI planning call, action sequence or generated checklist**. After approval it uses tools directly from current page state and the latest request/context.

## Mission and execution

1. The compatibility RPC `automation.propose` now creates a **local request/permission record**, reading the viewport but making no AI call. It stores the literal request, bounded conversation, selected model, approved origins, permissions and action budget. `cases` and initial `criteria` are empty; `automation.live` is true and preparation usage is zero.
2. The operator reviews the request and permissions and chooses **Start live automation**. Exact-version confirmation protects that scope, rather than approving a predicted action plan. The first AI execution call chooses one tool against the current page.
3. Each turn collects fresh public DOM evidence. A sanitized state ledger retains earlier page rules/results alongside recent actions (12 snapshots/96 KiB maximum; omission is explicit). This ledger is saved with the run and sent to the model so vanished pricing/rules are not lost. The model returns one typed action, a blocked explanation or completion checks. Shared action validation checks scope, aliases, operation types, value formats and credential references. Controls are resolved before mutations; missing later-stage fields receive a corrective decision before dispatch. Persistence failure stops execution.
4. The existing Chrome executor performs the action and records its result. No ambiguous dispatched action is retried. An unchanged-state action fingerprint ignores superficial label/timeout changes and prevents identical mutation replay. Checkbox/selection/focus state is included in observations.
5. Once outcomes are reached, the live agent proposes outcome assertions describing which request requirements they verify. A separate late coverage review compares these with the original request, conversational context and recorded evidence; it does not plan or dispatch actions. Missing coverage or unsupported expectations receive feedback before completion. The local engine executes the assertions and captures evidence, including checks that correctly fail against wrong application results. Model prose cannot mark the run passed. Older saved missions retain their original criterion-based completion contract.

The current browser width is preserved. Progress shows the action budget and observation/decision phases. Stop cancels model calls and gaps. Only actor-created tabs are cleaned up. Captured public variables and existing origin-bound username/password/TOTP references remain available; human checkpoints handle operator challenges.

## Permissions and limits

Ordinary scoped interactions are allowed by mission review. Consequential actions require the separate explicit checkbox in Workspace options. The Chrome guard uses actual activating control/form metadata, including nested icons and encoded action routes, for sending, publishing, payment, transfer and deletion indicators. Enter and Space both undergo the check; the model's action label cannot disguise a dangerous button. Financial form fields are masked. API writes require their separate existing flag; DELETE/action routes also require consequential permission. These indicators do not prove detection of every possible website side effect, so adversarial broad-site coverage remains open in the goal audit.

Live requests use one viewport, one dataset-independent goal and 1-120 actions (60 by default). Final completion supplies 1-20 outcome assertions after tools execute. The run deadline is 20 minutes. Upload/download and additional widget primitives remain future goal work. QA-only planning/data/resize options are hidden in automation. No arbitrary JavaScript, shell or OS tool is available.

## Actual AI verification - 13 October 2026

The owned TravelForge wizard on port 4178 renders only one stage at a time. It contains no VoiceQA fixture marker or hidden planning contract. Destination, traveller-count and review controls do not exist when the mission is proposed.

- Real `nvidia/nemotron-3-super-120b-a12b:free` adaptive execution passed **13 steps and 6 checks** after filling the traveller, navigating newly observed stages, calculating the visible $200-per-traveller + $10 fee, and submitting one reservation. The final result showed QA Traveller, Tokyo, two travellers and **$410.00**. Evidence: `.tools/live-checks/paced-live-run-ZiUfhc/run.json`.
- Actual workspace switch, chat mission submission, review and approval through the UI passed **12 steps and 5 checks**. Evidence: `.tools/live-checks/paced-live-run-cZQS03/run.json`; `mission-review.png` in that folder records the reviewed criteria/permissions.
- Ordinary Next, Send message, Delete account and a financial Continue were classified from real browser DOM metadata. Evidence: `.tools/live-checks/automation-consequence-browser.json`. This probe supplements policy tests; it is not a production payment/deletion run.
- Existing QA regression passed **27 steps and 4 checks**; real Ask chat and linked-page/field-inspection calls also passed after the mode split. Evidence: `.tools/live-checks/paced-live-run-nda5uB/`.

Earlier real attempts exposed imperative success criteria, premature later-stage input, result-selector mismatches and mixed-number verification. These failures were retained as findings and drove general validation/grounding changes. They are not counted as successful runs. The full advanced-browser goal remains active.

### Defect detection and evidence retention - 14 October 2026

An operator-selected `--incorrect-total` fixture leaves visible pricing/review at $410 but changes only the final receipt to $435. The user request supplies destination/count, not the expected amount.

- The first real run falsely passed by using the final $435 receipt as its own expectation. Earlier page observations had not been supplied to later stateless model requests. This is a failed acceptance result, retained at `.tools/live-checks/paced-live-run-Z5zllu/run.json`.
- After adding sanitized observed-state memory, the real model derived **$410.00** from earlier rules and correctly failed against the **$435.00** receipt after exactly one submission. The harness passed its negative acceptance gate: 11 actions recorded, 3 checks passed and 1 pricing check failed. Evidence: `.tools/live-checks/paced-live-run-7Gr3kK/run.json`, including 8 retained observations. No action was replayed to hide the discrepancy.
- Eight supplementary real-DOM classifications covered ordinary Next, sending, deletion, financial controls, nested button icons, encoded action paths, form action routes and keyboard focus. `node scripts/check-automation-controls.mjs` reproduces the probe while the owned wizard is running.
- A fresh healthy journey with **Mira Patel, Osaka and three travellers** passed **13 steps/6 checks**, independently expecting **$460.00** and observing exactly one reservation. Actual pointer approval succeeded; changing permissions before approval was first rejected without starting a run. Automation controls fit at 360px/420px, with no runtime errors or spoken announcements. Evidence: `.tools/live-checks/paced-live-run-CfeS5a/`. An earlier healthy attempt blocked on an unnamed `role:alert|` absence locator and an added viewport criterion; safe read-only role-set compilation and policy-criterion rejection addressed those findings.

Negative replay: start `node tests/fixtures/automation-wizard.mjs --incorrect-total`, then run an owned port-4178 seed through `scripts/test-live-run.mjs SEED.json --automation-ui --expect-total-defect --fast`. The defect gate independently checks the expected $410 assertion, actual $435 receipt and exactly one submission. `--fast` disables inspection gaps only in this isolated diagnostic profile.

### Direct live tools — 0.10.0 acceptance

- Fresh actual UI submission/approval produced a local record with `automation.live: true`, empty cases/criteria and zero preparation usage. The live model completed Osaka/three travellers in **9 steps/2 checks**, verifying the full $460 receipt and exactly one submission. Permission changes were rejected before starting. Evidence: `.tools/live-checks/paced-live-run-5oCTak/`.
- The same direct-tool flow caught the wrong Tokyo receipt after **9 steps**: expected **$410**, observed **$435**, exactly one submission. One prior check passed and the pricing assertion failed; the late coverage review allowed the correct defect-detecting expectation to execute. Evidence: `.tools/live-checks/paced-live-run-OUUxk9/run.json`.

These are real selected-model/tool/browser checks. They do not establish universal website support or universally correct coverage judgments.
