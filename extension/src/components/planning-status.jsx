import React, { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

const labels = {
  reading: 'Reading the shared page…',
  waiting: 'Waiting for your AI provider…',
  adapting: 'Using compatible JSON output; the plan will be checked locally…',
  analyzing: 'Your AI is analyzing the workflow…',
  generating: 'Building your test plan…',
  validating: 'Checking the plan before review…',
  repairing: 'Correcting the draft after validation…',
};
export function PlanningStatus({ planning }) {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (planning?.startedAt) setStartedAt(planning.startedAt);
  }, [planning?.startedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="thinking-message">
      <LoaderCircle className="spinner" size={16} aria-hidden="true" />
      <div>
        <span role="status">{labels[planning?.phase] || labels.reading}</span>
        <small>
          {planning?.tools?.length
            ? `Latest tool: ${planning.tools.at(-1).tool.replaceAll('_', ' ')} · ${planning.tools.length} calls`
            : 'AI work can take up to 6 minutes. Stop cancels it.'}
        </small>
      </div>
      <span className="planning-elapsed" aria-hidden="true">
        {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
      </span>
    </div>
  );
}
