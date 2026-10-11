import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from './ui.jsx';
import { AI_PROVIDERS } from '../../../shared/ai-providers.js';

export function ModelPicker({ settings, disabled, onSave }) {
  const details = useRef(null);
  const [model, setModel] = useState(settings.model || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setModel(settings.model || ''), [settings.model]);
  return (
    <details
      className="model-picker"
      ref={details}
      onKeyDown={(e) => {
        if (e.key === 'Escape') details.current.open = false;
      }}
    >
      <summary className="model-button" aria-label="Choose AI model" title={settings.model}>
        <span>
          {(settings.model || 'Choose a model')
            .split('/')
            .at(-1)
            .replace(/:free$/, ' · free')}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="model-popover">
        <label htmlFor="ai-model">
          AI model
          <input
            id="ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={disabled || saving}
            maxLength={160}
            spellCheck={false}
          />
        </label>
        <p className="small">
          Using {AI_PROVIDERS[settings.aiProvider]?.label || 'your saved provider'}. A model’s brand
          does not change the API key provider. Changes apply to new plans.
        </p>
        <Button
          type="button"
          className="primary full"
          busy={saving}
          disabled={disabled || !model.trim()}
          onClick={async () => {
            setSaving(true);
            try {
              if (await onSave(model.trim())) details.current.open = false;
            } finally {
              setSaving(false);
            }
          }}
        >
          Use model
        </Button>
      </div>
    </details>
  );
}
