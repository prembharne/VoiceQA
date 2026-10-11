import { runCounts } from '../../run-counts.js';
import React, { useEffect, useState } from 'react';
import { Clock3, Play } from 'lucide-react';

export function RunProgress({ run, paused }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run.nextStepAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [run.nextStepAt]);
  const last = run.steps.at(-1);
  const step = run.nextStep || (last?.status === 'dispatched' ? last : null);
  if (!step || !['running', 'paused', 'queued'].includes(run.status)) return null;
  const waiting = Boolean(run.nextStep);
  const seconds = Math.max(0, Math.ceil((Date.parse(run.nextStepAt || '') - now) / 1000));
  const { recorded, complete } = runCounts(run);
  const index = recorded + (waiting ? 1 : 0);
  return (
    <section className="run-progress" aria-label="Live test progress">
      <div className="run-progress-heading">
        <span className="eyebrow">
          STEP {index} OF {run.totalSteps || '?'}
        </span>
        <span className="run-progress-state">
          {waiting ? (
            <Clock3 size={14} aria-hidden="true" />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
          {paused ? (
            'Waiting for your tab'
          ) : waiting ? (
            <>
              <span className="sr-only">Waiting between steps</span>
              <span aria-hidden="true">Next in {seconds}s</span>
            </>
          ) : (
            'Running now'
          )}
        </span>
      </div>
      <h3 aria-live="polite">{step.action.label}</h3>
      <p>
        {step.case} · {step.page || 'main'} · {step.viewport}
      </p>
      <progress
        value={complete}
        max={run.totalSteps || Math.max(index, 1)}
        aria-label="Completed test steps"
      />
      {waiting && last && (
        <p className="run-progress-previous">
          Previous: {last.action.label} · {last.status.replaceAll('_', ' ')}
        </p>
      )}
    </section>
  );
}
