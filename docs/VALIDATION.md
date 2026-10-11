# Validation status

This document records current evidence, not projected reliability.

## RelayDesk compatibility workspace — 2026-10-11

Version 0.4.1 replaces the default Fieldnotes page with RelayDesk. The old shop is archived at `/fixtures/shop` for regression evidence. Four suites separate desktop application workflows, responsive/accessibility coverage, authentication/operator checkpoints and logical security. The workspace uses real bounded server requests, cookie sessions, named anti-CSRF references, owner/role checks, trusted prices and payload-bound idempotency. Unknown API clients cannot mint sessions. The UI has SPA navigation, an async/paginated/filtered table, modal focus restoration, a validated wizard, delayed order confirmation, protected invoices and server-persisted preferences. Dashboard trends/projects/activity are disclosed samples.

- The 50-action application fixture passed **57 recorded steps and 17 independent UI/API checks**. Two input rows (1/135 and 3/375) passed complete isolated workflows with distinct actual order IDs. Responsive checks ran at 1440×900 and 390×844. Actual TOTP sign-in and a server-completed synthetic operator challenge passed; confidential profile values were absent from the public run. The security fixture includes analyst denial and manager positive control, and detects all five injected ownership/role/CSRF/price/duplicate defects.
- The first live model requests exceeded their deadlines; no browser actions were executed. Rather than switching models, the planner now receives a compact business/control contract instead of the entire 50-action prerecorded script. A subsequent request using the same saved OpenRouter `dots-studio/dots-3-note-preview:free` returned a valid single case: **2,743 input + 5,852 output = 8,595 tokens**. The exact accepted plan passed **22 recorded steps, 5/5 UI/API checks**, minimum measured gap **4,004 ms**, through the real extension/native host and an owned invoice tab. Execution used no model keys or additional calls. Artifacts: `.tools/live-checks/live-plan-BBryWL/accepted-plan.json` and `.tools/live-checks/paced-live-run-5zbsoO/run.json`. Drafting key copies were removed and native registration restored.
- Punctuation-only model labels are now normalized locally to useful operator descriptions without changing action targets, values or expectations. The opt-in observation helper uses trusted local instrumentation without weakening the application's CSP. Live artifacts are separated from Playwright's cleanup directory. Regression waits now await terminal UI results, not a potentially pre-start null run ID. Stale search tests hold the first real response until the newer result is visible.
- **41 JavaScript checks**, Go race tests/vet and the dependency scan pass (zero npm findings; no Go vulnerabilities). The full 46-case browser suite passed (3.8 minutes); the added early-bootstrap navigation regression also passed on a fresh server. There are now 48 browser cases; the final 15 RelayDesk tests pass on a fresh server, including the early-bootstrap and confirmation-failure regressions. CodeRabbit reviewed the actual source; six concrete findings and one defensive guard were addressed: stale-test coverage, normalized replay URLs, early authentication navigation and session minting by unknown API callers; order-status polling also stops if its target element disappears. Existing submission keys replay successfully even at the sandbox capacity limit, and confirmation errors are distinguished from submission failure. Concrete defects have targeted regression checks. The runtime package includes the full demo source and a standalone Node launch script.

Coverage and reproducible requests: [RelayDesk compatibility lab](COMPATIBILITY_LAB.md). Voice transcription/playback, production CAPTCHA, real external SSO/SMS/passkeys, native file dialogs, cross-origin embedded applications and canvas-only controls are not established by these fixtures.

## Workflow and logical security upgrade — 2026-10-11

Version 0.4 adds public data rows, capture-to-API workflows, named private bearer/CSRF references, scoped write authorization, typed JSON expectations, security indicators, bounded network evidence, failure triage, Markdown bug reports, plan reuse and run comparison. Private and visual-only masks are separate. Go 1.27.2 is pinned because the initial dependency scan identified reachable standard-library advisories in the older toolchain.

