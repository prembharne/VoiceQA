(() => {
  if (globalThis.__voiceqaInstalled) return;
  globalThis.__voiceqaInstalled = true;
  const overlays = [];
  const requests = new Set();
  const mandatoryPrivate =
    'input[type=password],input[autocomplete=one-time-code],[data-voiceqa-secret],input[name*=csrf i],input[name*=xsrf i],meta[name*=csrf i],meta[name*=xsrf i],input[name=__RequestVerificationToken],[name=cf-turnstile-response],[name=g-recaptcha-response],[name=h-captcha-response]';
  let maskSelectors = 'input[type=password], input[type=email], [data-private]';
  const privateSelectors = () => (maskSelectors ? maskSelectors + ',' : '') + mandatoryPrivate;
  const normalize = (s) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  function roots() {
    const found = [];
    const seen = new Set();
    function visit(root) {
      if (seen.has(root)) return;
      seen.add(root);
      found.push(root);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === 'IFRAME') {
          try {
            if (el.contentDocument) visit(el.contentDocument);
          } catch {
            /* outside supported origin */
          }
        }
      }
    }
    visit(document);
    return found;
  }
  function query(selector) {
    return roots().flatMap((root) => [...root.querySelectorAll(selector)]);
  }
  function privateElement(el) {
    try {
      return Boolean(el.matches(privateSelectors()) || el.closest(privateSelectors()));
    } catch {
      throw new Error('Invalid redaction selector');
    }
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }
  function role(el) {
    if (el.getAttribute('role')) return el.getAttribute('role');
    return (
      {
        BUTTON: 'button',
        A: 'link',
        SELECT: 'combobox',
        TEXTAREA: 'textbox',
        INPUT:
          { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button' }[el.type] ||
          'textbox',
      }[el.tagName] || ''
    );
  }
  function name(el) {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => el.getRootNode().getElementById?.(id)?.textContent || '')
        .join(' ');
      if (normalize(text)) return normalize(text);
    }
    return normalize(
      el.getAttribute('aria-label') ||
        [...(el.labels || [])].map((x) => x.textContent).join(' ') ||
        el.getAttribute('alt') ||
        (['button', 'link'].includes(role(el)) ? el.textContent : '') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title'),
    );
  }
  function selector(el) {
    if (el.dataset.testid) return `testid:${el.dataset.testid}`;
    if (role(el) && name(el)) return `role:${role(el)}|${name(el)}`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    return null;
  }
  function find(target) {
    if (!target) return [];
    if (target.startsWith('testid:'))
      return query(`[data-testid="${CSS.escape(target.slice(7))}"]`);
    if (target.startsWith('role:')) {
      const cut = target.indexOf('|');
      const wantedRole = target.slice(5, cut);
      const wantedName = target.slice(cut + 1);
      return query('*').filter((el) => role(el) === wantedRole && name(el) === wantedName);
    }
    if (target.startsWith('label:'))
      return query('input,select,textarea,button,[role]').filter(
        (el) => name(el) === target.slice(6),
      );
    if (target.startsWith('text:')) {
      const text = target.slice(5);
      return query('*').filter(
        (el) =>
          normalize(el.textContent) === text &&
          ![...el.children].some((c) => normalize(c.textContent) === text),
      );
    }
    return query(target);
  }
  function unique(target) {
    const items = find(target).filter(visible);
    if (!items.length) {
      const e = new Error(`Target not found: ${target}`);
      e.code = 'target_missing';
      throw e;
    }
    if (items.length > 1) {
      const e = new Error(`Ambiguous target (${items.length} matches): ${target}`);
      e.code = 'needs_review';
      throw e;
    }
    return items[0];
  }
  function resolve(target) {
    const el = unique(target);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true')
      throw new Error('Target is disabled');
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    let hit = el.ownerDocument.elementFromPoint(cx, cy);
    if (el.getRootNode() instanceof ShadowRoot)
      hit = el.getRootNode().elementFromPoint?.(cx, cy) || hit;
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      const e = new Error('Target is obscured');
      e.code = 'blocked';
      throw e;
    }
    let x = cx,
      y = cy,
      win = el.ownerDocument.defaultView;
    while (win !== window) {
      const f = win.frameElement;
      if (!f) break;
      const box = f.getBoundingClientRect();
      x += box.x + f.clientLeft;
      y += box.y + f.clientTop;
      win = win.parent;
    }
    return {
      x,
      y,
      target,
      tag: el.tagName,
      privateField: privateElement(el),
      secretField: Boolean(el.matches(mandatoryPrivate) || el.closest('[data-private]')),
      inputType: el.type,
      options: el.options ? [...el.options].map((o) => ({ value: o.value, label: o.label })) : [],
      selectedIndex: el.selectedIndex,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }
  function observe() {
    const controls = query('button,a[href],input,select,textarea,[role],[data-testid]')
      .filter(visible)
      .filter((el) => !privateElement(el) || ['INPUT', 'TEXTAREA'].includes(el.tagName))
      .map((el) => ({
        target: selector(el),
        role: role(el),
        name: name(el),
        disabled: Boolean(el.disabled),
        text: privateElement(el) ? '[redacted]' : normalize(el.textContent).slice(0, 180),
        value: privateElement(el) ? '[redacted]' : String(el.value ?? '').slice(0, 100),
      }))
      .filter((x) => x.target)
      .slice(0, 160);
    const text = [...document.querySelectorAll('h1,h2,h3,p,[role=status],[role=alert]')]
      .filter((el) => !privateElement(el))
      .map((el) => normalize(el.textContent))
      .join('\n')
      .slice(0, 3000);
    let unsupportedFrames = 0;
    for (const f of document.querySelectorAll('iframe')) {
      try {
        if (!f.contentDocument) unsupportedFrames++;
      } catch {
        unsupportedFrames++;
      }
    }
    return {
      url: location.href,
      title: document.title,
      fixture: document.querySelector('meta[name=voiceqa-fixture]')?.content || '',
      controls,
      text,
      csrfSources: [...document.querySelectorAll('meta[name],input[name]')]
        .filter((el) => /csrf|xsrf|^__RequestVerificationToken$/i.test(el.name))
        .slice(0, 10)
        .map((el) => `${el.tagName === 'META' ? 'meta' : 'input'}:${el.name}`),
      challenges: [
        ...query('iframe[src],.cf-turnstile,.g-recaptcha,.h-captcha,[data-voiceqa-test-captcha]'),
      ]
        .filter(
          (el) =>
            /captcha|turnstile/i.test(el.src || el.className || '') ||
            el.hasAttribute('data-voiceqa-test-captcha'),
        )
        .slice(0, 10)
        .map((el) => ({
          type: 'captcha',
          target: selector(el),
          testMode: el.hasAttribute('data-voiceqa-test-captcha'),
        })),
      unsupportedFrames,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }
  function assertion(action) {
    const { kind, expected, tolerance = 0 } = action.assertion;
    let actual;
    let passed = false;
    let el;
    if (kind === 'url' || kind === 'url_contains') {
      actual = location.href;
      passed = kind === 'url' ? actual === expected : actual.includes(expected);
    } else if (kind === 'no_overflow') {
      actual = document.documentElement.scrollWidth <= innerWidth + 1;
      passed = String(actual) === expected;
    } else if (kind === 'count') {
      actual = find(action.target).length;
      passed = actual === Number(expected);
    } else if (kind === 'visible' || kind === 'hidden') {
      actual =
        kind === 'visible' ? find(action.target).some(visible) : !find(action.target).some(visible);
      passed = String(actual) === expected;
    } else {
      el = unique(action.target);
      if (privateElement(el) && !['enabled', 'selected', 'focus'].includes(kind))
        throw new Error('Assertions on redacted values are not supported');
      if (kind === 'text' || kind === 'text_contains') {
        actual = normalize(el.textContent);
        passed = kind === 'text' ? actual === expected : actual.includes(expected);
      } else if (kind === 'value') {
        if (!['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(el.tagName))
          throw Object.assign(
            new Error(
              'A value assertion requires a form control. Use text or number for displayed content.',
            ),
            { code: 'needs_review' },
          );
        actual = String(el.value ?? '');
        passed = actual === expected;
      } else if (kind === 'number') {
        actual = Number(normalize(el.textContent || el.value).replace(/[^\d.-]/g, ''));
        passed = Number.isFinite(actual) && Math.abs(actual - Number(expected)) <= tolerance;
      } else if (kind === 'enabled') {
        actual = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
        passed = String(actual) === expected;
      } else if (kind === 'selected') {
        actual = Boolean(el.checked || el.selected || el.getAttribute('aria-selected') === 'true');
        passed = String(actual) === expected;
      } else if (kind === 'focus') {
        actual = el.getRootNode().activeElement === el;
        passed = String(actual) === expected;
      } else throw new Error('Unsupported assertion');
    }
    const actualTruncated = typeof actual === 'string' && actual.length > 2000;
    return {
      passed,
      actual: actualTruncated ? actual.slice(0, 2000) + '…' : actual,
      actualTruncated,
      expected,
      kind,
      target: action.target,
    };
  }
  function redact(visualMaskSelectors = '') {
    unredact();
    for (const root of roots()) {
      const style = document.createElement('style');
      style.textContent =
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
      (root.head || root).append(style);
      overlays.push(style);
    }
    const inaccessibleFrames = query('iframe').filter((frame) => {
      try {
        return !frame.contentDocument;
      } catch {
        return true;
      }
    });
    const masks = [
      ...new Set([
        ...query(privateSelectors()),
        ...(visualMaskSelectors ? query(visualMaskSelectors) : []),
        ...inaccessibleFrames,
      ]),
    ].filter(visible);
    for (const el of masks) {
      const r = el.getBoundingClientRect();
      let x = r.x,
        y = r.y,
        win = el.ownerDocument.defaultView;
      while (win !== window) {
        const f = win.frameElement;
        if (!f) break;
        const box = f.getBoundingClientRect();
        x += box.x + f.clientLeft;
        y += box.y + f.clientTop;
        win = win.parent;
      }
      const cover = document.createElement('div');
      cover.setAttribute('data-voiceqa-mask', '');
      Object.assign(cover.style, {
        position: 'fixed',
        left: `${x}px`,
        top: `${y}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        background: '#101820',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.documentElement.append(cover);
      overlays.push(cover);
    }
  }
  function unredact() {
    for (const el of overlays) el.remove();
    overlays.length = 0;
  }
  function namedBrowserValue(reference) {
    const at = reference.indexOf(':');
    const source = reference.slice(0, at),
      name = reference.slice(at + 1);
    if (source === 'local') return localStorage.getItem(name);
    if (source === 'session') return sessionStorage.getItem(name);
    if (source === 'cookie') {
      const match = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(name + '='));
      if (!match) return null;
      try {
        return decodeURIComponent(match.slice(name.length + 1));
      } catch {
        throw new Error('Named browser reference could not be decoded.');
      }
    }
    const elements = [...document.querySelectorAll(`${source}[name="${CSS.escape(name)}"]`)];
    if (elements.length !== 1) throw new Error('Named browser reference is missing or ambiguous.');
    return source === 'meta' ? elements[0].content : elements[0].value;
  }
  function pointerValue(node, pointer) {
    for (const part of pointer
      .slice(1)
      .split('/')
      .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
      node = node[part];
    }
    return node;
  }
  async function httpCheck(check, timeoutMs) {
    const url = new URL(check.url);
    if (
      url.origin !== location.origin ||
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol)
    )
      throw new Error('HTTP checks require the current page origin.');
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs || 10000);
    const started = performance.now();
    try {
      const headers = {};
      let body = check.body || undefined;
      if (check.body) headers['Content-Type'] = 'application/json';
      if (check.idempotencyKey) headers['Idempotency-Key'] = check.idempotencyKey;
      if (check.authSource) {
        let value = namedBrowserValue(check.authSource);
        if (check.authPointer) {
          let data;
          try {
            data = JSON.parse(value);
          } catch {
            throw new Error(
              'Named authentication source is not JSON; check the source and pointer.',
            );
          }
          value = pointerValue(data, check.authPointer);
        }
        if (typeof value !== 'string') throw new Error('Named bearer token is unavailable.');
        value = value.replace(/^Bearer\s+/i, '').trim();
        if (!value || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value) || /^sk[-_]/.test(value))
          throw new Error('Named bearer token is unavailable, unsupported or exceeds its limit.');
        headers.Authorization = `Bearer ${value}`;
      }
      if (check.csrfSource) {
        const value = namedBrowserValue(check.csrfSource);
        if (!value || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value))
          throw new Error('The named anti-CSRF token is unavailable or exceeds its limit.');
        if (check.csrfBodyField) {
          const data = body ? JSON.parse(body) : {};
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new Error('Anti-CSRF body injection requires a JSON object.');
          data[check.csrfBodyField] = value;
          body = JSON.stringify(data);
          headers['Content-Type'] = 'application/json';
        } else headers[check.csrfHeader || 'X-CSRF-Token'] = value;
      }
      const response = await fetch(url, {
        method: check.method,
        headers,
        body,
        credentials: 'same-origin',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.type === 'opaqueredirect')
        throw Object.assign(new Error('HTTP redirect was not followed; review its destination.'), {
          code: 'needs_review',
        });
      if (response.status !== check.expectedStatus || !check.jsonPointer) {
        await response.body?.cancel();
        return {
          passed: response.status === check.expectedStatus,
          actual: String(response.status),
          expected: String(check.expectedStatus),
          status: response.status,
          method: check.method,
          durationMs: Math.round(performance.now() - started),
          responseBytes: 0,
        };
      }
      let text = '',
        bytes = 0;
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (reader)
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 16384) {
            await reader.cancel();
            throw Object.assign(new Error('HTTP response exceeded the 16 KiB evidence limit.'), {
              code: 'needs_review',
            });
          }
          text += decoder.decode(value, { stream: true });
        }
      text += decoder.decode();
      let actual = String(response.status),
        expected = String(check.expectedStatus),
        value;
      let passed = response.status === check.expectedStatus;
      if (check.jsonPointer) {
        let node;
        try {
          node = JSON.parse(text);
        } catch {
          throw Object.assign(new Error('Expected a JSON response but received another format.'), {
            code: 'assertion_failed',
          });
        }
        node = pointerValue(node, check.jsonPointer);
        if (node === undefined || (node !== null && typeof node === 'object'))
          throw Object.assign(
            new Error(
              'Expected a public scalar JSON field; pointer is missing or selects a container.',
            ),
            { code: 'assertion_failed' },
          );
        value = String(node);
        if (check.expectedType)
          passed =
            passed &&
            (check.expectedType === 'null' ? node === null : typeof node === check.expectedType);
        if (value.length > 1000)
          throw Object.assign(new Error('Captured response field exceeds the evidence limit.'), {
            code: 'needs_review',
          });
        if (check.expectedValue !== '' || !check.saveAs) {
          passed =
            passed &&
            (check.expectedType === 'number'
              ? Number.isFinite(node) &&
                Math.abs(node - Number(check.expectedValue)) <= (check.tolerance || 0)
              : value === check.expectedValue);
          actual += `; ${check.jsonPointer}=${value}`;
          expected += `; ${check.jsonPointer}=${check.expectedValue}`;
        }
      }
      // Response bodies, authentication headers and cookie values are never returned.
      return {
        passed,
        actual,
        expected,
        status: response.status,
        value,
        method: check.method,
        jsonPointer: check.jsonPointer,
        durationMs: Math.round(performance.now() - started),
        responseBytes: bytes,
      };
    } catch (error) {
      if (error.name === 'AbortError')
        throw Object.assign(
          new Error(
            'HTTP check cancelled or timed out; the request outcome is unknown. Inspect server state before retrying.',
          ),
          { code: 'needs_review' },
        );
      throw error;
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('vqa.')) return false;
    (async () => {
      try {
        if (typeof message.maskSelectors === 'string') {
          if (message.maskSelectors) document.querySelector(message.maskSelectors);
          maskSelectors = message.maskSelectors;
        }
        let result;
        switch (message.type) {
          case 'vqa.observe':
            result = observe();
            break;
          case 'vqa.mark-secret':
            unique(message.target).setAttribute('data-voiceqa-secret', '');
            result = { marked: true };
            break;
          case 'vqa.capture-value': {
            const el = unique(message.target);
            if (privateElement(el))
              throw new Error('Private fields cannot become workflow variables.');
            const value = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
              ? String(el.value)
              : normalize(el.textContent);
            if (value.length > 1000) throw new Error('Captured value exceeds 1000 characters.');
            result = { value };
            break;
          }
          case 'vqa.http-check':
            result = await httpCheck(message.check, message.timeoutMs);
            break;
          case 'vqa.security-context':
            result = {
              url: location.href,
              forms: [...document.forms]
                .slice(0, 10)
                .map((f) => ({ action: f.action, method: f.method })),
            };
            break;
          case 'vqa.resolve':
            result = resolve(message.target);
            break;
          case 'vqa.assert':
            result = assertion(message.action);
            break;
          case 'vqa.redact':
            redact(message.visualMaskSelectors);
            result = { masked: overlays.length };
            break;
          case 'vqa.cleanup':
            for (const request of requests) request.abort();
            unredact();
            result = { cleaned: true };
            break;
          case 'vqa.settle':
            await document.fonts.ready;
            result = { ready: true };
            break;
          case 'vqa.accessibility': {
            if (!globalThis.axe) throw new Error('Accessibility engine is unavailable');
            const scan = await axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
            });
            const violations = scan.violations.slice(0, 20).map((v) => ({
              id: v.id,
              impact: v.impact,
              description: v.description,
              help: v.help,
              helpUrl: v.helpUrl,
              nodeCount: v.nodes.length,
              nodes: v.nodes.slice(0, 5).map((n) => ({
                target: n.target,
                failureSummary: n.failureSummary?.slice(0, 600),
              })),
            }));
            result = {
              violations,
              violationCount: scan.violations.length,
              seriousCount: scan.violations.filter((v) =>
                ['serious', 'critical'].includes(v.impact),
              ).length,
              rulePasses: scan.passes.length,
              scope:
                'Automated rules in the main document; displayed nodes are bounded; unsupported frames require review',
            };
            break;
          }
          default:
            throw new Error('Unsupported content operation');
        }
        sendResponse({ result });
      } catch (e) {
        sendResponse({ error: e.message, code: e.code || 'error' });
      }
    })();
    return true;
  });
})();
