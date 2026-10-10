import React, { useState } from 'react';
import {
  LazyMotion,
  domAnimation,
  m,
  MotionConfig,
  AnimatePresence,
  useReducedMotion,
} from 'motion/react';
import {
  ArrowRight,
  Check,
  Copy,
  LoaderCircle,
  PlugZap,
  ShieldCheck,
  Terminal,
  Unplug,
  Radio,
  History,
  FileCheck2,
  ScanLine,
  Mic,
  Square,
  Settings,
  Activity,
  ChevronRight,
  Play,
} from 'lucide-react';

export const icons = {
  arrow: ArrowRight,
  check: Check,
  mic: Mic,
  stop: Square,
  settings: Settings,
  target: ScanLine,
  history: History,
  plan: FileCheck2,
  results: Activity,
  console: Radio,
  play: Play,
};
export function Icon({ name, size = 18, ...props }) {
  const Component = icons[name] || Check;
  return <Component size={size} strokeWidth={1.8} aria-hidden="true" {...props} />;
}
export function MotionRoot({ children }) {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
export function Button({ children, className = '', busy = false, disabled = false, ...props }) {
  return (
    <m.button
      type="button"
      {...props}
      disabled={disabled || busy}
      className={`ui-button ${className}`}
      whileHover={disabled || busy ? undefined : { y: -1 }}
      whileTap={disabled || busy ? undefined : { scale: 0.97 }}
    >
      {busy && <LoaderCircle className="spinner" size={16} aria-hidden="true" />}
      <span className="button-content">{children}</span>
    </m.button>
  );
}
export function PageTransition({ page, children }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false} mode="wait">
      <m.div
        key={page}
        className="page-content"
        initial={{ opacity: 0, y: reduce ? 0 : 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reduce ? 0 : -4 }}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
export function EmptyState({ title, description, icon: Component = History, action, onAction }) {
  return (
    <m.section
      className="empty-state"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <span className="empty-orbit">
        <Component size={28} aria-hidden="true" />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && (
        <Button className="secondary" onClick={onAction}>
          {action}
          <ArrowRight size={16} />
        </Button>
      )}
    </m.section>
  );
}
export function SetupProgress({ connected, target, plan }) {
  return (
    <ol className="setup-progress" aria-label="Testing setup progress">
      {[
        ['Connect', connected],
        ['Website', Boolean(target)],
        ['Plan', Boolean(plan)],
      ].map(([label, done], index) => (
        <li key={label} className={done ? 'complete' : ''}>
          <span>{done ? <Check size={12} /> : index + 1}</span>
          {label}
          {index < 2 && <ChevronRight size={12} className="progress-arrow" />}
        </li>
      ))}
    </ol>
  );
}
export function friendlyConnectionError(message = '') {
  if (/forbidden|not allowed|access.*denied/i.test(message))
    return 'Chrome cannot authorize this extension. Register the extension ID below, then retry.';
  if (/not found|specified native messaging host/i.test(message))
    return 'The local engine is not registered for this browser yet. Run the setup command below.';
  if (/exited|failed to start/i.test(message))
    return 'The local engine could not start. Repair its registration or run the diagnostic script.';
  if (/disconnected|interrupted|port object|connection lost/i.test(message))
    return 'The connection was interrupted. Retry connection to open a fresh session.';
  return message || 'One quick connection step before your first test.';
}
export function ConnectionSetup({ busy, error, onConnect, extensionId }) {
  const [copied, setCopied] = useState('');
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\install-host.ps1" -ExtensionId ${extensionId}`;
  async function copy(text, kind) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(''), 2200);
    } catch {
      setCopied('failed');
    }
  }
  return (
    <m.section
      className="connection-setup"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="connection-illustration" aria-hidden="true">
        <span className="connection-orbit" />
        <span className="connection-orbit second" />
        <div>
          <PlugZap size={32} />
        </div>
        <span className="secure-badge">
          <ShieldCheck size={16} />
        </span>
      </div>
      <span className="eyebrow">LET’S GET YOU CONNECTED</span>
      <h1>
        Bring your
        <br />
        <em>test engine online.</em>
      </h1>
      <p>
        The Chrome extension is ready. Connect the local Go engine to run tests and save your
        results.
      </p>
      <div className="connection-feedback" role="status">
        <Unplug size={16} />
        <span>{friendlyConnectionError(error)}</span>
      </div>
      <Button className="primary full glow-button" busy={busy} onClick={onConnect}>
        <PlugZap size={18} />
        {busy ? 'Connecting…' : 'Retry connection'}
        <ArrowRight size={17} />
      </Button>
      <div className="install-guide">
        <div className="guide-step">
          <span>01</span>
          <div>
            <h3>Your extension ID</h3>
            <p>Use this ID when registering the engine.</p>
          </div>
        </div>
        <div className="copy-field">
          <input aria-label="Extension ID" readOnly value={extensionId} />
          <Button
            className="icon-button"
            aria-label="Copy extension ID"
            onClick={() => copy(extensionId, 'id')}
          >
            {copied === 'id' ? <Check size={17} /> : <Copy size={17} />}
          </Button>
        </div>
        <div className="guide-step">
          <span>02</span>
          <div>
            <h3>Install or repair the connection</h3>
            <p>Run this in PowerShell from your VoiceQA project folder.</p>
          </div>
        </div>
        <div className="command-box">
          <Terminal size={15} aria-hidden="true" />
          <code>{command}</code>
          <Button
            className="icon-button"
            aria-label="Copy setup command"
            onClick={() => copy(command, 'command')}
          >
            {copied === 'command' ? <Check size={16} /> : <Copy size={16} />}
          </Button>
        </div>
        <p className="install-hint">
          Then choose <strong>Retry connection</strong>. For an extracted Windows package, use its{' '}
          <code>install-host.ps1</code> directly.
        </p>
      </div>
      <details className="technical-details">
        <summary>Connection details</summary>
        <p>{error || 'Waiting for the local engine.'}</p>
        <p>
          Diagnostic: <code>.\scripts\check-host.ps1 -ExtensionId {extensionId}</code>
        </p>
      </details>
      <p className="privacy-note">
        <ShieldCheck size={14} />
        <span>Your API keys and test history stay on this computer.</span>
      </p>
      <span className="sr-only" aria-live="polite">
        {copied === 'failed'
          ? 'Copy failed. Select the displayed text to copy it.'
          : copied
            ? 'Copied to clipboard.'
            : ''}
      </span>
    </m.section>
  );
}
