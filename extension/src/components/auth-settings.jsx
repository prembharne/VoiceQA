import React, { useEffect, useState } from 'react';
import { Button } from './ui.jsx';

export function AuthSettings({ connected, running, origin, rpc, perform }) {
  const blank = {
    id: '',
    label: '',
    origin: origin || '',
    username: '',
    password: '',
    totpSecret: '',
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  };
  const [draft, setDraft] = useState(blank);
  const [profiles, setProfiles] = useState([]);
  useEffect(() => {
    if (connected)
      void rpc('auth.list')
        .then(setProfiles)
        .catch(() => {});
  }, [connected]);
  const change = (key) => (e) => setDraft({ ...draft, [key]: e.target.value });
  return (
    <section className="auth-settings">
      <h2>Test credentials & MFA</h2>
      <p className="small">
        Save credentials for test accounts on an exact origin. The agent uses profile references;
        passwords and TOTP seeds stay out of plans and model requests. SMS, passkeys and CAPTCHA use
        a manual checkpoint.
      </p>
      {profiles.map((p) => (
        <div className="auth-profile" key={p.id}>
          <div>
            <strong>
              {p.label} · {p.id}
            </strong>
            <small>
              {p.origin} · {p.hasUsername ? 'Username ' : ''}
              {p.hasPassword ? 'Password ' : ''}
              {p.hasTotp ? 'TOTP' : ''}
            </small>
          </div>
          <Button
            disabled={running}
            onClick={() => setDraft({ ...p, username: '', password: '', totpSecret: '' })}
          >
            Edit
          </Button>
          <Button
            disabled={running}
            onClick={() =>
              perform(async () => {
                await rpc('auth.delete', { id: p.id });
                setProfiles(await rpc('auth.list'));
              })
            }
          >
            Delete
          </Button>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await rpc('auth.save', {
              ...draft,
              digits: Number(draft.digits),
              period: Number(draft.period),
            });
            setProfiles(await rpc('auth.list'));
            setDraft(blank);
          });
        }}
      >
        <fieldset className="settings-fields" disabled={!connected || running}>
          <label>
            Profile alias
            <input
              value={draft.id}
              pattern="[a-z][a-z0-9_-]{0,31}"
              maxLength={32}
              required
              placeholder="qa-account"
              onChange={change('id')}
            />
          </label>
          <label>
            Profile label
            <input
              value={draft.label}
              maxLength={100}
              placeholder="Staging QA account"
              onChange={change('label')}
            />
          </label>
          <label>
            Credential origin
            <input
              value={draft.origin}
              required
              placeholder="https://staging.example.com"
              onChange={change('origin')}
            />
          </label>
          <label>
            Test username
            <input
              type="password"
              autoComplete="off"
              value={draft.username}
              maxLength={300}
              placeholder="Blank keeps the saved value"
              onChange={change('username')}
            />
          </label>
          <label>
            Test password
            <input
              type="password"
              autoComplete="new-password"
              value={draft.password}
              maxLength={4096}
              placeholder="Blank keeps the saved value"
              onChange={change('password')}
            />
          </label>
          <label>
            TOTP seed or otpauth URI
            <input
              type="password"
              autoComplete="off"
              value={draft.totpSecret}
              maxLength={2048}
              placeholder="Optional · Base32 seed from your test account"
              onChange={change('totpSecret')}
            />
          </label>
          <div className="auth-parameters">
            <label>
              TOTP algorithm
              <select value={draft.algorithm} onChange={change('algorithm')}>
                <option value="sha1">SHA-1</option>
                <option value="sha256">SHA-256</option>
                <option value="sha512">SHA-512</option>
              </select>
            </label>
            <label>
              TOTP digits
              <select value={draft.digits} onChange={change('digits')}>
                <option value={6}>6</option>
                <option value={8}>8</option>
              </select>
            </label>
            <label>
              TOTP period
              <input
                type="number"
                min={15}
                max={120}
                value={draft.period}
                onChange={change('period')}
              />
            </label>
          </div>
          <Button type="submit" className="secondary full">
            Save test credentials
          </Button>
        </fieldset>
      </form>
    </section>
  );
}
