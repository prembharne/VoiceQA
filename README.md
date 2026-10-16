# VoiceQA

A Chrome side-panel extension that plans, executes, and independently verifies browser workflows and QA checks from typed or dictated requests. JavaScript controls the selected Chrome tab; a local Go companion handles AI, persistence, baselines, and reports.

The side panel is a conversational workspace: share the current website from the bottom composer, type or speak a test request, review the inline plan and watch results stream into the conversation. The top-right settings gear contains only the AI provider and its encrypted API key; the clock/history icon opens saved runs and plans. The **+** menu holds test options and the step gap. New chat clears the visible conversation while preserving saved records. Removing the sharing chip disconnects the selected test target and is disabled during an active run.

For the proposed hosted product and commercial rollout, see [the micro-SaaS roadmap](docs/MICRO_SAAS.md). Hosted accounts, collaboration and billing are future work.

Version 0.14.0 treats a live automation request as a persistent goal. Rejected proposals, visual response errors and inconclusive waits return feedback to the controller for fresh observation and another approach. Identified non-submitting UI navigation controls can be retried when a click has no effect; ambiguous submissions remain protected. Failed checks stay failed while remaining work can continue. Completion requires independently checked outcomes. See [goal recovery, limits and acceptance](docs/GOAL_CONTROLLER.md).

Version 0.13.1 separates asynchronous readiness from final assertions. Readiness waits poll for up to 60 seconds by default (120 seconds when requested), tolerate changing labels on the same element, and record elapsed time. Version 0.14.0 replaces its two-handoff limit with the shared goal recovery budget. Final assertion mismatches still fail. See [timing behavior and live acceptance](docs/READINESS_WAITS.md).

Version 0.13.0 adds hybrid routing: Dots 3 handles normal DOM automation; Agent S3 with Qwen 3.7 Flash handles visual recovery when DOM execution stalls. Reviewed QA can recover missing targets, and current-page debugging can inspect screenshots without interacting. Go/Eino retains scope, execution and outcome checks. Install the optional runtime using `scripts/install-agent-s.ps1`, then reload the extension. It shares your encrypted OpenRouter key; Qwen charges can apply. See [setup, boundaries and actual AI acceptance](docs/HYBRID_AGENT_ROUTER.md).

Version 0.12.1 defaults new installs and OpenRouter provider selection to Dots 3 (`dots-studio/dots-3-note-preview:free`). Live automation uses Qwen 3.7 Flash (`qwen/qwen3.7-flash`) only after a Dots availability failure or empty result, using the same saved OpenRouter key. Existing explicit provider/model selections are preserved.

Version 0.12.0 embeds Eino ADK v0.9.21 as the live browser automation runtime. It uses the existing typed browser tools and permission boundaries, supplies bounded correction feedback, rejects native-invalid submissions before dispatch, records the actual model/runtime, and supports the authorized Dots-to-Qwen fallback on transient provider failures. See [Eino integration and acceptance](docs/EINO_AGENT_HARNESS.md). Existing QA planning and read-only investigations retain their controllers.

Version 0.11.4 exposes custom IDE controls and unnamed inputs, focuses caret-based editors before typing, and supplies bounded correction feedback without replaying unchanged actions. Dots 3 found the new controls but repeated ineffective clicks; the authorized Qwen fallback completed the isolated editor journey with four passing assertions and exactly one save. The live Remix probe compiled during manual inspection; VoiceQA-driven Remix deployment remains unverified. See [IDE control evidence](docs/IDE_CONTROL_ACCEPTANCE.md). Earlier typed-function and general security results remain in [typed-function evidence](docs/NATIVE_FUNCTION_TRANSPORT.md) and [security acceptance findings](docs/GENERIC_SECURITY_ACCEPTANCE.md).

Version 0.11.0 adds **fresh completion checks across scoped tabs**. Each final check names a live page alias; the runner switches to that page, re-observes it and verifies its actual outcome. Tab switches count against the action budget. Unchanged form inputs cannot be submitted twice within a live run, and an observed incorrect result cannot be replaced with another matching element to manufacture a pass. Tab argument correction uses only observed links and retains normal origin validation. See [multi-tab automation verification](docs/BROWSER_AUTOMATION.md).

