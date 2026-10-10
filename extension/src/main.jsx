import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc, subscribe, artifact } from './bridge.js';
import { VoiceRecorder, say } from './voice.js';
import './styles.css';
import { classifyCommand } from '../../shared/commands.js';
import { SpeechPlayer } from '../../shared/speech-player.js';

const terminal = (status) => !['running', 'paused', 'queued'].includes(status);
const pretty = (s) => String(s || '').replaceAll('_', ' ');
function Icon({ name, size = 18 }) {
  const paths = {
    mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    play: 'M8 4l12 8-12 8V4',
    stop: 'M6 6h12v12H6z',
    check: 'M5 12l4 4L19 6',
    target: 'M12 8v8M8 12h8M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
    arrow: 'M5 12h14M13 6l6 6-6 6',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.check} />
    </svg>
  );
}
function App() {
  const [state, setState] = useState({ connected: false });
  const [page, setPage] = useState('console');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [request, setRequest] = useState('');
  const [transcript, setTranscript] = useState('');
  const [plan, setPlan] = useState(null);
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [saved, setSaved] = useState([]);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState('Idle');
  const [speaking, setSpeaking] = useState(false);
  const [visual, setVisual] = useState(false);
  const [responsive, setResponsive] = useState(true);
  const [settings, setSettings] = useState({
    model: 'gpt-5.6-sol',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    maskSelectors: 'input[type=password], input[type=email], [data-private]',
    apiKey: '',
    ttsProvider: 'browser',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    ttsReuseMainKey: true,
    ttsApiKey: '',
  });
  const recorder = useRef(new VoiceRecorder());
  const commandRef = useRef();
  const latestRun = useRef(null);
  const generation = useRef(0);
  const settingsRef = useRef(settings);
  const speech = useRef(
    new SpeechPlayer({
      id: () => crypto.randomUUID(),
      synthesize: (text, speechId) => rpc('speech.synthesize', { text, speechId }),
      load: artifact,
      release: (artifactId) => rpc('speech.release', { artifactId }),
      cancelRequest: (speechId) => rpc('speech.cancel', { speechId }),
      browserSay: say,
      makeAudio: (url) => new Audio(url),
      createURL: (blob) => URL.createObjectURL(blob),
      revokeURL: (url) => URL.revokeObjectURL(url),
    }),
  );
  async function perform(fn) {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function speak(text) {
    recorder.current.stop(true);
    setSpeaking(true);
    void speech.current.speak(
      text,
      settingsRef.current.ttsProvider,
      () => setSpeaking(false),
      (e) => setError(`Speech failed: ${e.message}`),
    );
  }
  useEffect(
    () =>
      subscribe((m) => {
        if (m.type === 'state') {
          setState(m.state);
          if (m.state.settings) {
            settingsRef.current = {
              ...settingsRef.current,
              ...m.state.settings,
              apiKey: '',
              ttsApiKey: '',
            };
            setSettings(settingsRef.current);
          }
        }
        if (m.type === 'disconnect') {
          setState((s) => ({ ...s, connected: false }));
          setError('Connection lost. Reopen the extension panel.');
        }
        if (m.type === 'run') {
          setRun(m.run);
          setPage('run');
          if (terminal(m.run.status) && latestRun.current !== m.run.id) {
            latestRun.current = m.run.id;
            speak(
              `Test run ${pretty(m.run.status)}. ${m.run.steps.filter((s) => s.status === 'failed').length} failed checks. Open the report for evidence.`,
            );
            void refresh();
          }
        }
      }),
    [],
  );
  useEffect(() => {
    void perform(async () => {
      const result = await rpc('connect');
      settingsRef.current = {
        ...settingsRef.current,
        ...result.settings,
        apiKey: '',
        ttsApiKey: '',
      };
      setSettings(settingsRef.current);
      await refresh();
    });
    return () => {
      recorder.current.stop(true);
      speech.current.cancel();
    };
  }, []);
  async function refresh() {
    const [runs, plans] = await Promise.all([rpc('run.list'), rpc('plan.list')]);
    setHistory(runs);
    setSaved(plans);
  }
  useEffect(() => {
    if (!voiceMode || busy || speaking || !state.connected || !state.target) {
      recorder.current.stop(true);
      return;
    }
    const timer = setTimeout(
      () =>
        recorder.current.start(
          async (audio) => {
            const token = generation.current;
            setBusy(true);
            setVoiceState('Transcribing');
            try {
              const { text } = await rpc('transcribe', audio);
              if (token !== generation.current) return;
              if (!text) throw new Error('No speech was recognized');
              setTranscript(text);
              setBusy(false);
              await commandRef.current(text);
            } catch (e) {
              if (token === generation.current) setError(e.message);
            } finally {
              setBusy(false);
            }
          },
          setVoiceState,
          (e) => {
            setError(e.message);
            setVoiceMode(false);
          },
        ),
      400,
    );
    return () => clearTimeout(timer);
  }, [voiceMode, busy, speaking, state.connected, state.target, voiceState]);
  async function bind() {
    await perform(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https?:/.test(tab.url))
        throw new Error('Open the website you want to test first');
      const origin = new URL(tab.url).origin;
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (!granted) throw new Error('Site access was not granted');
      await rpc('bind', { tabId: tab.id });
      setPlan(null);
      setRun(null);
      speak(`Selected ${tab.title}. Describe the test you want to run.`);
    });
  }
  async function propose(demo = false, text = request) {
    const prompt = text.trim();
    if (!prompt && !demo) {
      setError('Describe a test first');
      return;
    }
    const token = generation.current;
    await perform(async () => {
      const p = await rpc('plan.propose', {
        request: demo ? 'Run the local demo shop fixture suite' : prompt,
        demo,
        responsive,
        visual,
      });
      if (token !== generation.current) return;
      setPlan(p);
      setPage('plan');
      const expectations = p.cases
        .flatMap((c) =>
          c.steps
            .filter((s) => s.operation === 'assert')
            .map((s) => `${c.name}: ${s.label}, expected ${s.assertion.expected}`),
        )
        .join('. ');
      speak(
        p.clarification ||
          `${p.summary}. ${expectations}. Say run these tests to confirm, or describe a revision.`,
      );
    });
  }
  async function start(selected = plan) {
    if (!selected) return;
    await perform(async () => {
      const p = await rpc('plan.confirm', { id: selected.id, version: selected.version });
      setPlan(p);
      latestRun.current = null;
      const result = await rpc('run.start', {
        planId: p.id,
        version: p.version,
        key: crypto.randomUUID(),
      });
      const r = await rpc('run.get', { id: result.runId });
      setRun(r);
      setPage('run');
    });
  }
  async function cancel() {
    generation.current++;
    setVoiceMode(false);
    recorder.current.stop(true);
    speech.current.cancel();
    setSpeaking(false);
    await perform(() => rpc('cancel'));
  }
  commandRef.current = async (text) => {
    const command = classifyCommand(text);
    if (command === 'cancel') return cancel();
    if (command === 'start') return start();
    if (command === 'resume') return perform(() => rpc('resume'));
    if (command === 'status') {
      speak(
        run
          ? `Run is ${state.paused ? 'paused' : run.status}, ${run.steps.length} recorded steps.`
          : 'No test run is active.',
      );
      return;
    }
    if (command === 'repeat') {
      speak(plan?.clarification || plan?.summary || 'Describe the test you want to run.');
      return;
    }
    if (command === 'rerun') return start(run?.plan || plan);
    const prompt = plan?.clarification ? `${plan.request}\nClarification: ${text}` : text;
    setRequest(prompt);
    return propose(false, prompt);
  };
  async function exportReport(format) {
    await perform(async () => {
      const r = await rpc('report.export', { id: run.id, format });
      const bytes = await artifact(r.artifactId);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
      link.download = r.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 3000);
    });
  }
  async function openCapture(step, diff = false) {
    await perform(async () => {
      const id = diff ? step.result.visual.diffArtifactId : step.result.capture.artifactId;
      const blob = await artifact(id);
      const url = URL.createObjectURL(new Blob([blob], { type: 'image/png' }));
      await chrome.tabs.create({ url });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  }
  const failed = run?.steps.filter((s) => s.status === 'failed').length || 0;
  const passed = run?.steps.filter((s) => s.status === 'passed').length || 0;
  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">
            <Icon name="check" size={20} />
          </span>
          <div>
            <strong>VoiceQA</strong>
            <span className="brand-note">BROWSER TESTING AGENT</span>
          </div>
        </div>
        <button className="icon-button" aria-label="Open setup" onClick={() => setPage('setup')}>
          <Icon name="settings" />
        </button>
      </header>
      <div className="connection">
        <span className={`dot ${state.connected ? 'online' : ''}`} />
        <span>{state.connected ? 'Go companion connected' : 'Companion offline'}</span>
        <span className="local-label">LOCAL</span>
      </div>
      <nav aria-label="Main navigation">
        {[
          ['console', 'Test'],
          ['plan', 'Plan'],
          ['run', 'Results'],
          ['history', 'History'],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={page === id ? 'page' : undefined}
            className={page === id ? 'selected' : ''}
            onClick={() => setPage(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <main>
        {(error || state.error) && (
          <div className="notice error" role="alert">
            {error || state.error}
          </div>
        )}
        {!state.connected && (
          <div className="card">
            <h2>Connect your local companion</h2>
            <p>Install the Go host, then reconnect. Your API key stays on this computer.</p>
            <button onClick={() => perform(() => rpc('connect'))}>Reconnect</button>
            <p className="small">Setup instructions are included in the project README.</p>
          </div>
        )}
        <section className="target-card">
          <span className="eyebrow">TEST TARGET</span>
          <div className="target-row">
            <Icon name="target" />
            <div>
              <strong>{state.target?.title || 'Choose a website tab'}</strong>
              <span>{state.target?.origin || 'The agent acts only on your selected tab.'}</span>
            </div>
          </div>
          <button
            className="secondary compact"
            disabled={busy || Boolean(state.runId) || !state.connected}
            onClick={bind}
          >
            Test this tab <Icon name="arrow" size={14} />
          </button>
        </section>
        {page === 'console' && (
          <>
            <div className="hero">
              <span className="eyebrow">SAY IT. TEST IT. VERIFY IT.</span>
              <h1>
                Your next test
                <br />
                <em>starts with a voice.</em>
              </h1>
              <p>
                Describe a workflow. Review the plan.
                <br />
                Get results backed by browser evidence.
              </p>
            </div>
            <button
              className={`voice-button ${voiceMode ? 'listening' : ''}`}
              disabled={!state.target || !state.connected}
              onClick={() => {
                if (voiceMode) {
                  setVoiceMode(false);
                  recorder.current.stop(true);
                } else {
                  setVoiceMode(true);
                  setVoiceState('Idle');
                }
              }}
            >
              <span className="mic-circle">
                <Icon name="mic" size={28} />
              </span>
              <strong>
                {voiceMode ? (speaking ? 'Speaking' : voiceState) : 'Start voice session'}
              </strong>
              <span>
                {voiceMode
                  ? 'Say “run these tests” or “cancel test”'
                  : 'Microphone permission is required once.'}
              </span>
            </button>
            {transcript && (
              <div className="transcript">
                <span className="eyebrow">YOU SAID</span>
                <p>{transcript}</p>
              </div>
            )}
            <div className="divider">
              <span>or write a test request</span>
            </div>
            <label htmlFor="request" className="sr-only">
              Test request
            </label>
            <textarea
              id="request"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder="Check that an invalid coupon is rejected and the cart total updates correctly…"
              rows={4}
            />
            <div className="options">
              <label>
                <input
                  type="checkbox"
                  checked={responsive}
                  onChange={(e) => setResponsive(e.target.checked)}
                />
                Desktop + mobile width
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={visual}
                  onChange={(e) => setVisual(e.target.checked)}
                />
                Compare approved visual baselines
              </label>
            </div>
            <button
              className="primary full"
              disabled={busy || !state.target || !state.connected}
              onClick={() => propose(false)}
            >
              {busy ? 'Working…' : 'Propose test plan'}
              <Icon name="arrow" />
            </button>
            <section className="demo-card">
              <span className="eyebrow">INTERVIEW DEMO</span>
              <h3>A real browser run, without an API key</h3>
              <p>
                Open the local demo shop and run its fixed fixture suite. The report labels it as
                deterministic.
              </p>
              <button
                className="secondary"
                disabled={busy || !state.target}
                onClick={() => propose(true)}
              >
                Load fixture plan
              </button>
            </section>
          </>
        )}
        {page === 'plan' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">REVIEW BEFORE EXECUTION</span>
              <h1>Test plan</h1>
            </div>
            {!plan ? (
              <p className="empty">Describe a test to create a plan.</p>
            ) : (
              <>
                <div className="card">
                  <span className="tag">
                    {plan.model === 'fixture-demo' ? 'FIXTURE DEMO' : 'AI PROPOSED'} · v
                    {plan.version}
                  </span>
                  <p>{plan.summary}</p>
                  <div className="meta">
                    {plan.viewports.map((v) => `${v.width} × ${v.height}`).join(' / ')} ·{' '}
                    {plan.visual ? 'Visual comparison enabled' : 'Evidence screenshots enabled'}
                  </div>
                </div>
                {plan.clarification ? (
                  <div className="notice">
                    <h3>One detail is needed</h3>
                    <p>{plan.clarification}</p>
                    <button onClick={() => setPage('console')}>Answer by voice or text</button>
                  </div>
                ) : (
                  plan.cases.map((c, index) => (
                    <article className="case-card" key={index}>
                      <span className="case-number">{String(index + 1).padStart(2, '0')}</span>
                      <div>
                        <h3>{c.name}</h3>
                        <p>{c.goal}</p>
                        <ol>
                          {c.steps.map((s, i) => (
                            <li key={i}>
                              <span>{s.label}</span>
                              {s.operation === 'assert' && (
                                <code>Expected: {s.assertion.expected}</code>
                              )}
                            </li>
                          ))}
                        </ol>
                        <span className="small">{c.source}</span>
                      </div>
                    </article>
                  ))
                )}
                <button
                  className="primary full"
                  disabled={busy || Boolean(plan.clarification) || Boolean(state.runId)}
                  onClick={() => start()}
                >
                  <Icon name="play" />
                  {busy ? 'Starting…' : 'Confirm and run tests'}
                </button>
                <p className="small">
                  You can also say “run these tests.” Completed website changes remain if you
                  cancel.
                </p>
              </>
            )}
          </>
        )}
        {page === 'run' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">INDEPENDENT CHECKS. RECORDED EVIDENCE.</span>
              <h1>Test results</h1>
            </div>
            {!run ? (
              <p className="empty">Results will appear after a run starts.</p>
            ) : (
              <>
                <div className="result-banner">
                  <span className={`status ${run.status}`}>
                    {state.paused ? 'paused' : pretty(run.status)}
                  </span>
                  <span className="small">
                    {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)} s` : 'In progress'}
                  </span>
                </div>
                <div className="stats">
                  <div>
                    <strong>{passed}</strong>
                    <span>Passed steps</span>
                  </div>
                  <div>
                    <strong>{failed}</strong>
                    <span>Failed checks</span>
                  </div>
                  <div>
                    <strong>{run.steps.length}</strong>
                    <span>Recorded</span>
                  </div>
                </div>
                {state.paused && (
                  <div className="notice">
                    <p>Return to the selected tab and resume.</p>
                    <button onClick={() => perform(() => rpc('resume'))}>Resume</button>
                  </div>
                )}
                {run.error && <div className="notice error">{run.error}</div>}
                {run.steps.map((step) => (
                  <details className="step" key={step.id} open={step.status === 'failed'}>
                    <summary>
                      <span className={`step-icon ${step.status}`}>
                        {step.status === 'passed' ? (
                          <Icon name="check" size={15} />
                        ) : step.status === 'failed' ? (
                          '!'
                        ) : (
                          '·'
                        )}
                      </span>
                      <span>
                        <strong>{step.action.label}</strong>
                        <small>
                          {step.case} · {step.viewport}
                        </small>
                      </span>
                      <span className="step-status">{pretty(step.status)}</span>
                    </summary>
                    <div className="step-body">
                      {step.error && <p className="failure-text">{step.error}</p>}
                      <pre>{JSON.stringify(step.result, null, 2)}</pre>
                      <div className="button-row">
                        {step.result?.capture && (
                          <button onClick={() => openCapture(step)}>View evidence</button>
                        )}
                        {step.result?.visual?.diffArtifactId && (
                          <button onClick={() => openCapture(step, true)}>View diff</button>
                        )}
                        {step.result?.capture &&
                          ['passed', 'needs_review'].includes(run.status) && (
                            <button
                              onClick={() =>
                                perform(async () => {
                                  await rpc('baseline.approve', { runId: run.id, stepId: step.id });
                                  setError('');
                                })
                              }
                            >
                              Approve baseline
                            </button>
                          )}
                      </div>
                    </div>
                  </details>
                ))}
                {terminal(run.status) && (
                  <>
                    <div className="button-row exports">
                      {['html', 'json', 'xml'].map((format) => (
                        <button key={format} disabled={busy} onClick={() => exportReport(format)}>
                          Export {format === 'xml' ? 'JUnit' : format.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <button
                      className="secondary full"
                      disabled={busy}
                      onClick={() => start(run.plan)}
                    >
                      Run again
                    </button>
                  </>
                )}
                <p className="small">
                  Coverage: selected tab, DOM controls, named screenshots, and automated
                  accessibility rules. Native dialogs and cross-origin frames require separate
                  tests.
                </p>
              </>
            )}
          </>
        )}
        {page === 'history' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">SAVED ON THIS COMPUTER</span>
              <h1>Run history</h1>
            </div>
            <button className="secondary" onClick={() => perform(refresh)}>
              Refresh
            </button>
            {history.map((r) => (
              <button
                className="history-item"
                key={r.id}
                onClick={() =>
                  perform(async () => {
                    setRun(await rpc('run.get', { id: r.id }));
                    setPage('run');
                  })
                }
              >
                <span className={`status ${r.status}`}>{pretty(r.status)}</span>
                <strong>{r.plan.request}</strong>
                <small>
                  {new Date(r.startedAt).toLocaleString()} · {r.plan.model}
                </small>
              </button>
            ))}
            <h2>Saved plans</h2>
            {saved.map((p) => (
              <button
                className="history-item"
                key={p.id}
                onClick={() =>
                  perform(async () => {
                    setPlan(await rpc('plan.get', { id: p.id }));
                    setPage('plan');
                  })
                }
              >
                <strong>{p.summary}</strong>
                <small>
                  {p.origin} · {p.confirmed ? 'Confirmed' : 'Draft'}
                </small>
              </button>
            ))}
          </>
        )}
        {page === 'setup' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">YOUR MODELS. YOUR KEY.</span>
              <h1>Local setup</h1>
            </div>
            <div className="card">
              <p>
                API keys are encrypted by the Go companion using Windows DPAPI. The extension never
                saves your key.
              </p>
              <span className="tag">
                {settings.hasApiKey ? 'API KEY CONFIGURED' : 'NO API KEY'}
              </span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform(async () => {
                  const s = await rpc('settings.save', settings);
                  settingsRef.current = { ...s, apiKey: '', ttsApiKey: '' };
                  setSettings(settingsRef.current);
                  speak('Settings saved.');
                });
              }}
            >
              <label>
                API key
                <input
                  type="password"
                  autoComplete="off"
                  value={settings.apiKey || ''}
                  onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                  placeholder="Leave blank to keep the current key"
                />
              </label>
              <label>
                Reasoning model
                <input
                  value={settings.model}
                  onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                />
              </label>
              <label>
                Transcription model
                <input
                  value={settings.transcriptionModel}
                  onChange={(e) => setSettings({ ...settings, transcriptionModel: e.target.value })}
                />
              </label>
              <fieldset className="speech-settings">
                <legend>Text-to-speech</legend>
                <label>
                  Speech provider
                  <select
                    value={settings.ttsProvider}
                    onChange={(e) => setSettings({ ...settings, ttsProvider: e.target.value })}
                  >
                    <option value="browser">Browser speech — no API key</option>
                    <option value="openai">OpenAI API speech</option>
                  </select>
                </label>
                {settings.ttsProvider === 'openai' && (
                  <>
                    <label>
                      Text-to-speech API key
                      <input
                        type="password"
                        autoComplete="off"
                        value={settings.ttsApiKey || ''}
                        onChange={(e) => setSettings({ ...settings, ttsApiKey: e.target.value })}
                        placeholder="Leave blank to keep the saved TTS key"
                      />
                    </label>
                    <span className="tag">
                      {settings.hasTtsApiKey
                        ? 'DEDICATED TTS KEY CONFIGURED'
                        : 'NO DEDICATED TTS KEY'}
                    </span>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={settings.ttsReuseMainKey}
                        onChange={(e) =>
                          setSettings({ ...settings, ttsReuseMainKey: e.target.checked })
                        }
                      />
                      Use the main OpenAI key when no TTS key is set
                    </label>
                    <label>
                      Text-to-speech model
                      <input
                        value={settings.ttsModel}
                        onChange={(e) => setSettings({ ...settings, ttsModel: e.target.value })}
                      />
                    </label>
                    <label>
                      Text-to-speech voice
                      <select
                        value={settings.ttsVoice}
                        onChange={(e) => setSettings({ ...settings, ttsVoice: e.target.value })}
                      >
                        {[
                          'alloy',
                          'echo',
                          'fable',
                          'onyx',
                          'nova',
                          'shimmer',
                          'ash',
                          'ballad',
                          'coral',
                          'sage',
                          'verse',
                          'marin',
                          'cedar',
                        ].map((voice) => (
                          <option key={voice} value={voice}>
                            {voice}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="small">
                      Replies use an AI-generated voice. Model and voice availability depend on your
                      API account. A dedicated TTS key takes priority.
                    </p>
                  </>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || speaking || !state.connected}
                  onClick={() => speak('Hello. VoiceQA is ready to review your test results.')}
                >
                  Test saved speech settings
                </button>
                <p className="small">
                  Save changes before testing speech. API errors are shown explicitly; the provider
                  never switches silently.
                </p>
              </fieldset>
              <label>
                Redacted CSS selectors
                <textarea
                  rows={3}
                  value={settings.maskSelectors}
                  onChange={(e) => setSettings({ ...settings, maskSelectors: e.target.value })}
                />
              </label>
              <button className="primary full" disabled={busy || !state.connected}>
                Save settings
              </button>
            </form>
            <p className="small">
              A missing or unavailable model produces an explicit error. There is no silent model
              fallback.
            </p>
          </>
        )}
      </main>
      <footer>
        <span>
          <span className={`dot ${voiceMode ? 'online' : ''}`} />
          {voiceMode ? `${speaking ? 'Speaking' : voiceState}` : 'Voice off'}
        </span>
        <button
          className="stop-button"
          disabled={!state.runId && !voiceMode && !busy && !speaking}
          onClick={cancel}
        >
          <Icon name="stop" size={14} />
          Stop
        </button>
      </footer>
      <div className="sr-only" aria-live="polite">
        {busy ? 'Working' : voiceState}. {run?.status}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
