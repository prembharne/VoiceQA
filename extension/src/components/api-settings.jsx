import React, { useEffect, useState } from 'react';
import { AI_PROVIDERS } from '../../../shared/ai-providers.js';
import { Button } from './ui.jsx';

export function APISettings({ settings, disabled, busy, onSave }) {
  const [provider, setProvider] = useState(settings.aiProvider || 'openai');
  const [key, setKey] = useState('');
  useEffect(() => {
    setProvider(settings.aiProvider || 'openai');
    setKey('');
  }, [settings.aiProvider, settings.hasApiKey]);
  const selected = AI_PROVIDERS[provider];
  return (
    <section className="api-settings">
      <div className="section-heading">
        <div>
          <h1>Settings</h1>
          <p>Connect your AI provider.</p>
        </div>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const saved = await onSave({
            aiProvider: provider,
            apiKey: key,
            ...(provider !== settings.aiProvider ? { model: selected.model } : {}),
            ttsProvider: 'browser',
          });
          if (saved) setKey('');
        }}
      >
        <fieldset className="settings-fields" disabled={disabled || busy}>
          <label>
            AI provider
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setKey('');
              }}
            >
              {Object.entries(AI_PROVIDERS).map(([id, value]) => (
                <option key={id} value={id}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {selected.label} API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Paste your API key"
              spellCheck={false}
            />
          </label>
          <p className="small">
            {provider === settings.aiProvider && settings.hasApiKey
              ? 'Key saved. Leave blank to keep it.'
              : 'Your key is encrypted on this computer.'}
          </p>
          <Button type="submit" className="primary full" busy={busy}>
            Save API key
          </Button>
        </fieldset>
      </form>
      <p className="small">
        Choose the model from the chat composer. The microphone uses Chrome transcription and needs
        no extra API key.
      </p>
    </section>
  );
}
