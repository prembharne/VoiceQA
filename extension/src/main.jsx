import { runCounts } from '../run-counts.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc, subscribe, artifact } from './bridge.js';
import { Dictation } from '../../shared/dictation.js';
import { APISettings } from './components/api-settings.jsx';
import './ui.css';
import { classifyCommand } from '../../shared/commands.js';
import { MotionRoot, Button, Icon, EmptyState, ConnectionSetup } from './components/ui.jsx';
import { ShieldCheck, Sparkles, ScanLine, FileCheck2, History, Activity } from 'lucide-react';
import { ChatWelcome, ChatComposer } from './components/chat.jsx';
import { ArrowLeft, MessageSquarePlus, LoaderCircle } from 'lucide-react';
import './chat.css';
import { AuthSettings } from './components/auth-settings.jsx';
import { RunProgress } from './components/run-progress.jsx';
import { PlanningStatus } from './components/planning-status.jsx';
import { parseTestData } from './components/workflow-options.jsx';

const terminal = (status) => !['running', 'paused', 'queued'].includes(status);
const pretty = (s) => String(s || '').replaceAll('_', ' ');
function App() {
  const [state, setState] = useState({ connected: false });
  const [page, setPage] = useState('console');
  const [messages, setMessages] = useState([]);
  const [drafting, setDrafting] = useState(false);
  const [intent, setIntent] = useState('test');
  const [recordContext, setRecordContext] = useState(null);
  const [workspace, setWorkspace] = useState('qa');
  const [allowConsequential, setAllowConsequential] = useState(false);
  const [readLinks, setReadLinks] = useState(true);
  const [discover, setDiscover] = useState(true);
  const scroll = useRef(null);
  const follow = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [request, setRequest] = useState('');
  const [plan, setPlan] = useState(null);
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [saved, setSaved] = useState([]);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState('Idle');
  const [visual, setVisual] = useState(false);
  const [responsive, setResponsive] = useState(false);
  const [mode, setMode] = useState('qa');
  const [authorized, setAuthorized] = useState(false);
  const [apiWrites, setAPIWrites] = useState(false);
  const [testData, setTestData] = useState('');
  const [compareBefore, setCompareBefore] = useState('');
  const [compareAfter, setCompareAfter] = useState('');
  const [comparison, setComparison] = useState(null);
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
  const recorder = useRef(new Dictation());
  const commandRef = useRef();
  const latestRun = useRef(null);
  const generation = useRef(0);
  const settingsRef = useRef(settings);
  async function perform(fn, onError, isCurrent = () => true) {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      if (isCurrent()) {
        setError(e.message);
        onError?.(e);
      }
      return null;
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  function respond(text) {
    setMessages((items) => [...items, { id: crypto.randomUUID(), kind: 'text', text }]);
  }
  useEffect(
    () =>
      subscribe((m) => {
        if (m.type === 'state') {
          setState(m.state);
          if (!m.state.connected) {
            recorder.current.stop(true);

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
          recorder.current.stop(true);

          setVoiceMode(false);
          setState((s) => ({ ...s, connected: false }));
          setError('Connection interrupted. Choose Retry connection to open a fresh session.');
        }
        if (m.type === 'run') {
          setRun(m.run);
          upsertRun(m.run);
          setPage((p) => (['setup', 'history', 'credentials'].includes(p) ? p : 'console'));
          if (terminal(m.run.status) && latestRun.current !== m.run.id) {
            latestRun.current = m.run.id;
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
    if (['setup', 'history', 'credentials'].includes(page)) {
      recorder.current.stop(true);
      setVoiceMode(false);
    }
  }, [page]);
  function toggleDictation() {
    if (voiceMode) {
      recorder.current.stop(false);
      return;
    }

    setError('');
    const token = generation.current;
    const prefix = request.trimEnd();
    recorder.current.start(
      (text) => {
        if (token === generation.current)
          setRequest((prefix + (prefix && text ? ' ' : '') + text).slice(0, 8000));
      },
      (status) => {
        if (token === generation.current) {
          setVoiceState(status);
          setVoiceMode(status !== 'Idle');
        }
      },
      (error) => {
        if (token === generation.current) {
          setError(error.message);
          setVoiceMode(false);
        }
      },
    );
  }
  async function saveModel(model) {
    return perform(async () => {
      const saved = await rpc('settings.save', { model });
      settingsRef.current = { ...saved, apiKey: '', ttsApiKey: '', speechApiKey: '' };
      setSettings(settingsRef.current);
      return saved;
    });
  }
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
      setAuthorized(false);
      setAPIWrites(false);
      setPlan(null);
      setRun(null);
      setMessages([]);
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
        if (workspace === 'qa' && intent !== 'ask' && mode === 'security' && !authorized)
          throw new Error(
            'Confirm that you are authorized to test the shared systems in Test options.',
          );
        const p = await rpc(
          !demo && intent === 'ask'
            ? 'agent.query'
            : !demo && workspace === 'automation'
              ? 'automation.propose'
              : 'plan.propose',
          {
            request: demo ? 'Run the local demo fixture suite' : prompt,
            runId: !demo && intent === 'ask' ? recordContext?.id : undefined,
            conversation: messages
              .filter((m) => ['user', 'plan', 'text', 'answer'].includes(m.kind))
              .slice(-6)
              .map((m) => ({
                role: m.kind === 'user' ? 'user' : 'assistant',
                text: String(m.text || m.plan?.summary || '').slice(0, 2000),
              })),
            demo,
            readLinks,
            allowConsequential,
            maxActions: 60,
            discover,
            responsive,
            visual,
            mode,
            securityAuthorized: authorized,
            apiWritesAllowed: apiWrites,
            dataset: parseTestData(testData),
          },
        );
        if (token !== generation.current) return;
        if (!demo && intent === 'ask') {
          setMessages((items) => [
            ...items,
            {
              id: p.id,
              kind: 'answer',
              text: p.answer || p.clarification,
              evidence: p.evidence,
              sources: p.sources,
            },
          ]);
          return;
        }
        setPlan(p);
        setMessages((items) => [...items, { id: p.id, kind: 'plan', plan: p }]);
        setPage((p) => (['setup', 'history', 'credentials'].includes(p) ? p : 'console'));
      },
      (e) => {
        if (token === generation.current) {
          if (!demo) setRequest((current) => current || prompt);
          setMessages((items) => [
            ...items,
            { id: crypto.randomUUID(), kind: 'error', text: e.message },
          ]);
        }
      },
      () => token === generation.current,
    );
    if (token === generation.current) setDrafting(false);
  }
  async function start(selected = plan) {
    if (!selected) return;
    follow.current = true;
    await perform(async () => {
      if (
        selected.automation &&
        (Boolean(selected.automation.allowConsequential) !== allowConsequential ||
          Boolean(selected.apiWritesAllowed) !== apiWrites)
      )
        throw new Error(
          'Automation permissions changed. Prepare this request again to review the current permissions before running.',
        );
      if (!selected.automation && !responsive && !selected.preserveViewport) {
        const current = await rpc('plan.fork', { id: selected.id, preserveViewport: true });
        setPlan(current);
        setRun(null);
        setMessages((items) => [...items, { id: current.id, kind: 'plan', plan: current }]);
        return;
      }
      if (!selected.automation && responsive && selected.preserveViewport)
        throw new Error(
          'The width option changed. Propose a new plan to review desktop/mobile replay before running.',
        );
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
  async function investigateRun(record) {
    setIntent('ask');
    setRecordContext({ id: record.id, origin: record.plan.origin });
    const token = ++generation.current;
    const prompt =
      'Investigate this recorded run. Explain what happened, whether its expectations are supported by the recorded rules, and what to check next. Separate recorded facts from hypotheses. Do not rerun any actions.';
    follow.current = true;
    setPage('console');
    setDrafting(true);
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        kind: 'user',
        text: 'Investigate the recorded run and explain its outcome.',
      },
    ]);
    await perform(
      async () => {
        const answer = await rpc('agent.query', {
          request: prompt,
          runId: record.id,
          readLinks: false,
        });
        if (token !== generation.current) return;
        setMessages((items) => [
          ...items,
          {
            id: answer.id,
            kind: 'answer',
            text: answer.answer || answer.clarification,
            evidence: answer.evidence,
            sources: answer.sources,
            assessment: answer.assessment,
            runId: answer.runId,
          },
        ]);
      },
      (e) => {
        if (token === generation.current)
          setMessages((items) => [
            ...items,
            { id: crypto.randomUUID(), kind: 'error', text: e.message },
          ]);
      },
      () => token === generation.current,
    );
    if (token === generation.current) setDrafting(false);
  }
  async function cancel() {
    generation.current++;
    setDrafting(false);
    setVoiceMode(false);
    recorder.current.stop(true);

    await perform(() => rpc('cancel'));
  }
  commandRef.current = async (text) => {
    const command = classifyCommand(text);
    if (command === 'cancel') return cancel();
    if (command === 'start') return start();
    if (command === 'resume') return perform(() => rpc('resume'));
    if (command === 'status') {
      respond(
        run
          ? `Run is ${state.paused ? 'paused' : run.status}, ${runCounts(run).recorded} recorded steps.`
          : 'No test run is active.',
      );
      return;
    }
    if (command === 'repeat') {
      respond(plan?.clarification || plan?.summary || 'Describe the test you want to run.');
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

    setVoiceMode(false);

    setRequest('');
    setRecordContext(null);
    setAllowConsequential(false);
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
      setAuthorized(false);
      setAPIWrites(false);
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
      setAuthorized(false);
      setAPIWrites(false);
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
    if (!follow.current || !scroll.current || ['setup', 'history', 'credentials'].includes(page))
      return;
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
    if (['setup', 'history', 'credentials'].includes(page) && scroll.current)
      scroll.current.scrollTop = 0;
  }, [page]);
  function renderPlan(plan) {
    if (plan?.automation)
      return (
        <section className="mission-review">
          <span className="eyebrow">REVIEW THE GOAL AND PERMISSIONS</span>
          <h2>
            {plan.automation.live ? 'Ready for live automation' : 'Browser automation mission'}
          </h2>
          <p>{plan.automation.live ? plan.request : plan.summary}</p>
          {plan.clarification ? (
            <p>{plan.clarification}</p>
          ) : (
            <>
              {plan.automation.live ? (
                <p>
                  No action sequence is preplanned. The agent uses tools from the current page and
                  your request, then verifies the resulting outcomes.
                </p>
              ) : (
                <>
                  <h3>Success criteria</h3>
                  <ol>
                    {plan.automation.criteria.map((criterion, i) => (
                      <li key={i}>{criterion}</li>
                    ))}
                  </ol>
                </>
              )}
              <p>
                Adapts after each action · current browser width · up to{' '}
                {plan.automation.maxActions} actions.
              </p>
              <p>
                {plan.automation.allowConsequential
                  ? 'Consequential actions explicitly allowed.'
                  : 'Payments, publishing, sending and deletion are restricted.'}
              </p>
              <Button
                className="primary full"
                disabled={busy || Boolean(state.runId) || state.target?.origin !== plan.origin}
                onClick={() => start(plan)}
              >
                {plan.automation.live ? 'Start live automation' : 'Approve mission and automate'}
              </Button>
            </>
          )}
        </section>
      );

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
                <span>
                  {plan.mode === 'security' ? 'Logical security' : 'Functional QA'} ·{' '}
                  {plan.dataset?.length || 1} data row(s) ·{' '}
                </span>
                {plan.pages?.length > 1 && <span>{plan.pages.length} approved pages · </span>}
                {plan.preserveViewport
                  ? 'Current browser width · no resizing'
                  : plan.viewports.map((v) => `${v.width} × ${v.height}`).join(' / ')}{' '}
                · {plan.visual ? 'Visual comparison enabled' : 'Evidence screenshots enabled'}
              </div>
            </div>
            {plan.dataset?.length > 0 && (
              <details className="plan-data">
                <summary>Review test data</summary>
                {plan.dataset.map((row, index) => (
                  <div key={index} className="data-row">
                    <strong>Row {index + 1}</strong>
                    {Object.entries(row).map(([key, value]) => (
                      <p key={key}>
                        <span>{key}</span>: {value}
                      </p>
                    ))}
                  </div>
                ))}
              </details>
            )}
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
                          {s.http && (
                            <code>
                              {s.http.method} {s.http.url} · expected HTTP {s.http.expectedStatus}
                              {s.http.jsonPointer
                                ? ` · ${s.http.jsonPointer}=${s.http.expectedValue || '(capture)'}`
                                : ''}
                            </code>
                          )}
                          {s.http && (s.http.body || s.http.authSource || s.http.csrfSource) && (
                            <details>
                              <summary>Review API context and data</summary>
                              {s.http.body && <pre>{s.http.body}</pre>}
                              {s.http.authSource && (
                                <p className="small">
                                  Bearer reference: {s.http.authSource} {s.http.authPointer}
                                </p>
                              )}
                              {s.http.csrfSource && (
                                <p className="small">CSRF reference: {s.http.csrfSource}</p>
                              )}
                            </details>
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
    const failed = run.failedSteps ?? run.steps.filter((s) => s.status === 'failed').length;
    const passed = run.passedSteps ?? run.steps.filter((s) => s.status === 'passed').length;
    return (
      <>
        <div className="section-heading">
          <span className="eyebrow">INDEPENDENT CHECKS. RECORDED EVIDENCE.</span>
          <h2>{run?.plan?.automation ? 'Automation results' : 'Test results'}</h2>
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
            {run.diagnosis && (
              <div className="triage-card">
                <h3>Failure triage · {pretty(run.diagnosis.category)}</h3>
                <p>{run.diagnosis.summary}</p>
                <p className="small">Next check: {run.diagnosis.nextCheck}</p>
              </div>
            )}
            {terminal(run.status) && (
              <div className="triage-card">
                <Button
                  className="secondary full"
                  disabled={busy || !state.connected || !state.target || Boolean(state.runId)}
                  onClick={() => investigateRun(run)}
                >
                  <Sparkles size={16} aria-hidden="true" /> Investigate with AI
                </Button>
                <p className="small">
                  Reads this recorded run and the shared page. No actions are rerun.
                </p>
              </div>
            )}
            {run.securityFindings?.length > 0 && (
              <section className="security-findings" aria-label="Security configuration findings">
                <h3>Configuration findings</h3>
                {run.securityFindings.map((finding, index) => (
                  <article key={`${finding.id}-${index}`}>
                    <strong>
                      {pretty(finding.severity)} · {finding.title}
                    </strong>
                    <p>{finding.evidence}</p>
                    <p className="small">{finding.recommendation}</p>
                  </article>
                ))}
              </section>
            )}
            {run.agentPhase && (
              <p className="notice" role="status">
                {run.agentPhase}
              </p>
            )}
            <RunProgress run={run} paused={state.paused} />
            <div className="stats">
              <div>
                <strong>{passed}</strong>
                <span>Completed steps</span>
              </div>
              <div>
                <strong>{failed}</strong>
                <span>Failed checks</span>
              </div>
              <div>
                <strong>{runCounts(run).recorded}</strong>
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
            {run.omittedSteps > 0 && (
              <p className="small">
                Showing the most recent steps. Export HTML or JSON for all {run.recordedSteps} steps
                and complete evidence.
              </p>
            )}
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
                      {run.plan.dataset?.length > 1 ? ` · row ${step.iteration}` : ''}
                    </small>
                  </span>
                  <span className="step-status">
                    {step.status === 'passed' &&
                    step.result?.dispatched &&
                    !['assert', 'http_check'].includes(step.action.operation)
                      ? 'Executed'
                      : pretty(step.status)}
                  </span>
                </summary>
                <div className="step-body">
                  {step.result?.historical && (
                    <p className="small">
                      Observed earlier in this run, after action {step.result.observedAfterActions}.
                      Reopening the page did not clear this recorded issue.
                    </p>
                  )}
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
                  <Button disabled={busy} onClick={() => exportReport('md', run)}>
                    Export bug report
                  </Button>
                  {['html', 'json', 'xml'].map((format) => (
                    <Button key={format} disabled={busy} onClick={() => exportReport(format, run)}>
                      Export {format === 'xml' ? 'JUnit' : format.toUpperCase()}
                    </Button>
                  ))}
                </div>
                <Button
                  className="secondary full"
                  disabled={busy || Boolean(state.runId) || Boolean(run.plan.automation)}
                  onClick={() =>
                    perform(async () => {
                      const p = await rpc('plan.fork', {
                        id: run.plan.id,
                        dataset: parseTestData(testData),
                      });
                      setPlan(p);
                      setRun(null);
                      setMessages([{ id: p.id, kind: 'plan', plan: p }]);
                    })
                  }
                >
                  Reuse workflow with test data
                </Button>
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
              {run.plan.automation
                ? 'Automation adapts across approved tabs and independently verifies the reviewed success criteria.'
                : 'Coverage: selected tab, DOM controls, named screenshots, and automated accessibility rules. Native dialogs and cross-origin frames require separate tests.'}
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
        {history.length > 1 && (
          <section className="run-comparison">
            <h2>Compare runs</h2>
            <label htmlFor="compare-before">Earlier run</label>
            <select
              id="compare-before"
              value={compareBefore}
              onChange={(e) => setCompareBefore(e.target.value)}
            >
              <option value="">Choose a run</option>
              {history.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.startedAt).toLocaleString()} · {r.status} ·{' '}
                  {r.plan.request.slice(0, 50)}
                </option>
              ))}
            </select>
            <label htmlFor="compare-after">Later run</label>
            <select
              id="compare-after"
              value={compareAfter}
              onChange={(e) => setCompareAfter(e.target.value)}
            >
              <option value="">Choose a run</option>
              {history.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.startedAt).toLocaleString()} · {r.status} ·{' '}
                  {r.plan.request.slice(0, 50)}
                </option>
              ))}
            </select>
            <Button
              disabled={!compareBefore || !compareAfter || busy}
              onClick={() =>
                perform(async () =>
                  setComparison(
                    await rpc('run.compare', { before: compareBefore, after: compareAfter }),
                  ),
                )
              }
            >
              Compare results
            </Button>
            {comparison && (
              <>
                <p className="small">{comparison.scope}</p>
                {comparison.entries
                  .filter((entry) => entry.change !== 'unchanged')
                  .map((entry, index) => (
                    <p key={index}>
                      <strong>{entry.change}</strong> · {entry.label} · {entry.before || 'absent'} →{' '}
                      {entry.after || 'absent'}
                    </p>
                  ))}
                {comparison.entries.every((entry) => entry.change === 'unchanged') && (
                  <p>No status differences in matched steps.</p>
                )}
              </>
            )}
          </section>
        )}
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
      <APISettings
        settings={state.settings || settings}
        disabled={!state.connected || Boolean(state.runId) || drafting}
        busy={busy}
        onSave={(payload) =>
          perform(async () => {
            const saved = await rpc('settings.save', payload);
            settingsRef.current = { ...saved, apiKey: '', ttsApiKey: '', speechApiKey: '' };
            setSettings(settingsRef.current);
            return saved;
          })
        }
      />
    );
  }
  function renderCredentials() {
    return (
      <AuthSettings
        connected={state.connected}
        running={Boolean(state.runId) || drafting}
        origin={state.pages?.main?.origin || state.target?.origin}
        rpc={rpc}
        perform={perform}
      />
    );
  }
  const chat = !['setup', 'history', 'credentials'].includes(page);
  const active = Boolean(state.runId);
  const status = state.connected
    ? active
      ? state.paused
        ? 'Paused'
        : run?.nextStep
          ? 'Waiting between steps…'
          : 'Running tests…'
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
            title="API settings"
            onClick={() => setPage('setup')}
          >
            <Icon name="settings" size={20} />
          </Button>
        </nav>
      </header>
      <div className="workspace-switch" role="group" aria-label="Workspace mode">
        <button
          aria-pressed={workspace === 'qa'}
          disabled={busy || active}
          onClick={() => {
            setWorkspace('qa');
            setIntent('test');
            newChat();
          }}
        >
          QA &amp; debugging
        </button>
        <button
          aria-pressed={workspace === 'automation'}
          disabled={busy || active}
          onClick={() => {
            setWorkspace('automation');
            setResponsive(false);
            setMode('qa');
            setAuthorized(false);
            setAPIWrites(false);
            setIntent('test');
            newChat();
          }}
        >
          Browser automation
        </button>
      </div>
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
                        <>
                          <p role={message.kind === 'error' ? 'alert' : undefined}>
                            {message.text}
                          </p>
                          {message.kind === 'answer' && (
                            <>
                              {message.assessment && (
                                <details className="answer-evidence" open>
                                  <summary>
                                    Assessment · {pretty(message.assessment.category)} ·{' '}
                                    {pretty(message.assessment.confidence)}
                                  </summary>
                                  {[
                                    ['Recorded facts', message.assessment.facts],
                                    ['Hypotheses', message.assessment.hypotheses],
                                    ['Next checks', message.assessment.nextChecks],
                                  ].map(
                                    ([title, items]) =>
                                      items?.length > 0 && (
                                        <section key={title}>
                                          <strong>{title}</strong>
                                          <ul>
                                            {items.map((item, index) => (
                                              <li key={index}>{item}</li>
                                            ))}
                                          </ul>
                                        </section>
                                      ),
                                  )}
                                </details>
                              )}
                              <details className="answer-evidence">
                                <summary>
                                  Evidence and tool calls ({message.evidence?.length || 0})
                                </summary>
                                <ul>
                                  {message.evidence?.map((e) => (
                                    <li key={e.id}>
                                      <strong>
                                        {e.id} · {e.tool.replaceAll('_', ' ')}
                                      </strong>
                                      <span>
                                        {e.page}
                                        {e.error ? ` · ${e.error}` : ''}
                                        {message.sources?.includes(e.id) ? ' · cited' : ''}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            </>
                          )}
                        </>
                      )}
                    </article>
                  ),
                )}
              </div>
            )}
            {drafting && (
              <PlanningStatus
                planning={state.planning}
                live={workspace === 'automation' && intent !== 'ask'}
              />
            )}
          </>
        )}
        {page === 'history' && state.connected && renderHistory()}
        {page === 'setup' && renderSettings()}
        {page === 'credentials' && renderCredentials()}
      </main>
      {chat && (
        <ChatComposer
          recordContext={intent === 'ask' ? recordContext : null}
          onDetachRecord={() => setRecordContext(null)}
          apiWrites={apiWrites}
          onAPIWrites={setAPIWrites}
          intent={intent}
          onIntent={setIntent}
          discover={discover}
          onDiscover={setDiscover}
          workspace={workspace}
          allowConsequential={allowConsequential}
          onAllowConsequential={setAllowConsequential}
          readLinks={readLinks}
          onReadLinks={setReadLinks}
          mode={mode}
          onMode={(value) => {
            setMode(value);
            if (value === 'security') setResponsive(false);
            setAuthorized(false);
            setAPIWrites(false);
          }}
          authorized={authorized}
          onAuthorized={setAuthorized}
          data={testData}
          onData={setTestData}
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
          speaking={false}
          hasKey={Boolean(state.settings?.hasApiKey)}
          canVoice={Dictation.supported() && !busy && !active}
          voiceMode={voiceMode}
          voiceState={voiceState}
          onVoice={toggleDictation}
          onStop={cancel}
          onSettings={() => setPage('setup')}
          onModel={saveModel}
          onCredentials={() => setPage('credentials')}
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
          {(active || voiceMode || busy) && (
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