- Production extension and Windows Go companion build as **0.4.0**. **34 JavaScript checks**, the full **33 actual Chromium/native-host browser tests**, **Go race tests and vet** pass. The browser suite took about 2.7 minutes. It preserves prior cart, multi-tab/TOTP/checkpoint, pacing, UI, reconnect and visual-baseline regressions.
- The data workflow captures actual random order IDs and uses them in server queries across quantity/total rows 1/12 and 3/36. The healthy security suite verifies twelve API outcomes, including positive cookie/bearer controls and named private anti-CSRF references. All five injected server defects (ownership, price, role, CSRF and idempotency) fail the corresponding check. Recorded evidence omits actual bearer/CSRF values. The new real iframe fixture cannot replace top-level security-header evidence.
- **Live model planning and execution verified:** the saved OpenRouter `dots-studio/dots-3-note-preview:free` model produced a valid six-case security plan using real DOM observations and the trusted synthetic lab contracts. Usage: 4,288 input + 6,695 output = 10,983 tokens. The existing 6,000-token generation limit had returned incomplete output; planning now has a bounded 16,000-token budget and explicit limit diagnostics, with no automatic retry of incomplete output or silent model switch.
- The exact accepted plan ran with four-second pacing through the real extension/host: **42 recorded steps, 20/20 UI/API checks passed, overall passed**, duration 168,165 ms, minimum measured gap **4,006 ms**. Execution used no model keys or additional model calls. Browser evidence identifies HeadlessChrome/156.0.0.0. Public plan/run/screenshots were preserved at `.tools/verification/0.4/live-security/`; encrypted drafting copies were deleted and native registration restored. Fixture/browser artifacts remain under `test-results/native-integration/` and are ignored.
- `npm run security:check` reports **zero npm advisories and no Go vulnerabilities** using the patched Go 1.27.2 toolchain. This is an advisory/reachability scan, not proof that the application has no vulnerabilities.
- **Actual CodeRabbit CLI review completed twice.** The first covered 49 changed files and found three valid issues: duplicate-label comparison, iframe header attribution and compacted progress/voice counts. All three were fixed with regression checks. The second covered 51 changed files and returned zero findings. Reports remain in ignored `.tools/coderabbit-review-first.ndjson` and `.tools/coderabbit-review.ndjson`. Exit success alone is insufficient; the adapter also requires an explicit completed review with reviewed files. No paid-credit flag or narrowed scope was used. GitHub-app installation/automatic PR review is separate and is not claimed.

These results establish the stated local workflows and fault controls. Third-party SSO, production SMS/passkeys/CAPTCHA, microphone transcription and paid speech were not independently exercised in this release. Production CAPTCHA requires operator completion or official test keys in an owned staging application. Hosted SaaS accounts/billing are still roadmap work. No test or reviewer result establishes universal reliability, complete penetration coverage or perfection.

## Advanced browser workflows — 2026-10-11

- Version 0.3 adds a five-page registry, explicitly shared origin scopes, run-created tab cleanup, saved test credentials, local TOTP, readiness waits and operator checkpoints. Actual tab switches restore the selected screen width. New-tab navigation waits for a committed approved document; redirects are accepted only within explicitly approved origins.
- The production extension and Windows Go companion build. **25 JavaScript tests** pass, covering tab ownership, origin rejection, generation fences, cancellation during tab creation/loading and responsive-width restoration. **Go race tests and vet** pass, including encrypted profile storage, secret-free public/model metadata, cross-origin credential rejection, bounded scopes, baseline separation and all 18 published RFC 6238 vectors across SHA-1/SHA-256/SHA-512.
- **23 actual Chromium/native-host tests** pass. The advanced deterministic fixture performs server-checked TOTP login, creates/switches/closes a real child tab, verifies independent counters, waits for delayed content and resumes after an operator-completed synthetic CAPTCHA. All six functional assertions pass. Recorded plans and runs omit test credential values; screenshots retain the configured 1440-pixel width after scope/tab switches.
- Regression tests verify that unsharing does not close user tabs, Stop invalidates a checkpoint, a late acknowledgment cannot resume a cancelled run, and acknowledging an uncompleted challenge still produces a failed application assertion. Mandatory password/one-time-code redaction survives an empty custom mask. The existing cart, injected-defect, visual baseline, pacing, UI and reconnect tests remain green.
- The browser test host/data are isolated; the advanced test server uses port 4174. Local artifacts include `test-results/native-integration/advanced-run.json`, `auth-settings.png`, `shared-pages.png` and `human-checkpoint.png`, plus existing chat and connection captures. These files are ignored artifacts and regenerated by the suite. Native test registration is restored afterward.
- Advanced planning is tested with mocked structured provider responses, including a case on a second approved origin and profile-reference actions. No live model call, third-party SSO, real SMS/passkey journey or production CAPTCHA was tested in this upgrade. Production CAPTCHA requires operator completion; provider test keys are configured in your staging application. The lab's CAPTCHA is explicitly synthetic.

Setup, reproducible credentials and boundaries are documented in [advanced testing](ADVANCED_TESTING.md). These results establish the stated fixture behavior, not universal browser automation reliability.

## Conversational UI — 2026-10-10

