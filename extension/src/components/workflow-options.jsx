import React from 'react';

export function WorkflowOptions({
  mode,
  onMode,
  authorized,
  onAuthorized,
  data,
  onData,
  disabled,
  apiWrites,
  onAPIWrites,
}) {
  return (
    <fieldset className="workflow-options" disabled={disabled}>
      <label htmlFor="test-mode">Testing mode</label>
      <select id="test-mode" value={mode} onChange={(e) => onMode(e.target.value)}>
        <option value="qa">Functional QA</option>
        <option value="security">Logical security</option>
      </select>
      {mode === 'qa' && (
        <label className="option-check">
          <input
            type="checkbox"
            checked={apiWrites}
            onChange={(e) => onAPIWrites(e.target.checked)}
          />
          Allow API writes on my authorized test systems
        </label>
      )}
      {mode === 'security' && (
        <>
          <label className="option-check">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(e) => onAuthorized(e.target.checked)}
            />
            I am authorized to test these shared systems
          </label>
          <p className="small">
            Verify server permissions and business rules with test accounts and synthetic data. API
            checks stay on approved origins.
          </p>
        </>
      )}
      <details className="data-options">
        <summary>Test data rows</summary>
        <label htmlFor="test-data">Public test values</label>
        <textarea
          id="test-data"
          value={data}
          onChange={(e) => onData(e.target.value)}
          rows={5}
          placeholder={'[{"quantity":"1","total":"12"},{"quantity":"2","total":"24"}]'}
        />
        <p className="small">
          Repeat with up to five rows. Use {'${quantity}'} in the request or plan. Credentials
          belong in saved profiles.
        </p>
      </details>
    </fieldset>
  );
}

export function parseTestData(raw) {
  if (!raw.trim()) return undefined;
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new Error('Test data must be a valid list of rows.');
  }
  if (
    !Array.isArray(rows) ||
    rows.length > 5 ||
    rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
  )
    throw new Error('Use a list containing up to five test-data rows.');
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (value !== null && typeof value === 'object')
          throw new Error('Test values must be text, numbers or booleans.');
        return [key, String(value)];
      }),
    ),
  );
}