Version 0.10.0 makes **Browser automation a direct live-tool loop**: request/permission preparation makes no AI call and generates no action plan or checklist. The model chooses tools from current page state; a late coverage review and local assertions verify outcomes after execution. **Investigate with AI** reads a selected completed run and separates recorded facts from hypotheses, with scope and privacy guards. See [live automation](docs/BROWSER_AUTOMATION.md) and [recorded debugging](docs/RECORDED_DEBUGGING.md).

Version 0.9.0 adds two product workspaces: **QA & debugging** and **Browser automation**. Automation reviews a goal, final-state criteria and permissions, then chooses one typed action from fresh observations after each step. Earlier page rules/results are retained in bounded sanitized memory. Missing controls are checked before dispatch, unchanged-state replay is blocked and completion requires independent checks for every criterion. The browser width and selected model remain fixed. Real-model acceptance includes a healthy multi-stage journey and intentional incorrect-receipt detection. See [the adaptive automation workflow and actual AI validation](docs/BROWSER_AUTOMATION.md). This is an intermediate capability release; the full advanced-agent goal remains active.

Version 0.8.0 adds an actual model-directed investigation loop with scoped browser tools: page observation, element inspection, visible-text search, linked-page previews, diagnostic evidence and accessibility checks. Use **Ask & investigate** for evidence-backed answers; **Investigate before planning** gathers context before drafting an execution plan. Tools do not submit forms or execute arbitrary code. Console argument values are excluded, URL parameters are removed from investigation evidence, and marked private descendants are removed from public text extraction. Numeric assertions reject empty/ambiguous evidence. The broader advanced-agent objective remains active in [the capability audit](docs/AGENT_GOAL_AUDIT.md).

Version 0.7.0 makes normal planning website-independent: one system contract, redacted page evidence, bounded chat context and locally validated actions for both QA and browser workflows. RelayDesk-specific contracts and workstream splitting are removed from ordinary AI requests. The chat now uses soft elevation and generic suggestions, and automatic speech announcements are removed while microphone dictation stays available. See [the request architecture and live acceptance procedure](docs/AGENT_REQUEST_FLOW.md).

Version 0.6.2 fixes model action-field mismatches, validates credential references and known RelayDesk workflow stages before execution, and checks requested demo coverage. Broad demo journeys use focused AI workstreams assembled into one reviewable plan. The planner sends a visible schema, actual navigation/reference examples and focused fixture context. Dots reasoning stays at its provider default when no budget control is advertised; disabling it in 0.6.1 produced unreliable live drafts. The executor waits for missing controls to render before dispatching input, and typed comparisons normalize captured currency amounts. Planning output remains uncapped by VoiceQA and current browser width is preserved. Save an origin-bound test profile under **+ → Test options → Test credentials & MFA** before requesting saved-account authentication.

Version 0.5.1 checks OpenRouter model capabilities before planning: native schema, JSON-object mode or a prompted JSON contract, with local validation in every mode. OpenRouter planning allows up to 32,768 combined output tokens, capped to the advertised model limit; supported reasoning budgets are bounded separately. Models and providers are never switched automatically.

Version 0.5.0 adds NVIDIA NIM, clean API-only Settings, a model picker in the composer and microphone dictation into an editable draft. Test credentials move to **+ → Test options → Test credentials & MFA**. It also fixes AI planning deadlines with streamed progress, cancellation and clear failure messages. Partial output never becomes a runnable plan.

Version 0.4.1 replaces the default shop with RelayDesk: server-backed order tables, a validated wizard, persistent settings, invoices, TOTP and scoped security scenarios. Four fixture suites and a coverage guide separate supported checks from manual limitations.

Version 0.4 adds data-driven workflows, captured values, session-aware API checks, logical security mode, network evidence, failure triage, run comparisons and reusable workflow drafts. See [workflow and security testing](docs/TESTING_WORKFLOWS.md). Version 0.3's multi-tab, encrypted profile, TOTP and operator-checkpoint features remain available in [advanced browser testing](docs/ADVANCED_TESTING.md).

## Quick start on Windows

