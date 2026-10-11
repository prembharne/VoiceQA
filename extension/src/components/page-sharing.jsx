import React, { useState } from 'react';
import { Button } from './ui.jsx';

export function PageSharing({ pages, running, busy, onShare, onRemove }) {
  const [tabs, setTabs] = useState([]);
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    setNotice('');
    let candidates;
    try {
      candidates = await chrome.tabs.query({
        windowId: pages.find((p) => p.alias === 'main').windowId,
      });
    } catch {
      setNotice('Could not read browser tabs. Try again.');
      return;
    }
    const filtered = candidates.filter(
      (t) => /^https?:/.test(t.url) && !pages.some((p) => p.tabId === t.id),
    );
    setTabs(filtered);
    setSelected(String(filtered[0]?.id || ''));
    if (!filtered.length) setNotice('Open another website tab in this window, then choose again.');
  }
  return (
    <div className="page-sharing">
      <strong>Shared pages ({pages.length}/5)</strong>
      {pages.map((p) => (
        <div className="shared-page" key={p.alias}>
          <span>
            <b>{p.alias}</b> · {p.title || p.origin}
          </span>
          {p.alias !== 'main' && (
            <button
              type="button"
              disabled={running || busy}
              onClick={() => onRemove(p.alias)}
              aria-label={`Unshare ${p.alias}`}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <Button disabled={running || busy || !pages.length || pages.length >= 5} onClick={refresh}>
        Choose another tab
      </Button>
      {notice && (
        <p className="small" role="status">
          {notice}
        </p>
      )}
      {tabs.length > 0 && (
        <>
          <label htmlFor="additional-website-tab">Additional website tab</label>
          <select
            id="additional-website-tab"
            value={selected}
            disabled={running || busy}
            onChange={(e) => setSelected(e.target.value)}
          >
            {tabs.map((t) => (
              <option value={t.id} key={t.id}>
                {t.title} · {new URL(t.url).origin}
              </option>
            ))}
          </select>
          <Button disabled={running || busy || !selected} onClick={() => onShare(Number(selected))}>
            Share selected tab
          </Button>
        </>
      )}
      <p className="small">
        Share up to five pages. New test tabs can open only on these approved origins.
      </p>
    </div>
  );
}
