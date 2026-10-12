# Live AI validation — 2026-10-11 to 2026-10-12

These runs called `dots-studio/dots-3-note-preview:free` through OpenRouter with the locally saved key. The model generated the cases and actions. Accepted plans were executed by the real Chrome extension and Go companion against isolated RelayDesk sessions on port 4176. No preset fixture plan replaced a failed AI draft.

## Verified runs

| Request scope | Cases | Recorded steps | Checks | Result |
| --- | ---: | ---: | ---: | --- |
| Complete journeys, invalid inputs, calculations, submission, invoices, tabs and persistence | 5 | 61 | 11 | Passed; also replayed with a minimum 4.004-second gap |
| Ownership, roles, authoritative prices, CSRF and idempotency with positive controls | 6 | 44 | 15 | Passed |
| Filtering, pagination and settings persistence | 3 | 33 | 10 | Passed |
| Saved credentials, server-verified TOTP and operator CAPTCHA checkpoint | 1 | 12 | 2 | Passed; minimum 4.004-second gap |
| Deliberately broken ownership (`bug=ownership`) | 6 | 30 | 13 | 11 passed; 2 correctly failed: expected 403, received 200 |
| Final full-extension request → Dots workstreams → execution | 6 | 63 | 11 | Passed; fresh planning took 176.6 seconds |

All recorded viewport labels in these runs were `1280x720`. Current-width mode performed no planned resizing. Recorded steps include setup, page scope and accessibility operations; the check count includes explicit assertions and HTTP checks.

The CAPTCHA operator action was supplied by the tester on the synthetic checkbox. The agent's following assertion independently checked completion. This does not demonstrate solving a production CAPTCHA, SMS challenge or passkey.

## Defects found through actual model calls

- Dots put a navigation URL in `target` while the runner reads `value`. An unambiguous navigation-field mismatch is now compiled before normal origin validation; the URL is never changed to another host.
- Advertised structured output did not reliably produce the full action contract. The schema is now visible in the prompt as well, with actual navigation/reference examples and focused fixture requirements.
- Disabling optional reasoning produced faster but unreliable drafts. Provider defaults are restored when there is no advertised reasoning-budget control. Supported budget controls remain bounded; planning output-token caps were not reintroduced.
- Drafts invented profile aliases, literal credentials/OTP values, omitted Submit, moved shipping selection to the items step, or invented bearer storage. Profile references and known fixture stages/session rules are checked before acceptance.
- Missing wait conditions can use the following matching assertion or conventional element visibility, without changing the final independent assertion. Missing DOM controls receive a bounded readiness wait before input dispatch; dispatched mutations are never retried by that wait.
- A full-extension AI plan captured `$240.00` from the page and used it as the expected JSON number. Typed numeric comparisons now normalize a captured, unambiguous currency amount. Dates, mixed text, multiple values, ambiguous formats and nonfinite values remain errors. The unchanged AI plan passed its 55-step, 12-check replay after the fix.
- The requested scope is checked against minimum known-demo coverage, preventing dashboard-only checks from claiming the full journey. Closing an owned tab already returns to main, so an extra switch action is optional.
- Broad bundled-demo requests spanning orders/invoices, invalid inputs and persistence are decomposed into three bounded AI workstreams. Calls share a deadline, retain the original request, and are merged only after validation. A failed workstream cancels the others; partial work is not saved as a runnable plan. The final complete extension-to-model-to-execution path passed 63 steps and 11 checks. Earlier iterations still failed; the live investigation identified missing validation triggers and other workflow errors instead of treating earlier passes as sufficient.
- The live runs also found an invalid-coupon assertion without its validating Next click. Known fixture validation now checks that the error-triggering action actually preceded the assertion.

## Evidence and reproduction

Local records are under `.tools/live-checks/`; the summary is `verified-live-results-2026-10-12.json`. They are intentionally excluded from Git and distributions. Copied API-key files are deleted during teardown, including error paths; production settings and runs are not used as writable test storage.

`scripts/test-live-plan.mjs` generates a real AI draft. `scripts/test-live-run.mjs` replays it through an isolated extension. The latter also accepts `--plan-live` to generate a fresh plan through the extension's real background/native-message path before execution. Live planning is restricted to the selected OpenRouter `:free` model. `--fast` is for diagnosing failures; omitting it uses four-second gaps. `--fixture-auth` supplies only the isolated synthetic account. `--expect-failed` checks an intentional faulty-site verdict with passed controls.

Actual drafts also failed or timed out during investigation. Validation/replay passes establish these recorded sandbox workflows, not guaranteed future model correctness or compatibility with every website. The microphone hardware and third-party authentication services were not exercised. The static suites were not used as acceptance evidence for this investigation.