Requirements: Node.js 24+, a Go installation with automatic toolchain downloads enabled (this release selects patched **Go 1.27.2**), Chrome 125+, and PowerShell. No Node runtime is needed by the installed extension or companion after building.

```powershell
npm ci
npm run build:all
npm run demo
```

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** → this project's `dist/extension` directory.
2. Copy the extension's 32-character ID. In another terminal, register the local companion:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-host.ps1 -ExtensionId YOUR_EXTENSION_ID
   ```

3. Open <http://127.0.0.1:4173/> in a dedicated QA Chrome profile. The default website is now **RelayDesk**, a complex operations workspace. See [compatibility suites](docs/COMPATIBILITY_LAB.md). Restart an older running demo server before refreshing the page.
4. Click the extension icon to open its side panel. If offline, choose **Retry connection**; the screen displays your extension ID and a copyable setup command. Once connected, click **Share current tab** and grant access to that site's origin.
5. Click **Run the demo test suite**, review its expected outcomes, and choose **Confirm and run tests**.
6. Inspect evidence and export an HTML, JSON, or JUnit report.

After updating an unpacked build, click **Reload** on VoiceQA at `chrome://extensions`, then close and reopen the side panel. Keep a normal HTTP(S) website active when clicking **Share current tab**; Chrome settings, new-tab pages, and extension pages cannot be tested. The `tabs` permission lets the panel read the active website's URL even when it was opened without a fresh extension-icon click. Reading or interacting with page content still requires the separate site-access grant.

`npm run package` builds a portable Windows distribution in `dist/package` and `dist/voiceqa-windows.zip`. Extract it to a stable folder before registering its companion; moving it later requires registration again.

New chat runs preserve the actual browser viewport. Opt in to **Resize for desktop + mobile checks** under Test options when that is explicitly wanted. An older responsive plan is copied into an unconfirmed current-width plan for review; its original saved actions/version remain unchanged. Changing the width option requires a matching proposal before execution.

The fixture suite uses real browser input, screenshots, DOM assertions, native messaging, SQLite, and accessibility scans. It is explicitly deterministic and does not claim to demonstrate an AI-generated plan.

## Voice and AI mode

Open **Settings**, choose OpenAI, OpenRouter or **NVIDIA NIM**, paste that provider's key and click **Save API key**. Keys are encrypted locally with Windows DPAPI and stored separately. Blank input keeps a saved key. Choose or edit the model using the model selector in the chat composer. Switching providers chooses its initial model; updating a key preserves the selected model. Unavailable models/unsupported parameters fail explicitly, with no silent provider or model fallback.

