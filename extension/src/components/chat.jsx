import React, { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Globe2, Mic, Plus, Sparkles, Square, X } from 'lucide-react';
import { Button } from './ui.jsx';
import { PageSharing } from './page-sharing.jsx';
import { WorkflowOptions } from './workflow-options.jsx';
import { ModelPicker } from './model-picker.jsx';

export function ChatWelcome({ target, onPrompt, onDemo, busy }) {
  const demo = /^http:\/\/(127\.0\.0\.1|localhost):417[3-6]$/.test(target?.origin || '');
  const pathname = target?.url ? new URL(target.url).pathname : '';
  const workspace = demo && (pathname === '/' || pathname.startsWith('/app/'));
  const workspaceSecurity = workspace && pathname === '/app/security';
  const workspaceLayout = workspace && pathname === '/app/layout';
  const workspaceAuth = workspace && pathname === '/app/auth';
  const advanced = demo && new URL(target.url).pathname === '/advanced';
  const lab = demo && ['/security', '/workflows'].includes(new URL(target.url).pathname);
  const security = lab && new URL(target.url).pathname === '/security';
  return (
    <section className="chat-welcome">
      <div className="welcome-center">
        <span className="chat-spark">
          <Sparkles size={36} strokeWidth={1.3} aria-hidden="true" />
        </span>
        <h1>What should we test?</h1>
        <p>Describe the flow. Watch every step.</p>
      </div>
      <div className="suggestions" aria-label="Suggested tests">
        <Button
          disabled={busy}
          onClick={() =>
            onPrompt(
              workspace
                ? workspaceSecurity
                  ? 'On RelayDesk, verify anonymous requests and cross-account order reads are denied; use an authorized positive control. Verify client admin claims do not grant server roles, tokenless writes are rejected, two Studio displays with express delivery always cost $255 despite a client price of 0.01, and repeating a submission key returns the same order. Reset before each case.'
                  : workspaceLayout
                    ? 'Verify the RelayDesk dashboard and populated order table have no horizontal overflow at desktop and mobile widths. Include accessibility checks.'
                    : workspaceAuth
                      ? 'Use my saved RelayDesk profile to sign in with TOTP, verify Alice Morgan is authenticated, pause for me to complete the synthetic challenge and independently verify Challenge completed.'
                      : 'In RelayDesk, create an order for Northstar Studio with contact qa@relay.test, two Studio displays and express delivery. Reject an invalid discount first, then remove it. Verify the review and server total are $255. Wait for order confirmation, capture the order ID, open its invoice in a new owned tab, verify the ID and total, return to the workspace and close only the created invoice tab. Reset the sandbox before the case.'
                : lab
                  ? security
                    ? 'Verify anonymous and cross-user API access is denied, server prices cannot be changed from the client, admin access is enforced by the server, CSRF is required and repeated idempotency keys do not create duplicate orders. Use authorized synthetic test accounts only.'
                    : 'Create one test order per data row, capture the returned order ID, and verify the visible and server totals. Use quantity and total variables from the public test data.'
                  : advanced
                    ? 'Use my saved test profile to sign in and verify Authenticated test account. In a separate case open /advanced/child in a new tab, verify Child page ready, increment its counter to 1, return to main and close only the created tab. Wait for delayed content before checking Delayed result ready. Pause for me to complete the CAPTCHA fixture, then verify CAPTCHA fixture completed.'
                    : demo
                      ? 'Add one Studio mug and verify the total is $12. Add another and verify the total is $24. Reset the page before the case. Do not place an order or sign in.'
                      : 'Check the main user journey on this page. Ask me for any missing expected results before creating the plan.',
            )
          }
        >
          {workspace
            ? workspaceSecurity
              ? 'Check RelayDesk server rules'
              : workspaceLayout
                ? 'Check the responsive workspace'
                : workspaceAuth
                  ? 'Test sign-in and TOTP'
                  : 'Test a complete order journey'
            : lab
              ? security
                ? 'Check server permissions and business rules'
                : 'Test a data-driven order workflow'
              : advanced
                ? 'Test MFA and browser workflows'
                : demo
                  ? 'Check the cart totals'
                  : 'Test a user journey'}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            onPrompt(
              'Check this page for horizontal overflow at desktop and mobile widths. Reset the page before each independent case.',
            )
          }
        >
          Check the mobile layout
        </Button>
        {demo && (
          <Button disabled={busy} onClick={onDemo}>
            Run the demo test suite
          </Button>
        )}
      </div>
    </section>
  );
}