- Replaced the dashboard landing/tabs with a compact chat workspace, top-right settings gear, fixed composer, selected-tab sharing chip, voice controls and a **+** test-options menu. Plans and run outcomes appear inline. All provider, model, main/speech/TTS key fields remain in Settings.
- The production extension build and **18 JavaScript tests** pass. **17 actual Chromium/native-host tests** pass, including sharing/unsharing, blocking unshare during a run, three-second pacing/cancellation, offline recovery, API/TTS controls, and the new UI-driven fixture-plan → confirm → real browser run → results/export-controls flow. Model calls are not made by that fixture UI test.
- Inspected captures at 330, 420 and 600 pixels. The chat composer fits without horizontal overflow, plan cards render immediately, and long title/model strings truncate within their controls. Serious/critical axe checks passed on the history screen; reduced-motion checks passed. This is scoped UI verification, not a claim of complete accessibility conformance.
- Local captures: `test-results/native-integration/side-panel.png`, `panel-330.png`, `panel-600.png`, `chat-plan.png`, `chat-results.png`, `openrouter-settings.png`, `step-countdown.png`, and `connection-recovery.png`. These files are ignored artifacts.
- The commercial architecture in `docs/MICRO_SAAS.md` is a proposal. No hosted accounts, billing, cloud collaboration or deployment were added by this interface change.

## Step-by-step runs — 2026-10-10

The user's failed demo run was inspected from the production SQLite records without changing them. Its generated cases checked totals/coupon messages before the clicks/fills, with reset navigation last. This was an invalid action order, rather than evidence that the demo's healthy cart/coupon implementation was broken. Local validation now requires navigation as the first step of each case; the planner receives explicit action-before-check examples and instructions to let the runner repeat cases across viewports.

- Runs snapshot a configurable 3–5-second inspection gap (4 seconds by default). A single cancellable pacing function covers website actions, layout changes and accessibility checks. Results stream queued/current steps with a countdown, context and progress. Existing settings without a saved pace inherit 4 seconds; regression automation can explicitly use 0.
- Go race tests and vet pass. New tests verify reversed-plan rejection, pace defaults/bounds and cancellation without dispatching the queued action. All 18 JavaScript tests and **16 Chromium/native-host browser tests** pass. The new browser test measures real 3-second spacing, observes the first mug at quantity 1, verifies the countdown, and cancels before the second mug is added within 2.5 seconds.
- **Live model and execution verified:** the saved OpenRouter model `dots-studio/dots-3-note-preview:free` regenerated the user's complete two-workflow request. The accepted plan reset each case first, checked $12 after one mug and $24 after two, then tested INVALID coupon rejection and an unchanged $12 cart. An isolated production-extension/native-host session executed that exact plan at 1440×900 and 390×844 with four-second gaps: **28 recorded steps, 8/8 assertions passed, overall passed**, and a minimum measured gap of **4,003 ms**.
- Evidence: `test-results/live-plan-oY1XfH/accepted-plan.json` and `test-results/paced-live-run-ue2CuE/run.json`, with `paced-run.png` and `results.png`. The automated cancellation screenshot is `test-results/native-integration/step-countdown.png`. These are ignored local test artifacts. Credentials were copied only for the isolated drafting check and removed at teardown; the execution check used no API keys or further model calls. Production browser registration/data were preserved.

This is a verified result for the stated demo workflow, model and viewport widths. It does not establish general QA reliability across websites or real microphone/TTS behavior.

## OpenRouter support — 2026-10-10

The companion now routes OpenRouter planning and target resolution through its Responses endpoint with strict schemas and parameter-compatible provider routing. Mock HTTP tests verify endpoint selection, request shape, response parsing, token usage, and that OpenRouter credentials cannot reach OpenAI. Windows tests verify legacy-key recovery, encrypted provider-specific key storage, blank-key preservation, and separation from speech keys. Go race tests and vet pass.

### Generated-plan validation regression

- Fixed the schema gap that allowed prose or empty strings as boolean expectations. Boolean assertion schemas now require literal `true`/`false` strings. Local validation remains strict and identifies the failing case/step. Numeric count expectations must be nonnegative integer strings.
- The model chooses a nested plan-or-clarification result. Clarification drafts contain no runnable actions. A rejected draft gets at most one correction request, preserving the selected model, original request, origin, observation and a shared 100-second deadline. Authentication, transport, refusal, incomplete responses and cancelled work are not retried. Token usage from both attempts is retained.
- Verified rejection-to-repair, exhausted repair, cancellation, authentication, clarification handling and removal of unused assertion metadata with mocked HTTP regression tests and Go's race detector. All 18 JavaScript unit tests and 15 Chromium/native-host integration tests passed.
- **Live planning verified:** `scripts/test-live-plan.mjs` used the saved OpenRouter credential and selected `dots-studio/dots-3-note-preview:free` model, with a real Chromium DOM observation of the local demo. The coupon/cart request returned two valid independent cases and two checks, targeting a $24 total for two $12 mugs and the exact `Coupon is not valid` message. Provider usage was 1,675 input + 2,643 output = 4,318 tokens. The accepted draft was unconfirmed; no test actions were executed in this smoke check.
- The live check used isolated app data, preserved the production SQLite records and registration, and removed copied encrypted keys at teardown. Its ignored evidence is `test-results/live-plan-T2fzqo/accepted-plan.json`. Earlier live attempts exposed the clarification-field ambiguity before the response schema was corrected; they are not counted as successful planning.

