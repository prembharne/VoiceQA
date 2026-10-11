# Workflows, debugging and logical security

VoiceQA 0.4 lets one reviewed workflow carry values between browser and server checks, repeat with public test data and produce useful evidence when a check fails. Existing multi-tab, secure credential profiles, TOTP, voice input and operator checkpoints remain available.

## Data-driven workflows

Open **+ → Test data rows** and enter up to five JSON rows, for example:

```json
[{"quantity":"1","total":"12"},{"quantity":"3","total":"36"}]
```

Use `${quantity}` and `${total}` in the request or reviewed plan. Each case starts with its own copy of the row. A `capture_value` step can collect a nonprivate element's input value or normalized text into a public alias such as `order-id`; later steps can use `${order-id}`. API checks can capture a public scalar JSON field using `saveAs`. A variable cannot be used before it is available, and no previous case/row supplies implicit state.

Credential references may select public profile aliases from data rows (`${account}:username`, `${account}:password`, and TOTP profile `${account}`). The profile still resolves locally against the actual page origin. Test-data names containing password/token/secret/CSRF indicators are blocked. Store actual credentials in Settings, not data rows. Public synthetic email inputs may be filled while observations/screenshots remain redacted; password/OTP/explicitly private fields require secure profile entry.

Completed results offer **Reuse workflow with test data**. This creates a new unconfirmed draft and preserves the original plan/run. Review its rows, API routes, payloads, expected statuses and values before starting.

## Browser-session API checks

`http_check` sends one bounded request from the active approved page. It includes that page's cookies, blocks redirects, never follows an unapproved origin and does not accept arbitrary custom headers or JavaScript. GET/HEAD are enabled in functional QA. For QA writes, enable **Allow API writes on my authorized test systems**; security mode requires the separate authorization acknowledgment. Both permissions apply only to the approved plan/site scope.

Each check has an explicit expected status and optional RFC 6901 JSON pointer/expected value. `expectedType` can require string, number, boolean or null; numeric checks can use a declared tolerance. Unknown or container-valued captures fail rather than being treated as a pass. Responses are capped at 16 KiB; only the selected public scalar, status and timing are recorded. A wrong status is evaluated without collecting its body. No mutation is automatically retried after dispatch or an unknown outcome.

For bearer sessions, use named browser references such as `authSource: "session:app-auth"`, with `authPointer: "/accessToken"` if the value is a JSON object. `local:KEY` and `cookie:NAME` are also supported. Values stay inside the browser and are sent only as Authorization to the current origin. Provider API-key/password sources are rejected. Ordinary cookie sessions need no special reference.

For anti-CSRF handling, use `csrfSource: "meta:csrf-token"`, `input:csrfmiddlewaretoken` or `cookie:XSRF-TOKEN`. Select a supported CSRF header or `csrfBodyField`, never both. The token is resolved at request time and does not enter the plan, model input, workflow variables or report. Known headers include X-CSRF-Token, X-CSRFToken, X-XSRF-TOKEN and RequestVerificationToken. These references must identify a dedicated anti-CSRF value; arbitrary protected fields are not accepted.

Limits: five approved pages, five rows with twenty public variables each, twenty API checks per run, 250 ms minimum spacing between API checks, 50 planned actions for one row or 200 across multiple rows/viewports, and a twenty-minute deadline. The existing 3–5-second inspection gap remains additional pacing and is cancellable.

## Logical security mode

Choose **+ → Testing mode → Logical security**, then acknowledge authorization for the shared test systems. Describe specific test accounts, known API routes/resources and expected rules. Include a positive authorized control before interpreting denied access. The planner must ask for missing routes/rules rather than invent them.

The bundled suite covers anonymous access, horizontal ownership checks, vertical server-role enforcement, client price tampering, CSRF negative/positive controls, bearer-session ownership and idempotency. These checks verify server responses; client UI visibility or an agent completion statement does not establish authorization.

`security_audit` reports bounded configuration indicators for the current document: observed transport, CSP/framing/nosniff/HSTS policies and session-like cookie flags. Cookie values are discarded. High-severity indicators make the run need review. These are scoped observations, not a complete penetration test or compliance certification. Production CAPTCHA, passkeys and device approval continue to use operator checkpoints.

## Evidence and diagnosis

Network evidence includes the latest twenty requests for the active page, method, public URL, status, failure and timing. Query values/fragments are redacted; bodies, authentication headers and cookie values are not recorded. Screenshots accompany assertions/failures. **Export bug report** produces Markdown reproduction steps and evidence-based triage. A likely category is not a proven root cause; the suggested next check identifies what to verify.

History provides **Compare runs**, matching case, label, page, viewport and row index. It identifies fixed/regressed/added/removed steps. Changed inputs can explain a difference, so comparison does not establish flakiness by itself.

Private masks and **Visual-only masks** are separate. Use visual-only selectors for changing public fields such as order IDs/timestamps; functional capture/assertion remains available. Mandatory secret masks always apply. Visual baselines are separated by data row and mask settings. Large live snapshots preserve accurate counts and may show recent steps; HTML/JSON exports retain complete local evidence.

## Reproducible labs

Restart `npm run demo` and open `http://127.0.0.1:4173/workflows` for a two-row create-order → capture actual random ID → verify server total workflow. The fixed fixture uses a desktop viewport and synthetic accounts. Use **Run the demo test suite** to review and execute it.

Open `http://127.0.0.1:4173/security`, select authorized logical security mode and run its fixture. Known accounts are Alice/Bob; canonical resources are `alice-order`/`bob-order`. The lab includes live browser-cookie, private bearer and anti-CSRF reference controls. No real purchases or transfers occur.

Inject an individual defect using `?bug=idor`, `price`, `role`, `csrf` or `idempotency`. The suite must fail the corresponding server check. These deterministic contracts exercise the real extension, native host and browser requests; they do not imply live model planning or universal website reliability.

For an opt-in real model check, start a separate server with `PORT=4175`, then run `node scripts/test-live-plan.mjs --security`. It uses the selected saved OpenRouter `:free` model and encrypted credential copies in isolated data, drafts only, and deletes copies afterward. `node scripts/test-live-run.mjs PATH_TO_ACCEPTED_PLAN` replays an accepted scoped security draft with four-second gaps and no further model calls. Native registration is restored. Do not run registration-based integration checks concurrently.
