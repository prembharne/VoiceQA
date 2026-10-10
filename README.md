# VoiceQA

A Chrome side-panel extension that plans, executes, and independently verifies website tests from spoken requests. JavaScript controls the selected Chrome tab; a local Go companion handles AI, persistence, baselines, and reports.

## Quick start on Windows

Requirements: Node.js 24+, Go 1.26+, Chrome 125+, and PowerShell. No Node runtime is needed by the installed extension or companion after building.

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

3. Open <http://127.0.0.1:4173/> in a dedicated QA Chrome profile.
4. Click the extension icon to open its side panel. If offline, choose **Retry connection**; the screen displays your extension ID and a copyable setup command. Once connected, click **Test this tab** and grant access to that site's origin.
5. Click **Load fixture plan**, review its expected outcomes, and choose **Confirm and run tests**.
6. Inspect evidence and export an HTML, JSON, or JUnit report.

`npm run package` builds a portable Windows distribution in `dist/package` and `dist/voiceqa-windows.zip`. Extract it to a stable folder before registering its companion; moving it later requires registration again.

The fixture suite uses real browser input, screenshots, DOM assertions, native messaging, SQLite, and accessibility scans. It is explicitly deterministic and does not claim to demonstrate an AI-generated plan.

## Voice and AI mode

Open **Local setup**, enter your OpenAI API key, and set a reasoning model available to your account. The plan's initial defaults are `gpt-5.6-sol` and `gpt-4o-mini-transcribe`; unavailable models fail explicitly, so adjust them to your account's supported IDs. There is no silent fallback. Keys are encrypted locally with Windows DPAPI; you can alternatively set `OPENAI_API_KEY` before starting Chrome. API billing is separate from subscriptions.

Click **Start voice session**, allow the microphone, and describe a workflow. The tool pauses recording while speaking, asks for missing requirements, and reads back assertions before execution. Say:

- “Run these tests” — confirm and start the current plan.
- “Cancel test” — stop new actions and preserve partial evidence.
- “Status” — hear current progress.
- “Repeat” — hear the current proposal or clarification.
- “Resume” — resume after returning to the selected tab.
- “Run again” — rerun the reviewed plan.

A typed request is also supported. Spoken cancellation includes transcription latency; the panel's Stop button cancels locally without waiting for the speech provider. Microphone and model-provider behavior require a live validation with your credentials and permissions.

### Text-to-speech API key

Open **Local setup → Text-to-speech**. Choose **OpenAI API speech**, enter a dedicated **Text-to-speech API key**, and configure a speech model and voice. Click **Save settings**, then **Test saved speech settings**. Replies use an AI-generated voice.

The default API speech settings are `tts-1` and `alloy`; change them to a model/voice combination available to your account. A dedicated TTS key takes priority. If you explicitly enable **Use the main OpenAI key when no TTS key is set**, speech can reuse the existing reasoning/transcription key. `VOICEQA_TTS_API_KEY` is an alternative to saving the dedicated key. Saved keys are encrypted with Windows DPAPI and are never returned in settings, logs, or reports. Leaving a key field blank preserves its saved value.

**Browser speech — no API key** remains the default. Provider failures are explicit; OpenAI speech never silently switches to browser speech. Stop cancels pending synthesis and current playback. Temporary speech files are released after playback or cancellation; long replies are split into bounded chunks.

## Visual baselines

Enable **Compare approved visual baselines** before proposing a plan. The first run returns `needs_review` for missing baselines. Inspect each checkpoint and choose **Approve baseline**, then rerun. Baselines include URL, viewport, browser version, platform, and redaction settings. They are never replaced automatically.

Images are normalized to scale factor 1. Pixel changes over 25 RGB units count toward a 0.5% threshold. This intentionally simple comparison is useful for repeatable fixtures; dynamic content requires explicit masks. Automated accessibility covers named checkpoints and does not establish complete conformance.

## Debugging and tests

```powershell
npm test
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

The MVP covers DOM-grounded controls, same-origin frames/open shadow roots for functional observations, and main-document accessibility checks. Cross-origin frames, native dialogs, external authentication popups, canvas-only controls, arbitrary code execution, load testing, and desktop/mobile-native testing are unsupported. Agent-supplied completion claims do not determine results.

The Go controller and protocol boundary can be reused by a later desktop shell. Native desktop control needs its own executor and acceptance suite.