This establishes live plan generation for that request and model. It does not establish general reliability across sites, live microphone transcription, paid TTS, or model-driven test execution. Nested union schemas follow the [official Structured Outputs schema subset](https://developers.openai.com/api/docs/guides/structured-outputs).

## Local verification — 2026-10-10

| Check | Result |
|---|---|
| Production JavaScript extension build | Passed |
| Windows Go companion build | Passed |
| Go unit tests with race detector | 26 tests passed |
| Go vet | Passed |
| JavaScript unit/contract tests | 18 tests passed |
| Actual extension + native-host browser integration | 13 tests passed, approximately 1 minute |
| npm dependency audit | 0 vulnerabilities reported |

Browser integration used Chrome for Testing 156.0.8078.4 in an isolated Chromium profile. It verified healthy desktop/mobile-width workflows, seeded cart and coupon failures, serious accessibility violations, overflow, visual-baseline approval/replay, debugger cleanup after cancellation, explicit missing-key errors, and cancellation while paused. The latter checks that returning to a tab cannot revive old asynchronous browser actions.

The application uses a generation fence for cancelled work, serial browser dispatch, compact DOM observations, bounded evidence transfers, and summary-only history listings. Complete evidence remains available in local report exports. The native host stores provider usage without confusing nested API usage details with numeric counters.

The side panel was also visually inspected from a real browser capture. Native test registration was removed/restored at teardown; ordinary Chrome settings were not changed.

API text-to-speech is implemented with a dedicated encrypted key slot, explicit main-key reuse, saved provider/model/voice controls, browser playback, temporary audio transfer/release, bounded text chunks, and cancellation. Tests verify the provider HTTP request against a mock service, Windows DPAPI encryption and key redaction, migration from old settings, late-playback suppression, and the Chrome settings UI. Real OpenAI-generated audio has not been tested without credentials.

## Version 0.2 — connection recovery and interface polish

- Reproduced a disconnected panel port and recovered through **Retry connection** without reopening the panel. Unit tests also cover synchronous stale-port failures, old-generation disconnect events, and rejection without replay of mutating requests.
- Verified the actual `dist/extension` with the currently registered production host and its real extension ID through `scripts/smoke-installed.mjs`; registration was not replaced by that smoke check. `scripts/check-host.ps1` independently verified registration and executable startup with isolated temporary data.
- Repaired Windows registration for both Chrome and Chromium, preserving the existing application data and API keys.
- Visually inspected connection recovery, empty history, and 330/600-pixel side panels. Motion, Lucide, and locally bundled Inter provide the interface; reduced-motion preferences are respected. Automated serious/critical accessibility checks passed for the history view.
- Added a browser-speech startup watchdog and cancellation cleanup so unavailable speech cannot leave the UI indefinitely in its speaking state.

Total locally verified test cases: **57** (26 Go, 18 JavaScript, 13 browser). Go race/vet and npm audit passed. Live model-generated QA and paid TTS still require credentials for independent acceptance testing.

- Production extension and Windows Go companion build locally.
- Go tests cover native framing, limits, independent assertions, origin boundaries, interrupted-run recovery, cancellation, checksummed transfers, visual comparison, and provider-response parsing.
- JavaScript contract tests cover schema validation, allowlisted commands, and exact origin checks.
- The browser suite uses actual Chromium, the production extension, Chrome Native Messaging, and the real Go executable. It runs deterministic fixtures, deliberately injected defects, visual-baseline approval, and panel rendering.
- Live model calls and real microphone-to-transcription journeys require an API key and user microphone consent. They are not established by fixture or mocked provider tests.
- The proposed 27/30 real-model completion target and zero false passes across ten injected defects are evaluation goals, not current benchmark claims.

After each release, record test commands, counts, browser version, dates, and live-model results here. Never treat an agent completion message as a pass.
