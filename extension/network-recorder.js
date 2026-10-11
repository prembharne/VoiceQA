export function publicURL(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
    return url.href.slice(0, 1000);
  } catch {
    return '[unavailable URL]';
  }
}

export class NetworkRecorder {
  entries = [];
  pending = new Map();
  documentHeaders = new Map();
  reset() {
    this.entries = [];
    this.pending.clear();
    this.documentHeaders.clear();
  }
  event(method, p, page) {
    if (method === 'Network.requestWillBeSent') {
      if (p.type === 'Document' && p.frameId) this.documentHeaders.get(page)?.delete(p.frameId);
      const entry = {
        requestId: p.requestId,
        page,
        method: p.request.method,
        url: publicURL(p.request.url),
        started: p.timestamp,
      };
      this.entries.push(entry);
      this.pending.set(p.requestId, entry);
      if (this.entries.length > 120) {
        const removed = this.entries.shift();
        this.pending.delete(removed.requestId);
      }
    } else if (method === 'Network.responseReceived') {
      const entry = this.pending.get(p.requestId);
      if (entry) Object.assign(entry, { status: p.response.status, type: p.type });
      if (p.type === 'Document' && p.frameId) {
        const allowed = new Set([
          'content-security-policy',
          'strict-transport-security',
          'x-content-type-options',
          'x-frame-options',
          'referrer-policy',
        ]);
        if (!this.documentHeaders.has(page)) this.documentHeaders.set(page, new Map());
        const frames = this.documentHeaders.get(page);
        frames.set(
          p.frameId,
          Object.fromEntries(
            Object.entries(p.response.headers || {})
              .filter(([name]) => allowed.has(name.toLowerCase()))
              .map(([name, value]) => [name.toLowerCase(), String(value).slice(0, 4000)]),
          ),
        );
        if (frames.size > 20) frames.delete(frames.keys().next().value);
        if (this.documentHeaders.size > 5)
          this.documentHeaders.delete(this.documentHeaders.keys().next().value);
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const entry = this.pending.get(p.requestId);
      if (entry) {
        entry.durationMs = Math.max(0, Math.round((p.timestamp - entry.started) * 1000));
        if (p.errorText) entry.error = p.errorText.slice(0, 300);
        delete entry.started;
        this.pending.delete(p.requestId);
      }
    }
  }
  headersFor(page, frameId) {
    return this.documentHeaders.get(page)?.get(frameId);
  }
  snapshot(page) {
    return this.entries
      .filter((entry) => entry.page === page)
      .slice(-20)
      .map(({ started, requestId, ...entry }) => ({ ...entry }));
  }
}
