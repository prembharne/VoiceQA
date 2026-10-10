# Validation status

This document records current evidence, not projected reliability.

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
