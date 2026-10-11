# Advanced browser testing

VoiceQA 0.3 keeps one serial, cancellable run while letting it use up to five pages. This is browser QA on explicitly shared websites, with independent assertions and local evidence.

## Share pages

1. Open your starting website and choose **Share current tab** in VoiceQA.
2. Open any additional website, including a staging login provider, in the same Chrome window.
3. Use **+ → Choose another tab → Additional website tab → Share selected tab**. Grant access when requested.
4. Refer to its displayed alias (`main`, `page2`, etc.) in your request. Review the plan's pages and expected results before running.

The agent can switch to shared aliases, open a named test tab on an already shared origin and close only a tab that the current run created. Existing user tabs remain open. Case boundaries reset the selected page scope and remove tracked test tabs. User tab changes pause execution; the agent's own planned tab switches continue automatically. The selected desktop/mobile width is reapplied after every switch.

Opening a second origin is explicit authorization for that origin within the run. Login navigation and redirects may cross only those approved origins. Share the login provider before generating an SSO plan. Profiles are independently bound to the exact credential-entry origin. Automatic popup discovery, arbitrary cross-origin iframe control and native authentication dialogs are not implemented.

## Test credentials and MFA

Use **+ → Test options → Test credentials & MFA**. Set a lowercase profile alias, descriptive label and exact origin (scheme, hostname, optional port; no path), then enter test username/password and optionally a Base32 TOTP seed or `otpauth://totp/...` URI. Save using **Save test credentials**. These fields are separate from AI and speech API keys.

Saved profiles use Windows DPAPI. SQLite and public settings contain metadata and availability flags. The planner sees profile aliases, origins and flags, not stored credentials. Plans record references such as `qa-account:password`; the Go host resolves them only at execution time. The browser checks the actual origin before entry. Passwords, one-time-code fields and fields marked by secure entry are masked in DOM observations and screenshots. Value assertions on private fields are blocked. Do not make your application echo secrets into ordinary page text; use custom redaction selectors for any other sensitive content.

TOTP supports SHA-1/SHA-256/SHA-512, 6 or 8 digits and 15–120-second periods. Keep the machine clock synchronized. When less than ten seconds remain in a period, generation waits cancellably for the next period to reduce expiry during paced execution. This cannot prevent expiry if an application introduces a long delay after code entry.

Blank credential fields preserve saved values. Edit a profile to replace its credentials; delete/recreate it to change its bound origin. Settings changes are blocked while a run is active. Use test accounts on environments you control.

Example request:

> On main, sign in using profile staging-qa. Enter its username and password, generate its TOTP in the one-time-code field, submit, and verify the heading is exactly “Dashboard”. If a device approval is required, pause for me and then verify the dashboard. Reset before each independent case.

SMS/email codes, passkeys and device approvals use a **human checkpoint**. Complete the challenge on the active website and click **I completed the checkpoint**. That acknowledgment lets the run continue; the following application assertion still determines whether authentication succeeded. Stop invalidates the checkpoint so a late acknowledgment cannot resume the old run.

## CAPTCHA

Production challenges use operator completion followed by an application check. VoiceQA does not inject challenge tokens, integrate solver services or bypass production CAPTCHA. Challenge indicators are included in page observations to help the planner choose a checkpoint.

For your staging application, configure the provider's official test keys on the application itself. Cloudflare documents deterministic [Turnstile testing keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/); Google documents [reCAPTCHA testing](https://developers.google.com/recaptcha/docs/faq). The extension does not change production keys. The bundled lab uses a clearly labeled synthetic CAPTCHA fixture, not a real provider challenge.

## Readiness and checks

`wait_for` polls a specific DOM/URL condition to a deadline (default 6 seconds, configurable 500–30,000 ms). It does not replace a separate final `assert`. Checks now include normalized exact text, text containment, nonprivate input values, visible/hidden states and exact/partial URL matches, along with numeric totals, counts, focus and overflow. The 3–5-second inspection gap remains separate from readiness waits.

Runs keep the 50 planned-action limit across viewports and ten-minute deadline. Layout, scope preparation and accessibility add recorded steps. Tab switching and wait polling do not require additional model calls. Ambiguous dispatched mutations are never automatically replayed.

## Reproducible advanced lab

Restart `npm run demo` after rebuilding, then open **http://127.0.0.1:4173/advanced** and share it. Save this synthetic profile:

| Field | Value |
|---|---|
| Profile alias | `advanced-lab` |
| Credential origin | `http://127.0.0.1:4173` |
| Username | `qa@voiceqa.test` |
| Password | `fixture-only` |
| TOTP seed | `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` |
| Algorithm / digits / period | SHA-1 / 6 / 30 |

Choose **Run the demo test suite**, review and confirm. The fixture verifies a server-checked TOTP login, separate counters in main/child tabs, delayed content and a manual CAPTCHA checkpoint. At that checkpoint, click **Complete test CAPTCHA** on the website and then acknowledge in VoiceQA. There are six independent functional assertions. The demo is deterministic; it does not prove live model planning or third-party SSO/CAPTCHA compatibility.

The automated Windows browser suite runs this lab on a separate port (4174), with isolated host data and synthetic credentials. It also checks cancellation, redaction, preservation of user tabs and restoration of screen width. TOTP unit tests use the published [RFC 6238 vectors](https://www.rfc-editor.org/rfc/rfc6238.html).
