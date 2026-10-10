# Validation status

This document records current evidence, not projected reliability.

## Local verification — 2026-10-10

| Check | Result |
|---|---|
| Production JavaScript extension build | Passed |
| Windows Go companion build | Passed |
| Go unit tests with race detector | 26 tests passed |
| Go vet | Passed |
| JavaScript unit/contract tests | 13 tests passed |
| Actual extension + native-host browser integration | 10 tests passed, approximately 1 minute |
| npm dependency audit | 0 vulnerabilities reported |

Browser integration used Chrome for Testing 156.0.8078.4 in an isolated Chromium profile. It verified healthy desktop/mobile-width workflows, seeded cart and coupon failures, serious accessibility violations, overflow, visual-baseline approval/replay, debugger cleanup after cancellation, explicit missing-key errors, and cancellation while paused. The latter checks that returning to a tab cannot revive old asynchronous browser actions.

The application uses a generation fence for cancelled work, serial browser dispatch, compact DOM observations, bounded evidence transfers, and summary-only history listings. Complete evidence remains available in local report exports. The native host stores provider usage without confusing nested API usage details with numeric counters.

The side panel was also visually inspected from a real browser capture. Native test registration was removed/restored at teardown; ordinary Chrome settings were not changed.

API text-to-speech is implemented with a dedicated encrypted key slot, explicit main-key reuse, saved provider/model/voice controls, browser playback, temporary audio transfer/release, bounded text chunks, and cancellation. Tests verify the provider HTTP request against a mock service, Windows DPAPI encryption and key redaction, migration from old settings, late-playback suppression, and the Chrome settings UI. Real OpenAI-generated audio has not been tested without credentials.

- Production extension and Windows Go companion build locally.
- Go tests cover native framing, limits, independent assertions, origin boundaries, interrupted-run recovery, cancellation, checksummed transfers, visual comparison, and provider-response parsing.
- JavaScript contract tests cover schema validation, allowlisted commands, and exact origin checks.
- The browser suite uses actual Chromium, the production extension, Chrome Native Messaging, and the real Go executable. It runs deterministic fixtures, deliberately injected defects, visual-baseline approval, and panel rendering.
- Live model calls and real microphone-to-transcription journeys require an API key and user microphone consent. They are not established by fixture or mocked provider tests.
- The proposed 27/30 real-model completion target and zero false passes across ten injected defects are evaluation goals, not current benchmark claims.

After each release, record test commands, counts, browser version, dates, and live-model results here. Never treat an agent completion message as a pass.