OpenAI uses `https://api.openai.com/v1/responses`; OpenRouter uses `https://openrouter.ai/api/v1/chat/completions` with parameter-compatible routing. A public model catalog lookup selects native JSON schema when both `response_format` and `structured_outputs` are advertised, JSON-object mode when only `response_format` is advertised, or a full JSON contract in the prompt when neither is advertised. Catalog data is cached for five minutes and contains no keys or website content. Unsupported formatting parameters are never sent, and `require_parameters` remains enabled. Hosted NVIDIA NIM uses `https://integrate.api.nvidia.com/v1/chat/completions`, streamed JSON-schema requests and the initial model `nvidia/nemotron-3-nano-30b-a3b`. The public catalog and account access can change; choose another supported NIM model in the composer when needed. `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `NVIDIA_API_KEY` are alternatives to saving keys. Provider keys are never shared with another provider or OpenAI speech. API usage/billing is separate from subscriptions and depends on your account.

Click the **microphone**, speak and watch the transcript appear in the chat input. Click the microphone again to finish, edit the text and explicitly press **Send**. Dictation never submits a prompt, runs tests or executes spoken commands automatically. It preserves existing draft text, replaces interim results and suppresses late results after Stop or New chat. It does not require an AI key, a selected website, a transcription model or a speech API key. Chrome's Web Speech recognition needs microphone permission and can send audio to Chrome's speech service; it is not promised to work offline. Permission/service failures are shown clearly. Real microphone recognition depends on your Chrome installation, language and network.

The Settings page intentionally omits speech/TTS models, TTS keys, masks and test-account forms. **+ → Test options → Test credentials & MFA** keeps origin-bound test profiles available separately. Default private-field redaction still applies. The companion retains existing speech RPCs/settings and saved secrets for backward compatibility; the panel uses browser playback and does not invoke a hidden API TTS configuration.

AI output must pass local plan validation before review. Boolean expectations are constrained to the strings `true`/`false` in the model schema. Invalid drafts receive at most one correction request with the same model, original requirements, observations, and a shared six-minute planning deadline. Authentication, transport, refusal, and incomplete-response errors are not retried. A model must choose between a plan and a clarification question; clarification responses carry no runnable actions. Generating a replacement draft clears the old panel plan. Planning uses streamed provider events and shows phases plus elapsed time. Planning does not send an application-set max_tokens/max_output_tokens cap to any provider. The provider determines its own output allowance; provider limits still exist. Advertised limits are read for capability checks and supported reasoning controls. Single-target re-grounding remains bounded separately. Where advertised, reasoning-budget controls reserve room for the visible answer. The companion RPC allows seven minutes including observations; the native and panel bridges allow 7.5 and eight minutes respectively. Ordinary speech and target-grounding requests retain the 90-second HTTP limit. Stop cancels planning; a failed typed request returns to the composer for editing. A slow or unavailable provider can still hit the bounded deadline.

For an opt-in live planning check, start `npm run demo`, then run `node scripts/test-live-plan.mjs`. It uses your saved OpenRouter key and selected model in isolated test data, reads a real demo DOM observation, and drafts the coupon/cart request. It does not confirm a plan or execute test actions. This calls the model API and may use credits. Encrypted key copies are removed at teardown; the accepted draft is saved under `.tools/live-checks/live-plan-*/accepted-plan.json`. The deterministic browser suite does not make live model calls.

## Step-by-step execution

Runs execute one action at a time with a **4-second inspection gap** by default. Open the composer’s **+ → Test options → Gap between steps** to use 3, 4, or 5 seconds. **No gap · fast automation** is available for unattended regression runs. The pace is fixed when a run starts; it cannot change mid-run. Existing settings inherit the 4-second default unless a pace was explicitly saved.

Results show the current action, its case/viewport, the previous step's outcome, and a countdown before the next action. The gap also applies to layout changes, page resets, assertions and accessibility checks. **Stop** interrupts the wait immediately, preventing the next action from being dispatched. Assertions still wait for their conditions; the inspection gap is additional time to watch the website.

Each test case must start with a navigation/reset. Plans that put checks before their reset are rejected and sent for the bounded correction attempt. The planner is instructed to emit steps in execution order: reset → interact → check. Cases run across the selected viewports automatically. Regenerate older plans that placed checks first; saved plans are not silently reordered.

The live planning script accepts an optional text-file path for a specific request. `node scripts/test-live-run.mjs PATH_TO_ACCEPTED_PLAN_JSON` verifies a generated mug/coupon plan in an isolated Chrome extension/native-host session with four-second gaps, saves screenshots and a run record, and restores test registration afterward. Its scope excludes checkout/sign-in and targets only the local demo. It performs the demo actions and makes no further model calls.

Click **Transcribe request**, allow the microphone and describe a workflow. Finish dictation, review the text and press Send. Commands below are processed only when you submit them:

- “Run these tests” — confirm and start the current plan.
- “Cancel test” — stop new actions and preserve partial evidence.
- “Status” — hear current progress.
- “Repeat” — hear the current proposal or clarification.
- “Resume” — resume after returning to the selected tab.
- “Run again” — rerun the reviewed plan.

Typed and dictated requests both require explicit submission and plan approval. The panel's **Stop** cancels locally and does not wait for voice transcription.

## Speech playback

The panel no longer speaks selection, plan or pass/fail announcements. Microphone dictation remains available. The companion's legacy API synthesis endpoints remain available to existing clients, but they are not used by the clean chat UI.

## Visual baselines

Enable **Compare approved visual baselines** before proposing a plan. The first run returns `needs_review` for missing baselines. Inspect each checkpoint and choose **Approve baseline**, then rerun. Baselines include URL, viewport, browser version, platform, and redaction settings. They are never replaced automatically.

Images are normalized to scale factor 1. Pixel changes over 25 RGB units count toward a 0.5% threshold. This intentionally simple comparison is useful for repeatable fixtures; dynamic content requires explicit masks. Automated accessibility covers named checkpoints and does not establish complete conformance.

## Debugging and tests

```powershell
npm test
npm run security:check
go test ./companion/...
go vet ./companion/...
go test -race ./companion/...
npx playwright install chromium
npm run build:all
npm run test:browser
```

The Windows browser suite loads the production extension into an isolated Chromium profile and starts the real native Go host. It temporarily registers the test host under Chromium, then restores the previous registration. It never uses your Chrome profile or API key. Go race tests need a C compiler on Windows; standard Go tests and the production build use the pure-Go SQLite driver.

Evidence and browser test results appear in `test-results/native-integration`; the HTML test report is in `playwright-report`. Test failures include a Playwright trace. Tests must run serially because native-host registration is per user.

Useful failures to demonstrate:

- `/?bug=total`: wrong cart total.
- `/?bug=coupon`: coupon rejection message missing.
- `/?bug=order`: confirmation missing.
- `/?bug=accessibility`: unlabeled button.
- `/?bug=overflow`: horizontal overflow.

Companion runtime data defaults to `%LOCALAPPDATA%\VoiceQA`. Override `VOICEQA_DATA_DIR` for isolated testing. Logs go to stderr, never into the native message stream. Protocol errors identify the operation without exposing keys. On a crash, dispatched actions have unknown outcomes and are not replayed.

If Chrome cannot find the host, verify the installed extension ID matches `dist/native-host.json`, rerun registration, and reconnect. Keep the built executable at its registered path.

The installer registers both Chrome and Chromium by default. To check registration and executable startup without touching real runs or credentials:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-host.ps1 -ExtensionId YOUR_EXTENSION_ID
```

