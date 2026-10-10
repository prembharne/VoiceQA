(() => {
  if (globalThis.__voiceqaInstalled) return;
  globalThis.__voiceqaInstalled = true;
  const overlays = [];
  let maskSelectors = 'input[type=password], input[type=email], [data-private]';
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
      return Boolean(el.matches(maskSelectors) || el.closest(maskSelectors));
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
      unsupportedFrames,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }
  function assertion(action) {
    const { kind, expected, tolerance = 0 } = action.assertion;
    let actual;
    let passed = false;
    let el;
    if (kind === 'url') {
      actual = location.href;
      passed = actual === expected;
    } else if (kind === 'no_overflow') {
      actual = document.documentElement.scrollWidth <= innerWidth + 1;
      passed = String(actual) === expected;
    } else if (kind === 'count') {
      actual = find(action.target).length;
      passed = actual === Number(expected);
    } else if (kind === 'visible') {
      actual = find(action.target).some(visible);
      passed = String(actual) === expected;
    } else {
      el = unique(action.target);
      if (privateElement(el)) throw new Error('Assertions on redacted fields are not supported');
      if (kind === 'text') {
        actual = normalize(el.textContent);
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
  function redact() {
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
    const masks = [...new Set([...query(maskSelectors), ...inaccessibleFrames])].filter(visible);
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
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('vqa.')) return false;
    (async () => {
      try {
        if (message.maskSelectors) {
          document.querySelector(message.maskSelectors);
          maskSelectors = message.maskSelectors;
        }
        let result;
        switch (message.type) {
          case 'vqa.observe':
            result = observe();
            break;
          case 'vqa.resolve':
            result = resolve(message.target);
            break;
          case 'vqa.assert':
            result = assertion(message.action);
            break;
          case 'vqa.redact':
            redact();
            result = { masked: overlays.length };
            break;
          case 'vqa.cleanup':
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
            const violations = scan.violations
              .slice(0, 20)
              .map((v) => ({
                id: v.id,
                impact: v.impact,
                description: v.description,
                help: v.help,
                helpUrl: v.helpUrl,
                nodeCount: v.nodes.length,
                nodes: v.nodes
                  .slice(0, 5)
                  .map((n) => ({
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
