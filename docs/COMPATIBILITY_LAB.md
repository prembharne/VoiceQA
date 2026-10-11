# RelayDesk compatibility lab

RelayDesk replaces the Fieldnotes shop at the demo server's default URL. It is a local operations application with a server-backed order table, pagination/search/filters, a multi-step order wizard, asynchronous confirmation, protected invoices, persistent preferences, synthetic user roles, TOTP sign-in and operator checkpoints. Requests use a cookie session and named anti-CSRF token. Prices are computed on the server; submission keys bind one set of order details to one order.

## Run it

1. Stop an older `npm run demo` process with Ctrl+C in its terminal, then run `npm run demo` again from the project folder.
2. Open `http://127.0.0.1:4173/`. Reload VoiceQA at `chrome://extensions` after rebuilding the extension/host.
3. Share the current website tab. Choose **Run the demo test suite**, inspect the plan and confirm it. Fixture plans are deterministic; a typed or spoken custom request uses the selected AI model instead.
4. Open **Compatibility** in the website to switch between the four suites below. Share the selected page again if VoiceQA needs a fresh target. Keep the 3–5-second gap enabled to inspect each action.

An isolated preview can use a different loopback port. For example, in PowerShell: `$env:PORT='4176'; npm run demo`. Credential profiles are bound to the exact origin/port. The extension's demo shortcuts recognize ports 4173–4176; host validation also requires a known fixture marker.

## Four suites

| Page | Suite | What it verifies |
|---|---|---|
| `/` | Application workflows | Async orders, pagination/search, modal Escape/focus restoration, required fields, invalid discount feedback, reviewed totals, real server confirmation, captured order ID, API total, owned invoice tab and return/cleanup, preferences after navigation |
| `/app/layout` | Responsive and accessibility | Populated dashboard/table at 1440×900 and 390×844, horizontal overflow, serious/critical axe findings |
| `/app/auth` | Authentication and operator checkpoint | Saved credential entry, server-verified TOTP, signed-in identity, an operator-completed synthetic challenge followed by an independent assertion |
| `/app/security` | Logical security | Anonymous/ownership denials with a positive control; analyst/admin denial and a manager positive control; negative/positive CSRF controls; authoritative prices; duplicate-key handling and the resulting order record |

The application suite contains 50 planned actions and runs on desktop so it stays inside VoiceQA's execution bounds. It starts a synthetic Alice session for convenience; this does not prove authentication. Run the separate authentication suite for that. The default row is quantity 2 and expected total 255: two $120 displays plus $15 express delivery. Projects/trend/activity content is illustrative; order and preference outcomes come from the server.

For repeated workflows, open **+ → Test data rows** and enter:

```json
[{"quantity":"1","total":"135"},{"quantity":"3","total":"375"}]
```

This complete 50-action suite supports up to four rows within the 200-action multi-row limit. Each row resets the workspace. Each created order/invoice has its own actual random ID. One row/case cannot inherit another's variables. All orders are synthetic; no payments occur.

## Authentication profile

In VoiceQA **+ → Test options → Test credentials & MFA**, save an origin matching the website and this public fixture account:

- Profile ID: `relay`
- Username: `qa@voiceqa.test`
- Password: `fixture-only`
- TOTP seed: `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`
- SHA-1, 6 digits, 30 seconds (API algorithm value `sha1`)

During the checkpoint, tick **I have completed the test challenge** on RelayDesk and wait for **Challenge completed**, then acknowledge the current checkpoint in VoiceQA. Acknowledgment alone is not an application pass. Production CAPTCHA/passkeys/device approvals still require the operator or official test keys in owned staging applications.

## Deliberate defects

Select one defect using `/app/security?bug=ownership`, `role`, `csrf`, `price` or `duplicate`. The matching server check must fail; `200` for an expected denial is a failure. Other controlled defects include `search`, `settings` and `async` for the application suite. They stay in the URL and are applied by the reset contract. The server binds only to loopback, caps sessions/orders, and exposes clearly named fixture/reset routes for synthetic accounts; these are not production authentication endpoints.

## Scope and evidence

| Capability | Evidence / limitation |
|---|---|
| DOM input, native selects, keyboard, focus, condition waits, SPA navigation | Actual extension/native-host application and responsive suites |
| Multi-tab and public captured values | Actual owned invoice tab, identity/total assertions and cleanup |
| Data rows and server-state isolation | Two complete workflows with different quantities/totals and order IDs |
| Session API checks and logical security | Real bounded requests against this server; seeded defects plus positive controls |
| Private credentials / local TOTP | Authentication suite and secret-free public records |
| Accessibility, screenshots, masking, visual baselines, cancellation and reconnect | New suites plus the existing regression suite; dynamic IDs need visual-only masks when approving baselines |
| AI planning | Separate opt-in live check: `node scripts/test-live-plan.mjs --workspace`, against a separate server on port 4176; no model switching/paid credits. Replay an accepted draft with `node scripts/test-live-run.mjs PATH`; its isolated artifacts are under `.tools/live-checks/`, outside regression-suite cleanup |
| Microphone transcription and TTS | Manual microphone/provider/browser playback check; fixture execution does not prove real speech input/output |
| Native file dialogs, cross-origin embedded applications, canvas-only controls, external SSO/SMS/passkeys | Outside the current automatic benchmark; do not claim them from this suite's result |

Passing this lab establishes the listed contracts and controls on this synthetic application, not full compatibility with every website/browser or a complete penetration test. The old shop remains only at `/fixtures/shop` to preserve existing regression evidence; it is no longer the main website.
