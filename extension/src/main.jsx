import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc, subscribe, artifact } from './bridge.js';
import { VoiceRecorder, say } from './voice.js';
import './ui.css';
import { classifyCommand } from '../../shared/commands.js';
import { SpeechPlayer } from '../../shared/speech-player.js';
import {
  MotionRoot,
  Button,
  Icon,
  PageTransition,
  EmptyState,
  SetupProgress,
  ConnectionSetup,
} from './components/ui.jsx';
import { m } from 'motion/react';
import { ShieldCheck, Sparkles, ScanLine, FileCheck2, History, Activity } from 'lucide-react';

const terminal = (status) => !['running', 'paused', 'queued'].includes(status);
const pretty = (s) => String(s || '').replaceAll('_', ' ');
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
          if (!m.state.connected) {
            speech.current.cancel();
            recorder.current.stop(true);
            setSpeaking(false);
            setVoiceMode(false);
          }
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
          speech.current.cancel();
          recorder.current.stop(true);
          setSpeaking(false);
          setVoiceMode(false);
          setState((s) => ({ ...s, connected: false }));
          setError('Connection interrupted. Choose Retry connection to open a fresh session.');
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
  async function reconnect() {
    await perform(async () => {
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
      if (!tab) throw new Error('Open a website in this Chrome window, then click Test this tab.');
      if (!tab.url)
        throw new Error(
          'Chrome could not read this tab. Reload VoiceQA at chrome://extensions, reopen the panel, and try again.',
        );
      if (!/^https?:/.test(tab.url))
        throw new Error(
          'This tab cannot be tested. Switch to a normal website (https:// or http://), then click Test this tab. Chrome settings, new tabs, and extension pages are not supported.',
        );
      const origin = new URL(tab.url).origin;
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (!granted)
        throw new Error(
          'Site access was declined. Click Test this tab again and allow access to this website.',
        );
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
            <ScanLine size={22} strokeWidth={2} aria-hidden="true" />
          </span>
          <div>
            <strong>VoiceQA</strong>
            <span className="brand-note">YOUR BROWSER. VERIFIED.</span>
          </div>
        </div>
        <Button
          className="icon-button"
          aria-label="Open setup"
          title={
            state.connected
              ? 'API keys and speech settings'
              : 'Connect the engine first to save API keys'
          }
          disabled={!state.connected}
          onClick={() => setPage('setup')}
        >
          <Icon name="settings" />
        </Button>
      </header>
      <div className="connection">
        <span className={`dot ${state.connected ? 'online' : ''}`} />
        <span>
          {state.connected ? 'Engine connected' : busy ? 'Connecting to engine…' : 'Engine offline'}
        </span>
        <span className="local-label">
          <ShieldCheck size={12} aria-hidden="true" />
          LOCAL & PRIVATE
        </span>
      </div>
      <nav aria-label="Main navigation">
        {[
          ['console', 'Test'],
          ['plan', 'Plan'],
          ['run', 'Results'],
          ['history', 'History'],
        ].map(([id, label]) => (
          <Button
            key={id}
            aria-current={page === id ? 'page' : undefined}
            className={page === id ? 'selected' : ''}
            disabled={!state.connected && id !== 'console'}
            title={
              !state.connected && id !== 'console'
                ? 'Connect the engine to open this view'
                : undefined
            }
            onClick={() => setPage(id)}
          >
            <Icon name={id === 'run' ? 'results' : id} size={16} />
            {label}
            {page === id && <m.span className="nav-indicator" layoutId="active-tab" />}
          </Button>
        ))}
      </nav>
      <main>
        {(error || state.error) && state.connected && (
          <div className="notice error" role="alert">
            {error || state.error}
          </div>
        )}
        {!state.connected ? (
          <ConnectionSetup
            busy={busy}
            error={error || state.error}
            onConnect={reconnect}
            extensionId={chrome.runtime.id}
          />
        ) : (
          <>
            {['console', 'plan'].includes(page) && (
              <SetupProgress connected={state.connected} target={state.target} plan={plan} />
            )}
            {['console', 'plan'].includes(page) && (
              <section className={`target-card ${state.target ? 'has-target' : ''}`}>
                <span className="eyebrow">
                  {state.target ? 'CONNECTED WEBSITE' : 'STEP 2 · SELECT YOUR WEBSITE'}
                </span>
                <div className="target-row">
                  <Icon name="target" />
                  <div>
                    <strong>{state.target?.title || 'Which website are we testing?'}</strong>
                    <span>
                      {state.target?.origin || 'Open it in Chrome, then select this tab below.'}
                    </span>
                  </div>
                </div>
                <Button
                  className="secondary compact"
                  busy={busy}
                  disabled={busy || Boolean(state.runId) || !state.connected}
                  onClick={bind}
                >
                  Test this tab <Icon name="arrow" size={14} />
                </Button>
              </section>
            )}
            <PageTransition page={page}>
              {page === 'console' && (
                <>
                  <div className="hero">
                    <span className="eyebrow">
                      <Sparkles size={13} aria-hidden="true" />
                      VOICE-POWERED QUALITY ASSURANCE
                    </span>
                    <h1>
                      Test with
                      <br />
                      <em>confidence.</em>
                    </h1>
                    <p>
                      Say what should work. Your agent checks it,
                      <br />
                      and shows you the evidence.
                    </p>
                  </div>
                  <Button
                    className={`voice-button ${voiceMode ? 'listening' : ''}`}
                    disabled={!state.target || !state.connected || !state.settings?.hasApiKey}
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
                      <span className="voice-ring" aria-hidden="true" />
                      <Icon name="mic" size={28} />
                    </span>
                    <strong>
                      {voiceMode ? (speaking ? 'Speaking' : voiceState) : 'Start voice session'}
                    </strong>
                    <span>
                      {voiceMode
                        ? 'Say “run these tests” or “cancel test”'
                        : !state.target
                          ? 'Select a website to begin'
                          : !state.settings?.hasApiKey
                            ? 'Add your AI key to enable voice'
                            : 'Speak naturally. We’ll handle the clicks.'}
                    </span>
                    <span
                      className={`voice-bars ${voiceMode && !speaking ? 'active' : ''}`}
                      aria-hidden="true"
                    >
                      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                        <span key={i} style={{ '--bar-delay': `${i * 0.1}s` }} />
                      ))}
                    </span>
                  </Button>
                  {transcript && (
                    <div className="transcript">
                      <span className="eyebrow">YOU SAID</span>
                      <p>{transcript}</p>
                    </div>
                  )}
                  {!state.settings?.hasApiKey && (
                    <div className="key-callout">
                      <span className="key-callout-icon">
                        <Sparkles size={18} />
                      </span>
                      <div>
                        <strong>Unlock your AI agent</strong>
                        <p>
                          Add your API key for voice and custom tests, or try the free fixture demo
                          below.
                        </p>
                      </div>
                      <Button className="text-button" onClick={() => setPage('setup')}>
                        Add key
                        <Icon name="arrow" size={14} />
                      </Button>
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
                  <Button
                    className="primary full glow-button"
                    busy={busy}
                    disabled={!state.target || !state.connected || !state.settings?.hasApiKey}
                    onClick={() => propose(false)}
                  >
                    {busy ? 'Building your plan…' : 'Propose test plan'}
                    <Icon name="arrow" />
                  </Button>
                  <section className="demo-card">
                    <span className="eyebrow">
                      <FileCheck2 size={13} aria-hidden="true" />
                      TRY IT FIRST
                    </span>
                    <h3>See your agent in action.</h3>
                    <p>
                      Open the local demo shop and run its fixed fixture suite. The report labels it
                      as deterministic.
                    </p>
                    <Button
                      className="secondary"
                      disabled={busy || !state.target}
                      onClick={() => propose(true)}
                    >
                      Load fixture plan
                    </Button>
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
                    <EmptyState
                      icon={FileCheck2}
                      title="Your plan starts here"
                      description="Describe what should work. We’ll turn it into steps you can review before execution."
                      action="Create a test"
                      onAction={() => setPage('console')}
                    />
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
                          {plan.visual
                            ? 'Visual comparison enabled'
                            : 'Evidence screenshots enabled'}
                        </div>
                      </div>
                      {plan.clarification ? (
                        <div className="notice">
                          <h3>One detail is needed</h3>
                          <p>{plan.clarification}</p>
                          <Button onClick={() => setPage('console')}>
                            Answer by voice or text
                          </Button>
                        </div>
                      ) : (
                        plan.cases.map((c, index) => (
                          <m.article
                            className="case-card"
                            key={index}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.04 }}
                          >
                            <span className="case-number">
                              {String(index + 1).padStart(2, '0')}
                            </span>
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
                          </m.article>
                        ))
                      )}
                      <Button
                        className="primary full"
                        disabled={busy || Boolean(plan.clarification) || Boolean(state.runId)}
                        onClick={() => start()}
                      >
                        <Icon name="play" />
                        {busy ? 'Starting…' : 'Confirm and run tests'}
                      </Button>
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
                    <EmptyState
                      icon={Activity}
                      title="Evidence, not guesswork"
                      description="Your next run will appear here with checks, screenshots, and a clear verdict."
                      action="Start a test"
                      onAction={() => setPage('console')}
                    />
                  ) : (
                    <>
                      <div className="result-banner">
                        <span className={`status ${run.status}`}>
                          {state.paused ? 'paused' : pretty(run.status)}
                        </span>
                        <span className="small">
                          {run.durationMs
                            ? `${(run.durationMs / 1000).toFixed(1)} s`
                            : 'In progress'}
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
                          <Button onClick={() => perform(() => rpc('resume'))}>Resume</Button>
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
                            {step.result?.expected !== undefined && (
                              <div className="check-comparison">
                                <div>
                                  <span>Expected</span>
                                  <strong>{String(step.result.expected)}</strong>
                                </div>
                                <div>
                                  <span>Observed</span>
                                  <strong>{String(step.result.actual ?? 'No observation')}</strong>
                                </div>
                              </div>
                            )}
                            {step.result?.seriousCount !== undefined && (
                              <p className="scan-summary">
                                {step.result.seriousCount === 0
                                  ? 'No serious accessibility issues found.'
                                  : `${step.result.seriousCount} serious accessibility issues found.`}
                              </p>
                            )}
                            <details className="technical-details">
                              <summary>Technical evidence</summary>
                              <pre>{JSON.stringify(step.result, null, 2)}</pre>
                            </details>
                            <div className="button-row">
                              {step.result?.capture && (
                                <Button onClick={() => openCapture(step)}>View evidence</Button>
                              )}
                              {step.result?.visual?.diffArtifactId && (
                                <Button onClick={() => openCapture(step, true)}>View diff</Button>
                              )}
                              {step.result?.capture &&
                                ['passed', 'needs_review'].includes(run.status) && (
                                  <Button
                                    onClick={() =>
                                      perform(async () => {
                                        await rpc('baseline.approve', {
                                          runId: run.id,
                                          stepId: step.id,
                                        });
                                        setError('');
                                      })
                                    }
                                  >
                                    Approve baseline
                                  </Button>
                                )}
                            </div>
                          </div>
                        </details>
                      ))}
                      {terminal(run.status) && (
                        <>
                          <div className="button-row exports">
                            {['html', 'json', 'xml'].map((format) => (
                              <Button
                                key={format}
                                disabled={busy}
                                onClick={() => exportReport(format)}
                              >
                                Export {format === 'xml' ? 'JUnit' : format.toUpperCase()}
                              </Button>
                            ))}
                          </div>
                          <Button
                            className="secondary full"
                            disabled={busy}
                            onClick={() => start(run.plan)}
                          >
                            Run again
                          </Button>
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
                  <Button className="secondary" onClick={() => perform(refresh)}>
                    Refresh
                  </Button>
                  {history.length === 0 && (
                    <EmptyState
                      icon={History}
                      title="A clean slate"
                      description="Your completed runs will live here. Start a test to build your history."
                      action="Start your first test"
                      onAction={() => setPage('console')}
                    />
                  )}
                  {history.map((r) => (
                    <Button
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
                    </Button>
                  ))}
                  {saved.length > 0 && <h2 className="saved-heading">Saved plans</h2>}
                  {saved.map((p) => (
                    <Button
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
                    </Button>
                  ))}
                </>
              )}
              {page === 'setup' && (
                <>
                  <div className="section-heading">
                    <span className="eyebrow">
                      <ShieldCheck size={13} aria-hidden="true" />
                      YOUR MODELS. YOUR KEYS.
                    </span>
                    <h1>Local setup</h1>
                  </div>
                  <div className="card settings-security">
                    <p>
                      API keys are encrypted by the Go companion using Windows DPAPI. The extension
                      never saves your key.
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
                        onChange={(e) =>
                          setSettings({ ...settings, transcriptionModel: e.target.value })
                        }
                      />
                    </label>
                    <fieldset className="speech-settings">
                      <legend>Text-to-speech</legend>
                      <label>
                        Speech provider
                        <select
                          value={settings.ttsProvider}
                          onChange={(e) =>
                            setSettings({ ...settings, ttsProvider: e.target.value })
                          }
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
                              onChange={(e) =>
                                setSettings({ ...settings, ttsApiKey: e.target.value })
                              }
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
                              onChange={(e) =>
                                setSettings({ ...settings, ttsModel: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            Text-to-speech voice
                            <select
                              value={settings.ttsVoice}
                              onChange={(e) =>
                                setSettings({ ...settings, ttsVoice: e.target.value })
                              }
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
                            Replies use an AI-generated voice. Model and voice availability depend
                            on your API account. A dedicated TTS key takes priority.
                          </p>
                        </>
                      )}
                      <Button
                        type="button"
                        className="secondary"
                        disabled={busy || speaking || !state.connected}
                        onClick={() =>
                          speak('Hello. VoiceQA is ready to review your test results.')
                        }
                      >
                        Test saved speech settings
                      </Button>
                      <p className="small">
                        Save changes before testing speech. API errors are shown explicitly; the
                        provider never switches silently.
                      </p>
                    </fieldset>
                    <label>
                      Redacted CSS selectors
                      <textarea
                        rows={3}
                        value={settings.maskSelectors}
                        onChange={(e) =>
                          setSettings({ ...settings, maskSelectors: e.target.value })
                        }
                      />
                    </label>
                    <Button
                      type="submit"
                      className="primary full glow-button"
                      busy={busy}
                      disabled={!state.connected}
                    >
                      Save settings
                    </Button>
                  </form>
                  <p className="small">
                    A missing or unavailable model produces an explicit error. There is no silent
                    model fallback.
                  </p>
                </>
              )}
            </PageTransition>
          </>
        )}
      </main>
      <footer>
        <span>
          <span className={`dot ${voiceMode ? 'online' : ''}`} />
          {speaking
            ? 'Speaking…'
            : voiceMode
              ? voiceState
              : busy
                ? 'Working…'
                : state.connected
                  ? 'Ready when you are'
                  : 'Waiting for engine'}
        </span>
        <Button
          className="stop-button"
          disabled={!state.runId && !voiceMode && !busy && !speaking}
          onClick={cancel}
        >
          <Icon name="stop" size={14} />
          Stop
        </Button>
      </footer>
      <div className="sr-only" aria-live="polite">
        {busy ? 'Working' : voiceState}. {run?.status}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')).render(
  <MotionRoot>
    <App />
  </MotionRoot>,
);
