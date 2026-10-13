import React, { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Globe2, Mic, Plus, Sparkles, Square, X } from 'lucide-react';
import { Button } from './ui.jsx';
import { PageSharing } from './page-sharing.jsx';
import { WorkflowOptions } from './workflow-options.jsx';
import { ModelPicker } from './model-picker.jsx';

export function ChatWelcome({ target, onPrompt, onDemo, busy }) {
  return (
    <section className="chat-welcome">
      <div className="welcome-center">
        <span className="welcome-eyebrow">YOUR BROWSER WORKSPACE</span>
        <span className="chat-spark">
          <Sparkles size={36} strokeWidth={1.3} aria-hidden="true" />
        </span>
        <h1>
          From intention
          <br />
          to verified action.
        </h1>
        <p>
          Explore a website, automate a workflow, or test what matters. Review the plan. Follow the
          evidence.
        </p>
      </div>
      <div className="suggestions" aria-label="Suggested requests">
        {[
          [
            'Explore this website',
            'Explore the shared page and identify its main workflows using visible evidence. Propose a concise plan to verify the main journey. Ask only for essential missing information.',
          ],
          [
            'Verify a user journey',
            'Test the main discoverable user journey, verify actual outcomes and show evidence for failures. Use only this shared application and preserve its current viewport.',
          ],
          [
            'Check usability and layout',
            'Check visible navigation, enabled controls, accessibility and layout at the current browser width. Do not change the viewport or submit forms.',
          ],
        ].map(([label, prompt]) => (
          <Button key={label} disabled={busy} onClick={() => onPrompt(prompt)}>
            {label}
            <ArrowUp size={15} aria-hidden="true" />
          </Button>
        ))}
      </div>
    </section>
  );
}

export function ChatComposer({
  intent,
  onIntent,
  readLinks,
  onReadLinks,
  discover,
  onDiscover,
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
          placeholder="Ask VoiceQA to explore, test, or automate…"
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
          <select
            className="intent-picker"
            aria-label="Request mode"
            value={intent}
            disabled={busy || running}
            onChange={(e) => onIntent(e.target.value)}
          >
            <option value="test">Test & automate</option>
            <option value="ask">Ask & investigate</option>
          </select>
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
              <strong>Workspace options</strong>
              <label className="option-check">
                <input
                  type="checkbox"
                  checked={discover}
                  disabled={busy || running}
                  onChange={(e) => onDiscover(e.target.checked)}
                />
                Investigate before planning
              </label>
              <label className="option-check">
                <input
                  type="checkbox"
                  checked={readLinks}
                  disabled={busy || running}
                  onChange={(e) => onReadLinks(e.target.checked)}
                />
                Read observed links on approved sites
              </label>
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
                Resize for desktop + mobile checks
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
                aria-label={intent === 'ask' ? 'Send question' : 'Send test request'}
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
            : intent === 'ask'
              ? 'Reads shared pages and approved links. No test actions are executed.'
              : 'Review the plan before running. Shift + Enter for a new line.'}
      </p>
    </div>
  );
}