Version 0.2 adds recovery from disconnected ports, copyable in-panel setup, Motion-powered buttons/page transitions, local Inter fonts, Lucide icons, and actionable empty states. Reduced-motion preferences disable physical motion. Browser speech has a startup watchdog so an unavailable voice cannot leave the microphone blocked indefinitely. After updating an unpacked build, click **Reload** for VoiceQA at `chrome://extensions`, then reopen the panel.

To remove registration:

```powershell
powershell -NoProfile -File .\scripts\uninstall-host.ps1
```

Saved reports and encrypted settings are preserved. API-key encryption is currently Windows-only; other platforms require `OPENAI_API_KEY` and native-host installation appropriate to that platform.

## Architecture and boundaries

See [architecture](docs/ARCHITECTURE.md), [protocol](docs/PROTOCOL.md), and [validation status](docs/VALIDATION.md).

- `extension/`: React panel, Manifest V3 worker, fixed browser executor, DOM observations, bundled axe.
- `companion/`: Go native transport, structured-output provider, controller, SQLite store, visual comparator, and reports.
- `shared/`: protocol schemas and build-time generated validation.
- `demo/`: resettable synthetic shop and deliberate defects.
- `tests/`: JavaScript contracts and real extension/native-host integration.

One active run, 50 planned actions, and 10 minutes per run. Browser actions are restricted to the selected tab and approved origin. The user’s existing session is used; use a dedicated QA profile and synthetic accounts. Cancelling does not undo completed website changes.

The executor covers DOM-grounded controls, same-origin frames/open shadow roots, main-document accessibility and up to five approved pages. It switches between shared tabs and can open/close its own test tabs. Login redirects may move only between explicitly approved origins. External popups must be shared explicitly; automatic discovery or takeover of authentication popups is unsupported. Cross-origin frame contents, native dialogs, canvas-only controls, arbitrary code execution, load testing and desktop/mobile-native testing remain unsupported. Agent-supplied completion claims do not determine results.

The Go controller and protocol boundary can be reused by a later desktop shell. Native desktop control needs its own executor and acceptance suite.

CodeRabbit is integrated as an optional development reviewer through `.coderabbit.yaml` and `npm run review:coderabbit`. It uses your separate CodeRabbit login; its proprietary CLI is not part of the customer package. The local security check uses npm advisories and the BSD-licensed Go vulnerability checker. See [review integration and commercial boundaries](docs/REVIEW_AND_COMMERCIAL_USE.md).
