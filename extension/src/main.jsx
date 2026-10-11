import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc, subscribe, artifact } from './bridge.js';
import { VoiceRecorder, say } from './voice.js';
import './ui.css';
import { classifyCommand } from '../../shared/commands.js';
import { SpeechPlayer } from '../../shared/speech-player.js';
import { MotionRoot, Button, Icon, EmptyState, ConnectionSetup } from './components/ui.jsx';
import { ShieldCheck, Sparkles, ScanLine, FileCheck2, History, Activity } from 'lucide-react';
import { ChatWelcome, ChatComposer } from './components/chat.jsx';
import { ArrowLeft, MessageSquarePlus, LoaderCircle } from 'lucide-react';
import './chat.css';
import { AuthSettings } from './components/auth-settings.jsx';
import { RunProgress } from './components/run-progress.jsx';

const terminal = (status) => !['running', 'paused', 'queued'].includes(status);
const pretty = (s) => String(s || '').replaceAll('_', ' ');
function App() {
  const [state, setState] = useState({ connected: false });
  const [page, setPage] = useState('console');
  const [messages, setMessages] = useState([]);
  const [drafting, setDrafting] = useState(false);
  const scroll = useRef(null);
  const follow = useRef(true);
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
    aiProvider: 'openai',
    model: 'gpt-5.6-sol',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    maskSelectors: 'input[type=password], input[type=email], [data-private]',
    apiKey: '',
    ttsProvider: 'browser',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    ttsReuseMainKey: true,
    ttsApiKey: '',
    speechApiKey: '',
    stepDelayMs: 4000,
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
  async function perform(fn, onError) {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      onError?.(e);
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
              speechApiKey: '',
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
          upsertRun(m.run);
          setPage((p) => (['setup', 'history'].includes(p) ? p : 'console'));
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
        speechApiKey: '',
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
        speechApiKey: '',
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
      if (!tab)
        throw new Error('Open a website in this Chrome window, then click Share current tab.');
      if (!tab.url)
        throw new Error(
          'Chrome could not read this tab. Reload VoiceQA at chrome://extensions, reopen the panel, and try again.',
        );
      if (!/^https?:/.test(tab.url))
        throw new Error(
          'This tab cannot be tested. Switch to a normal website (https:// or http://), then click Share current tab. Chrome settings, new tabs, and extension pages are not supported.',
        );
      const origin = new URL(tab.url).origin;
      const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      if (!granted)
        throw new Error(
          'Site access was declined. Click Share current tab again and allow access to this website.',
        );
      await rpc('bind', { tabId: tab.id });
      setPlan(null);
      setRun(null);
      setMessages([]);
      speak(`Selected ${tab.title}. Describe the test you want to run.`);
    });
  }
  async function propose(demo = false, text = request, displayText = text) {
    const prompt = text.trim();
    if (!prompt && !demo) {
      setError('Describe a test first');
      return;
    }
    const token = generation.current;
    follow.current = true;
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        kind: 'user',
        text: demo ? 'Run the local demo fixture suite.' : displayText,
      },
    ]);
    setRequest('');
    setDrafting(true);
    setPlan(null);
    await perform(
      async () => {
        const p = await rpc('plan.propose', {
          request: demo ? 'Run the local demo shop fixture suite' : prompt,
          demo,
          responsive,
          visual,
        });
        if (token !== generation.current) return;
        setPlan(p);
        setMessages((items) => [...items, { id: p.id, kind: 'plan', plan: p }]);
        setPage((p) => (['setup', 'history'].includes(p) ? p : 'console'));
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
      },
      (e) => {
        if (token === generation.current)
          setMessages((items) => [
            ...items,
            { id: crypto.randomUUID(), kind: 'error', text: e.message },
          ]);
      },
    );
    setDrafting(false);
  }
  async function start(selected = plan) {
    if (!selected) return;
    follow.current = true;
    await perform(async () => {
      const p = await rpc('plan.confirm', { id: selected.id, version: selected.version });
      setPlan(p);
      setMessages((items) =>
        items.map((m) => (m.kind === 'plan' && m.plan.id === p.id ? { ...m, plan: p } : m)),
      );
      latestRun.current = null;
      const result = await rpc('run.start', {
        planId: p.id,
        version: p.version,
        key: crypto.randomUUID(),
      });
      const r = await rpc('run.get', { id: result.runId });
      setRun(r);
      upsertRun(r);
      setPage('console');
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
    return propose(false, prompt, text);
  };
  async function exportReport(format, record = run) {
    await perform(async () => {
      const r = await rpc('report.export', { id: record.id, format });
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
  function upsertRun(record) {
    setMessages((items) => {
      const found = items.some((m) => m.kind === 'run' && m.run.id === record.id);
      return found
        ? items.map((m) => (m.kind === 'run' && m.run.id === record.id ? { ...m, run: record } : m))
        : [...items, { id: record.id, kind: 'run', run: record }];
    });
  }
  function newChat() {
    generation.current++;
    recorder.current.stop(true);
    speech.current.cancel();
    setVoiceMode(false);
    setSpeaking(false);
    setRequest('');
    setPlan(null);
    setRun(null);
    setMessages([]);
    setError('');
    setPage('console');
    follow.current = true;
  }
  async function unshare() {
    await perform(async () => {
      await rpc('unbind');
      newChat();
    });
  }
  async function sharePage(tabId) {
    await perform(async () => {
      const tab = await chrome.tabs.get(tabId);
      const origin = new URL(tab.url).origin;
      const access = { origins: [origin + '/*'] };
      if (
        !(await chrome.permissions.contains(access)) &&
        !(await chrome.permissions.request(access))
      )
        throw new Error('Additional site access was not granted.');
      await rpc('pages.share', { tabId });
      setPlan(null);
      setRun(null);
      setMessages([]);
    });
  }
  async function focusTarget() {
    await perform(async () => {
      await chrome.tabs.update(state.target.tabId, { active: true });
      await chrome.windows.update(state.target.windowId, { focused: true });
    });
  }
  useEffect(() => {
    if (!follow.current || !scroll.current || ['setup', 'history'].includes(page)) return;
    const progress = scroll.current.querySelector('[aria-label="Live test progress"]');
    const checkpoint = scroll.current.querySelector('.handoff-card');
    const planMessage = scroll.current.querySelector(
      '.assistant-message[data-kind="plan"]:last-child',
    );
    const runMessage = scroll.current.querySelector(
      '.assistant-message[data-kind="run"]:last-child',
    );
    if (checkpoint) {
      scroll.current.scrollTop +=
        checkpoint.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 8;
    } else if (progress) {
      scroll.current.scrollTop +=
        progress.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 8;
    } else if (planMessage) {
      scroll.current.scrollTop +=
        planMessage.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 8;
    } else if (runMessage) {
      scroll.current.scrollTop +=
        runMessage.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 8;
    } else scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, drafting, page]);
  useEffect(() => {
    if (['setup', 'history'].includes(page) && scroll.current) scroll.current.scrollTop = 0;
  }, [page]);
  function renderPlan(plan) {
    return (
      <>
        <div className="section-heading">
          <span className="eyebrow">REVIEW BEFORE EXECUTION</span>
          <h2>Test plan</h2>
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
                {plan.model === 'fixture-demo' ? 'FIXTURE DEMO' : 'AI PROPOSED'} · v{plan.version}
              </span>
              <p>{plan.summary}</p>
              <div className="meta">
                {plan.pages?.length > 1 && <span>{plan.pages.length} approved pages · </span>}
                {plan.viewports.map((v) => `${v.width} × ${v.height}`).join(' / ')} ·{' '}
                {plan.visual ? 'Visual comparison enabled' : 'Evidence screenshots enabled'}
              </div>
            </div>
            {plan.clarification ? (
              <div className="notice">
                <h3>One detail is needed</h3>
                <p>{plan.clarification}</p>
                <Button
                  onClick={() => {
                    setPlan(plan);
                    setPage('console');
                    document.getElementById('request')?.focus();
                  }}
                >
                  Answer by voice or text
                </Button>
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
            <Button
              className="primary full"
              disabled={
                busy ||
                Boolean(plan.clarification) ||
                Boolean(state.runId) ||
                state.target?.origin !== plan.origin
              }
              onClick={() => start(plan)}
            >
              <Icon name="play" />
              {busy ? 'Starting…' : 'Confirm and run tests'}
            </Button>
            <p className="small">
              You can also say “run these tests.” Completed website changes remain if you cancel.
            </p>
          </>
        )}
      </>
    );
  }
  function renderRun(run) {
    const failed = run.steps.filter((s) => s.status === 'failed').length;
    const passed = run.steps.filter((s) => s.status === 'passed').length;
    return (
      <>
        <div className="section-heading">
          <span className="eyebrow">INDEPENDENT CHECKS. RECORDED EVIDENCE.</span>
          <h2>Test results</h2>
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
                {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)} s` : 'In progress'}
              </span>
            </div>
            {run.handoff && (
              <div className="handoff-card" role="status">
                <h3>Complete {run.handoff.kind} to continue</h3>
                <p>{run.handoff.label}</p>
                <p className="small">
                  Complete it on the website, then continue. The next assertion verifies the
                  outcome.
                </p>
                <Button
                  className="primary full"
                  onClick={() => perform(() => rpc('handoff.complete', { id: run.handoff.id }))}
                >
                  I completed the checkpoint
                </Button>
              </div>
            )}
            <RunProgress run={run} paused={state.paused} />
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
            {(terminal(run.status) ? run.steps : run.steps.slice(-2)).map((step) => (
              <details
                className="step"
                key={step.id}
                open={['failed', 'dispatched'].includes(step.status)}
              >
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
                      {step.case} · {step.page || 'main'} · {step.viewport}
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
                    {step.result?.capture && ['passed', 'needs_review'].includes(run.status) && (
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
                    <Button key={format} disabled={busy} onClick={() => exportReport(format, run)}>
                      Export {format === 'xml' ? 'JUnit' : format.toUpperCase()}
                    </Button>
                  ))}
                </div>
                <Button
                  className="secondary full"
                  disabled={
                    busy || Boolean(state.runId) || state.target?.origin !== run.plan.origin
                  }
                  onClick={() => start(run.plan)}
                >
                  Run again
                </Button>
              </>
            )}
            <p className="small">
              Coverage: selected tab, DOM controls, named screenshots, and automated accessibility
              rules. Native dialogs and cross-origin frames require separate tests.
            </p>
          </>
        )}
      </>
    );
  }
  function renderHistory() {
    return (
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
                const record = await rpc('run.get', { id: r.id });
                setRun(record);
                setPlan(null);
                setMessages([
                  { id: crypto.randomUUID(), kind: 'user', text: record.plan.request },
                  { id: record.id, kind: 'run', run: record },
                ]);
                setPage('console');
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
                const record = await rpc('plan.get', { id: p.id });
                setPlan(record);
                setRun(null);
                setMessages([
                  { id: crypto.randomUUID(), kind: 'user', text: record.request },
                  { id: record.id, kind: 'plan', plan: record },
                ]);
                setPage('console');
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
    );
  }
  function renderSettings() {
    return (
      <>
        <div className="section-heading">
          <span className="eyebrow">
            <ShieldCheck size={13} aria-hidden="true" />
            YOUR MODELS. YOUR KEYS.
          </span>
          <h1>Settings</h1>
        </div>
        <div className="card settings-security">
          <p>
            Your saved API keys are encrypted on this computer. Each provider uses its own
            credentials.
          </p>
          <span className="tag">{settings.hasApiKey ? 'API KEY CONFIGURED' : 'NO API KEY'}</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const s = await rpc('settings.save', settings);
              settingsRef.current = { ...s, apiKey: '', ttsApiKey: '', speechApiKey: '' };
              setSettings(settingsRef.current);
              speak('Settings saved.');
            });
          }}
        >
          <fieldset
            className="settings-fields"
            disabled={!state.connected || Boolean(state.runId) || drafting}
          >
            <label>
              AI provider
              <select
                value={settings.aiProvider || 'openai'}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    aiProvider: e.target.value,
                    apiKey: '',
                    hasApiKey: false,
                    model: e.target.value === 'openrouter' ? 'openai/gpt-4o' : 'gpt-5.6-sol',
                  })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </label>
            <label>
              {settings.aiProvider === 'openrouter' ? 'OpenRouter API key' : 'OpenAI API key'}
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
            {settings.aiProvider === 'openrouter' && (
              <p className="muted">
                Use a full OpenRouter model ID with structured-output support. Your saved OpenRouter
                key is used only for planning and UI reasoning.
              </p>
            )}
            <label>
              OpenAI speech API key (optional)
              <input
                type="password"
                autoComplete="off"
                value={settings.speechApiKey || ''}
                onChange={(e) => setSettings({ ...settings, speechApiKey: e.target.value })}
                placeholder="For microphone transcription; blank keeps saved key"
              />
            </label>
            <p className="muted">
              Microphone transcription uses OpenAI and needs an OpenAI key. Typed tests and browser
              speech work with OpenRouter alone.
            </p>
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
              <Button
                type="button"
                className="secondary"
                disabled={busy || speaking || !state.connected}
                onClick={() => speak('Hello. VoiceQA is ready to review your test results.')}
              >
                Test saved speech settings
              </Button>
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
            <Button
              type="submit"
              className="primary full glow-button"
              busy={busy}
              disabled={!state.connected}
            >
              Save settings
            </Button>
          </fieldset>
        </form>
        <AuthSettings
          connected={state.connected}
          running={Boolean(state.runId) || drafting}
          origin={state.pages?.main?.origin || state.target?.origin}
          rpc={rpc}
          perform={perform}
        />
        <p className="small">
          A missing or unavailable model produces an explicit error. There is no silent model
          fallback.
        </p>
      </>
    );
  }
  const chat = !['setup', 'history'].includes(page);
  const active = Boolean(state.runId);
  const status = state.connected
    ? active
      ? state.paused
        ? 'Paused'
        : run?.nextStep
          ? 'Waiting between steps…'
          : 'Running tests…'
      : speaking
        ? 'Speaking…'
        : busy
          ? 'Working…'
          : 'Engine connected'
    : 'Engine offline';
  return (
    <div className={`app chat-shell ${chat ? 'chat-mode' : 'utility-mode'}`}>
      <header className="chat-header">
        <div className="chat-brand">
          {!chat && (
            <Button
              className="header-icon"
              aria-label="Back to chat"
              onClick={() => setPage('console')}
            >
              <ArrowLeft size={19} />
            </Button>
          )}
          <span className="mini-mark">
            <ScanLine size={21} aria-hidden="true" />
          </span>
          <strong>VoiceQA</strong>
          <span className={`engine-dot ${state.connected ? 'connected' : ''}`} title={status}>
            <span className="sr-only">
              {state.connected ? 'Engine connected' : 'Engine offline'}
            </span>
          </span>
        </div>
        <nav aria-label="Conversation actions" className="header-actions">
          <Button
            className="header-icon"
            aria-label="New chat"
            title="New chat"
            disabled={busy || active}
            onClick={newChat}
          >
            <MessageSquarePlus size={19} />
          </Button>
          <Button
            className="header-icon"
            aria-label="History"
            title="History"
            disabled={!state.connected || busy || active}
            onClick={() => {
              setPage('history');
              void perform(refresh);
            }}
          >
            <History size={19} />
          </Button>
          <Button
            className="header-icon"
            aria-label="Open settings"
            title="API and voice settings"
            onClick={() => setPage('setup')}
          >
            <Icon name="settings" size={20} />
          </Button>
        </nav>
      </header>
      <main
        ref={scroll}
        className={chat ? 'conversation' : 'utility-content'}
        onScroll={(e) => {
          follow.current =
            e.currentTarget.scrollHeight -
              e.currentTarget.scrollTop -
              e.currentTarget.clientHeight <
            100;
        }}
      >
        {(error || state.error) &&
          state.connected &&
          !(
            chat &&
            messages.at(-1)?.kind === 'error' &&
            messages.at(-1).text === (error || state.error)
          ) && (
            <div className="notice error" role="alert">
              {error || state.error}
            </div>
          )}
        {!state.connected && (
          <ConnectionSetup
            busy={busy}
            error={error || state.error}
            onConnect={reconnect}
            extensionId={chrome.runtime.id}
          />
        )}
        {chat && state.connected && (
          <>
            {messages.length === 0 ? (
              <ChatWelcome
                target={state.target}
                busy={busy}
                onPrompt={(text) => {
                  setRequest(text);
                  document.getElementById('request')?.focus();
                }}
                onDemo={() => (state.target ? propose(true) : bind())}
              />
            ) : (
              <div className="chat-thread">
                {messages.map((message) =>
                  message.kind === 'user' ? (
                    <div className="user-message" key={message.id}>
                      <p>{message.text}</p>
                    </div>
                  ) : (
                    <article
                      className="assistant-message"
                      data-kind={message.kind}
                      key={message.id}
                    >
                      <div className="assistant-label">
                        <Sparkles size={16} aria-hidden="true" />
                        <span>VoiceQA</span>
                      </div>
                      {message.kind === 'plan' ? (
                        renderPlan(message.plan)
                      ) : message.kind === 'run' ? (
                        renderRun(message.run)
                      ) : (
                        <p role={message.kind === 'error' ? 'alert' : undefined}>{message.text}</p>
                      )}
                    </article>
                  ),
                )}
              </div>
            )}
            {drafting && (
              <div className="thinking-message" role="status">
                <LoaderCircle className="spinner" size={16} aria-hidden="true" />
                Reading the page and building your plan…
              </div>
            )}
          </>
        )}
        {page === 'history' && state.connected && renderHistory()}
        {page === 'setup' && renderSettings()}
      </main>
      {chat && (
        <ChatComposer
          pages={Object.values(state.pages || {}).filter((p) => !p.owned)}
          onSharePage={sharePage}
          onRemovePage={(alias) =>
            perform(async () => {
              await rpc('pages.remove', { alias });
              setPlan(null);
              setRun(null);
              setMessages([]);
            })
          }
          request={request}
          onChange={setRequest}
          onSend={() => commandRef.current(request)}
          target={state.target}
          onShare={bind}
          onUnshare={unshare}
          onFocusTarget={focusTarget}
          connected={state.connected}
          busy={busy}
          drafting={drafting}
          running={active}
          speaking={speaking}
          hasKey={Boolean(state.settings?.hasApiKey)}
          canVoice={Boolean(
            state.target &&
            state.connected &&
            state.settings?.hasApiKey &&
            state.settings?.hasSpeechApiKey,
          )}
          voiceMode={voiceMode}
          voiceState={voiceState}
          onVoice={() => {
            if (voiceMode) {
              setVoiceMode(false);
              recorder.current.stop(true);
            } else {
              setVoiceMode(true);
              setVoiceState('Idle');
            }
          }}
          onStop={cancel}
          onSettings={() => setPage('setup')}
          settings={settings}
          onPace={(stepDelayMs) => perform(() => rpc('settings.save', { stepDelayMs }))}
          responsive={responsive}
          onResponsive={setResponsive}
          visual={visual}
          onVisual={setVisual}
        />
      )}
      {!chat && (
        <div className="utility-status">
          <span>{status}</span>
          {(active || speaking || voiceMode || busy) && (
            <Button className="stop-button" onClick={cancel}>
              Stop
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <MotionRoot>
    <App />
  </MotionRoot>,
);