export function ChatComposer({
  mode,
  apiWrites,
  onAPIWrites,
  onMode,
  authorized,
  onAuthorized,
  data,
  onData,
  pages,
  onSharePage,
  onRemovePage,
  request,
  onChange,
  onSend,
  target,
  onShare,
  onUnshare,
  onFocusTarget,
  connected,
  busy,
  drafting,
  running,
  voiceMode,
  voiceState,
  speaking,
  canVoice,
  hasKey,
  onVoice,
  onStop,
  onSettings,
  onModel,
  onCredentials,
  settings,
  onPace,
  responsive,
  onResponsive,
  visual,
  onVisual,
}) {
  const text = useRef(null);
  useLayoutEffect(() => {
    if (!text.current) return;
    text.current.style.height = 'auto';
    text.current.style.height = `${Math.min(132, Math.max(48, text.current.scrollHeight))}px`;
  }, [request]);
  return (
    <div className="composer-dock">
      {!hasKey && connected && (
        <p className="composer-hint">
          Add an AI key in <button onClick={onSettings}>Settings</button> to create custom tests.
        </p>
      )}
      {voiceMode && (
        <p className="voice-status" role="status">
          {voiceState} · Transcribing into your draft
        </p>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (request.trim() && !busy && !running && target && hasKey) onSend();
        }}
      >
        <div className={`sharing-chip ${target ? 'is-sharing' : ''}`}>
          <button
            type="button"
            className="sharing-label"
            onClick={target ? onFocusTarget : onShare}
            disabled={busy || !connected || (running && !target)}
            title={
              target ? `${target.title}\n${target.url}` : 'Share the active website with VoiceQA'
            }
          >
            <Globe2 size={16} aria-hidden="true" />
            <span>
              {target ? `Sharing “${target.title || target.origin}”` : 'Share current tab'}
            </span>
          </button>
          {target && (
            <button
              type="button"
              className="chip-remove"
              aria-label="Stop sharing this tab"
              disabled={busy || running}
              onClick={onUnshare}
            >
              <X size={17} aria-hidden="true" />
            </button>
          )}
        </div>
        <label className="sr-only" htmlFor="request">
          Test request
        </label>
        <textarea
          id="request"
          ref={text}
          value={request}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Ask VoiceQA to test this page…"
          rows={1}
          maxLength={8000}
          disabled={busy || running || voiceMode}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form.requestSubmit();
            }
          }}
        />
        <div className="composer-toolbar">
          <details
            className="composer-options"
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.open = false;
            }}
          >
            <summary aria-label="Test options" title="Test options">
              <Plus size={22} aria-hidden="true" />
            </summary>
            <div className="options-popover">
              <strong>Test options</strong>
              <WorkflowOptions
                apiWrites={apiWrites}
                onAPIWrites={onAPIWrites}
                mode={mode}
                onMode={onMode}
                authorized={authorized}
                onAuthorized={onAuthorized}
                data={data}
                onData={onData}
                disabled={running || busy}
              />
              <PageSharing
                pages={pages}
                running={running}
                busy={busy}
                onShare={onSharePage}
                onRemove={onRemovePage}
              />
              <Button disabled={!connected || busy || running} onClick={onCredentials}>
                Test credentials &amp; MFA
              </Button>
              <Button
                className="share-option"
                disabled={busy || running || !connected}
                onClick={onShare}
              >
                Use current tab
              </Button>
              <label htmlFor="step-gap">Gap between steps</label>
              <select
                id="step-gap"
                value={settings.stepDelayMs ?? 4000}
                disabled={busy || running || !connected}
                onChange={(e) => onPace(Number(e.target.value))}
              >
                <option value={3000}>3 seconds</option>
                <option value={4000}>4 seconds · recommended</option>
                <option value={5000}>5 seconds</option>
                <option value={0}>No gap · fast automation</option>
              </select>
              <label className="option-check">
                <input
                  type="checkbox"
                  checked={responsive}
                  disabled={busy || running}
                  onChange={(e) => onResponsive(e.target.checked)}
                />
                Desktop + mobile width
              </label>
              <label className="option-check">
                <input
                  type="checkbox"
                  checked={visual}
                  disabled={busy || running}
                  onChange={(e) => onVisual(e.target.checked)}
                />
                Compare approved visual baselines
              </label>
            </div>
          </details>
          <div className="composer-actions">
            <ModelPicker
              settings={settings}
              disabled={!connected || busy || running || voiceMode}
              onSave={onModel}
            />
            <button
              type="button"
              className={`composer-icon ${voiceMode ? 'active-mic' : ''}`}
              aria-label={voiceMode ? 'Finish transcription' : 'Transcribe request'}
              aria-pressed={voiceMode}
              onClick={onVoice}
              disabled={!canVoice && !voiceMode}
              title={
                canVoice
                  ? 'Speak to fill your draft. Click again to finish; nothing is sent automatically.'
                  : 'Transcription needs speech recognition in Google Chrome.'
              }
            >
              <Mic size={20} aria-hidden="true" />
            </button>
            {drafting || running || speaking || voiceMode ? (
              <button
                type="button"
                className="composer-send stop-send"
                aria-label="Stop"
                onClick={onStop}
              >
                <Square size={17} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="composer-send"
                aria-label="Send test request"
                title="Send · Enter"
                disabled={!request.trim() || busy || !connected || !target || !hasKey}
              >
                <ArrowUp size={20} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
      <p className="composer-caption">
        {voiceMode
          ? 'Speak your request. Review the text before sending.'
          : running
            ? 'Testing one step at a time. Stop is always available.'
            : 'Review the plan before running. Shift + Enter for a new line.'}
      </p>
    </div>
  );
}
