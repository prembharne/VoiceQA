(() => {
  if (globalThis.__voiceqaInstalled) return;
  globalThis.__voiceqaInstalled = true;
  const overlays = [];
  const requests = new Set();
  const submissionForms = new WeakMap();
  let submissionSecret = '';
  let submissionSigner = null;
  const nodeIds = new WeakMap();
  const nodeRefs = new Map();
  let nextNodeId = 0;
  function nodeTarget(el) {
    let id = nodeIds.get(el);
    if (!id) {
      id = `node:${++nextNodeId}`;
      nodeIds.set(el, id);
    }
    nodeRefs.set(id, new WeakRef(el));
    return id;
  }
  function editable(el) {
    return ['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable;
  }
  function customControl(el) {
    return (
      el.matches('[draggable=true],[tabindex],[contenteditable=true],[onclick]') ||
      (el.hasAttribute('data-id') &&
        el.ownerDocument.defaultView.getComputedStyle(el).cursor === 'pointer')
    );
  }
  function submissionControl(el, key = '') {
    const control = el.closest('button,input[type=submit],input[type=image]') || el;
    const form = control.form || control.closest('form');
    const implicit =
      key === 'Enter' &&
      control.tagName === 'INPUT' &&
      !['button', 'reset', 'checkbox', 'radio'].includes(control.type);
    if (!form || (!(control.type === 'submit' || control.type === 'image') && !implicit))
      return null;
    return { control, form };
  }
  function submissionValidity(el, key = '') {
    const submission = submissionControl(el, key);
    if (!submission || submission.form.noValidate || submission.control.formNoValidate) return null;
    const invalid = [...submission.form.elements].filter(
      (field) => field.willValidate && !field.validity.valid,
    );
    return {
      valid: invalid.length === 0,
      invalidCount: invalid.length,
      // Read ValidityState instead of checkValidity/reportValidity: the latter
      // dispatch invalid events and would make this preflight a mutation.
      fields: invalid.slice(0, 8).map((field) => ({
        target: selector(field),
        name: privateElement(field) ? '[private field]' : name(field).slice(0, 120),
        required: field.required,
        pattern: privateElement(field) ? '' : field.pattern || '',
        min: privateElement(field) ? '' : field.min || '',
        max: privateElement(field) ? '' : field.max || '',
        minLength: field.minLength,
        maxLength: field.maxLength,
        reasons: [
          'valueMissing',
          'typeMismatch',
          'patternMismatch',
          'tooLong',
          'tooShort',
          'rangeUnderflow',
          'rangeOverflow',
          'stepMismatch',
          'badInput',
          'customError',
        ].filter((reason) => field.validity[reason]),
      })),
    };
  }
  async function submissionKey(el, key = '') {
    const submission = submissionControl(el, key);
    if (!submission) return '';
    const { control, form } = submission;
    // Values remain in the isolated world. A per-run keyed identity survives
    // navigation without exposing credential values or an unkeyed value hash.
    if (submissionSigner) {
      const identity = JSON.stringify({
        page: el.ownerDocument.location.origin + el.ownerDocument.location.pathname,
        action: new URL(form.action).origin + new URL(form.action).pathname,
        method: form.method,
        submitter: name(control),
        fields: [...form.elements]
          .filter(
            (field) =>
              !field.matches(
                'input[name*=csrf i],input[name*=xsrf i],input[name=__RequestVerificationToken],[name=cf-turnstile-response],[name=g-recaptcha-response],[name=h-captcha-response]',
              ),
          )
          .map((field) => [
            field.name || name(field),
            field.type,
            field.value,
            Boolean(field.checked),
            field.tagName === 'BUTTON' ? publicText(field) : '',
            [...(field.files || [])].map((file) => [file.name, file.size, file.lastModified]),
          ]),
      });
      const signed = await crypto.subtle.sign(
        'HMAC',
        await submissionSigner,
        new TextEncoder().encode(identity),
      );
      return [...new Uint8Array(signed)].map((n) => n.toString(16).padStart(2, '0')).join('');
    }
    const values = JSON.stringify(
      [...form.elements].map((field) => [
        field.name,
        field.type,
        field.value,
        Boolean(field.checked),
        [...(field.files || [])].map((file) => [file.name, file.size, file.lastModified]),
      ]),
    );
    let state = submissionForms.get(form);
    if (!state || state.values !== values) {
      state = {
        values,
        id: [...crypto.getRandomValues(new Uint8Array(16))]
          .map((n) => n.toString(16).padStart(2, '0'))
          .join(''),
      };
      submissionForms.set(form, state);
    }
    return state.id;
  }
  const mandatoryPrivate =
    'input[type=password],input[autocomplete^=cc-],input[autocomplete=one-time-code],[data-voiceqa-secret],input[name*=csrf i],input[name*=xsrf i],meta[name*=csrf i],meta[name*=xsrf i],input[name=__RequestVerificationToken],[name=cf-turnstile-response],[name=g-recaptcha-response],[name=h-captcha-response]';
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
  function publicText(el) {
    if (privateElement(el)) return '[redacted]';
    const copy = el.cloneNode(true);
    copy
      .querySelectorAll(privateSelectors() + ',script,style,template,[hidden],[aria-hidden=true]')
      .forEach((node) => node.remove());
    return normalize(copy.textContent);
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }
  function readingText() {
    const chunks = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node,
      visited = 0,
      length = 0;
    while ((node = walker.nextNode()) && visited++ < 3000 && length < 9000) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest('script,style,template,noscript,[hidden],[aria-hidden=true]') ||
        privateElement(parent) ||
        !visible(parent)
      )
        continue;
      const text = normalize(node.nodeValue).slice(0, 9000 - length);
      if (text) {
        chunks.push(text);
        length += text.length + 1;
      }
    }
    return chunks.join('\n');
  }
  function role(el) {
    if (el.getAttribute('role')) return el.getAttribute('role');
    return (
      {
        BUTTON: 'button',
        A: 'link',
        SELECT: 'combobox',
        H1: 'heading',
        H2: 'heading',
        H3: 'heading',
        H4: 'heading',
        H5: 'heading',
        H6: 'heading',
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
        .map((id) => {
          const label = el.getRootNode().getElementById?.(id);
          return label ? publicText(label) : '';
        })
        .join(' ');
      if (normalize(text)) return normalize(text);
    }
    return normalize(
      el.getAttribute('aria-label') ||
        [...(el.labels || [])]
          .map((x) => {
            const label = x.cloneNode(true);
            label.querySelectorAll('input,select,textarea,button').forEach((c) => c.remove());
            return label.textContent;
          })
          .join(' ') ||
        el.getAttribute('alt') ||
        (['button', 'link', 'heading', 'option', 'tab', 'menuitem'].includes(role(el))
          ? publicText(el)
          : '') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        (customControl(el) ? publicText(el).slice(0, 180) : ''),
    );
  }
  function selector(el) {
    if (el.dataset.testid) return `testid:${el.dataset.testid}`;
    if (role(el) && name(el)) return `role:${role(el)}|${name(el)}`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    return nodeTarget(el);
  }
  function find(target) {
    if (!target) return [];
    if (target.startsWith('node:')) {
      const el = nodeRefs.get(target)?.deref();
      return el?.isConnected && roots().includes(el.getRootNode()) ? [el] : [];
    }
    if (target.startsWith('testid:'))
      return query(`[data-testid="${CSS.escape(target.slice(7))}"]`);
    if (target.startsWith('role:')) {
      const cut = target.indexOf('|');
      const wantedRole = target.slice(5, cut);
      const wantedName = target.slice(cut + 1);
      const candidates = query('*').filter((el) => role(el) === wantedRole);
      const exact = candidates.filter((el) => name(el) === wantedName);
      return exact.length
        ? exact
        : candidates.filter((el) => name(el).toLowerCase() === wantedName.toLowerCase());
    }
    if (target.startsWith('label:'))
      return query('input,select,textarea,button,[role]').filter(
        (el) => name(el) === target.slice(6),
      );
    if (target.startsWith('text:')) {
      const text = target.slice(5);
      const leafMatches = (fold) =>
        query('*').filter((el) => {
          const matches = (value) =>
            (fold ? normalize(value).toLowerCase() : normalize(value)) ===
            (fold ? text.toLowerCase() : text);
          return matches(el.textContent) && ![...el.children].some((c) => matches(c.textContent));
        });
      const exact = leafMatches(false);
      return exact.length ? exact : leafMatches(true);
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
  async function resolve(target) {
    const el = unique(target);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true')
      throw new Error('Target is disabled');
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    // Code editors keep their real input at a 1px caret. Focus through the
    // visible editor surface, then use native keyboard input as for any field.
    const editor = el.matches('textarea[aria-roledescription=editor]')
      ? el.closest('[role=code]')
      : null;
    const surface = editor && visible(editor) ? editor : el;
    const r = surface.getBoundingClientRect();
    const view = el.ownerDocument.defaultView;
    const left = Math.max(0, r.left),
      right = Math.min(view.innerWidth, r.right);
    const top = Math.max(0, r.top),
      bottom = Math.min(view.innerHeight, r.bottom);
    if (right <= left || bottom <= top) {
      const e = new Error('Target has no visible area in the current viewport');
      e.code = 'blocked';
      throw e;
    }
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    let hit = el.ownerDocument.elementFromPoint(cx, cy);
    if (el.getRootNode() instanceof ShadowRoot)
      hit = el.getRootNode().elementFromPoint?.(cx, cy) || hit;
    if (hit && hit !== surface && !surface.contains(hit) && !hit.contains(surface)) {
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
      editable: editable(el),
      text: privateElement(el) ? '[redacted]' : publicText(el).slice(0, 1000),
      privateField: privateElement(el),
      secretField: Boolean(el.matches(mandatoryPrivate) || el.closest('[data-private]')),
      inputType: el.type,
      options: el.options ? [...el.options].map((o) => ({ value: o.value, label: o.label })) : [],
      selectedIndex: el.selectedIndex,
      submissionKey: await submissionKey(el),
      nativeForm: submissionValidity(el),
      viewport: { width: innerWidth, height: innerHeight },
    };
  }
  function observe() {
    for (const [id, ref] of nodeRefs) {
      if (!ref.deref()?.isConnected) nodeRefs.delete(id);
    }
    // Bound weak-handle metadata on long-lived apps; current observations
    // re-register their handles before exposing them to the agent.
    while (nodeRefs.size > 800) nodeRefs.delete(nodeRefs.keys().next().value);
    const controls = query(
      'button,a[href],input,select,textarea,[role],[data-testid],[draggable=true],[tabindex],[contenteditable=true],[onclick],[data-id]',
    )
      .filter(
        (el) =>
          el.matches('button,a[href],input,select,textarea,[role],[data-testid]') ||
          customControl(el),
      )
      .filter(visible)
      .filter((el) => !privateElement(el) || ['INPUT', 'TEXTAREA'].includes(el.tagName))
      // A newly focused filename field or dialog must survive evidence budgets.
      .sort((a, b) => {
        const priority = (el) =>
          (editable(el) && el.getRootNode().activeElement === el ? 4 : 0) +
          (el.closest('[role=dialog],dialog[open]') ? 2 : 0) +
          (editable(el) ? 1 : 0);
        return priority(b) - priority(a);
      })
      .slice(0, 160)
      .map((el) => ({
        target: selector(el),
        tag: el.tagName.toLowerCase(),
        role: role(el),
        editable: editable(el),
        editor: el.getAttribute('aria-roledescription') === 'editor',
        draggable: el.draggable === true,
        parameterizedLink:
          el.tagName === 'A'
            ? (() => {
                try {
                  const u = new URL(el.href);
                  return Boolean(u.search || u.hash);
                } catch {
                  return true;
                }
              })()
            : false,
        href:
          el.tagName === 'A' && !privateElement(el)
            ? (() => {
                try {
                  const u = new URL(el.href);
                  return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : '';
                } catch {
                  return '';
                }
              })()
            : '',
        inputType: el.tagName === 'INPUT' ? el.type : '',
        required: Boolean(el.required),
        min: el.getAttribute('min') || '',
        max: el.getAttribute('max') || '',
        options:
          el.tagName === 'SELECT' && !privateElement(el)
            ? [...el.options].slice(0, 40).map((o) => ({ value: o.value, label: o.label }))
            : [],
        name: name(el),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        checked: Boolean(el.checked),
        selected: Boolean(el.selected || el.getAttribute('aria-selected') === 'true'),
        readOnly: Boolean(el.readOnly),
        focused: el.getRootNode().activeElement === el || el.ownerDocument.activeElement === el,
        selectedIndex: typeof el.selectedIndex === 'number' ? el.selectedIndex : null,
        expanded: el.getAttribute('aria-expanded'),
        pressed: el.getAttribute('aria-pressed'),
        text: privateElement(el) ? '[redacted]' : publicText(el).slice(0, 180),
        value: privateElement(el) ? '[redacted]' : String(el.value ?? '').slice(0, 100),
      }))
      .filter((x) => x.target)
      .slice(0, 160);
    const text = readingText();
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
      results: query(
        'output,h1,h2,h3,p[id],span[id],[role=status],[role=alert],[aria-live],table,summary',
      )
        .filter(
          (el) =>
            visible(el) ||
            (['status', 'alert'].includes(el.getAttribute('role')) && !publicText(el)),
        )
        .filter((el) => !privateElement(el))
        .slice(0, 60)
        .map((el) => ({
          target: selector(el),
          text: publicText(el).slice(0, 400),
          tag: el.tagName.toLowerCase(),
          visible: visible(el),
        })),
      text,
      // Reference names only; HttpOnly session cookies travel with fetch and
      // need no Authorization header. Never expose storage/cookie values.
      authSources: (() => {
        const refs = [];
        const allowed = (key) =>
          key.length <= 100 &&
          /auth|token|session|jwt/i.test(key) &&
          !/api.?key|openai|openrouter|nvidia/i.test(key);
        for (const prefix of ['local', 'session']) {
          try {
            const storage = prefix === 'local' ? localStorage : sessionStorage;
            for (let i = 0; i < storage.length && refs.length < 20; i++) {
              const key = storage.key(i);
              if (allowed(key)) refs.push(`${prefix}:${key}`);
            }
          } catch {
            /* Storage may be disabled for this document. */
          }
        }
        try {
          for (const cookie of document.cookie.split(';')) {
            const key = cookie.split('=')[0].trim();
            if (refs.length < 20 && allowed(key)) refs.push(`cookie:${key}`);
          }
        } catch {
          /* Cookie access may be disabled. */
        }
        return refs;
      })(),
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
  function inspectElement(target) {
    const el = unique(target);
    const secret = privateElement(el);
    return {
      target: selector(el) || target,
      tag: el.tagName.toLowerCase(),
      role: role(el),
      name: name(el),
      private: secret,
      visible: visible(el),
      disabled: Boolean(el.disabled),
      required: Boolean(el.required),
      type: el.type || '',
      min: el.getAttribute('min') || '',
      max: el.getAttribute('max') || '',
      pattern: el.getAttribute('pattern') || '',
      minLength: el.minLength >= 0 ? el.minLength : null,
      maxLength: el.maxLength >= 0 ? el.maxLength : null,
      readOnly: Boolean(el.readOnly),
      inputMode: el.getAttribute('inputmode') || '',
      description: secret
        ? '[redacted]'
        : normalize(
            [
              el.getAttribute('aria-description') || '',
              ...(el.getAttribute('aria-describedby') || '')
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => {
                  const text = el.getRootNode().getElementById?.(id);
                  return text ? publicText(text) : '';
                }),
            ].join(' '),
          ).slice(0, 1000),
      text: secret ? '[redacted]' : publicText(el).slice(0, 1000),
      value: secret ? '[redacted]' : String(el.value ?? '').slice(0, 400),
      options:
        !secret && el.tagName === 'SELECT'
          ? [...el.options].slice(0, 40).map((o) => ({ label: o.label, value: o.value }))
          : [],
    };
  }
  function searchPage(phrase) {
    if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > 200)
      throw new Error('Search requires a phrase of 1-200 characters.');
    const wanted = normalize(phrase).toLowerCase();
    const matches = [];
    for (const el of query(
      'h1,h2,h3,p,label,output,[role],button,a[href],input,select,textarea,[draggable=true],[tabindex],[contenteditable=true],[onclick],[data-id]',
    )) {
      if (!visible(el) || privateElement(el) || el.querySelector(privateSelectors())) continue;
      if (
        !el.matches('h1,h2,h3,p,label,output,[role],button,a[href],input,select,textarea') &&
        !customControl(el)
      )
        continue;
      const text = (publicText(el) || name(el)).slice(0, 700);
      if (!text.toLowerCase().includes(wanted)) continue;
      matches.push({ target: selector(el), text });
      if (matches.length === 20) break;
    }
    return { matches };
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
        actual = publicText(el);
        passed =
          kind === 'text'
            ? actual === expected
            : actual.toLowerCase().includes(expected.toLowerCase());
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
        const text = publicText(el) || String(el.value ?? '');
        const candidates = text.match(/[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/g) || [];
        if (
          candidates.length !== 1 ||
          (candidates[0].includes(',') && !/^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/.test(candidates[0]))
        )
          throw Object.assign(
            new Error(
              'Numeric evidence is empty, ambiguous or uses an unsupported number format. Inspect the result target.',
            ),
            { code: 'needs_review' },
          );
        actual = Number(candidates[0].replaceAll(',', ''));
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
        if (
          typeof message.submissionSecret === 'string' &&
          message.submissionSecret !== submissionSecret
        ) {
          if (message.submissionSecret && !/^[a-f0-9]{64}$/.test(message.submissionSecret))
            throw new Error('Invalid submission context');
          const nextSecret = message.submissionSecret;
          const nextSigner = nextSecret
            ? await crypto.subtle.importKey(
                'raw',
                Uint8Array.from(nextSecret.match(/../g), (b) => parseInt(b, 16)),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign'],
              )
            : null;
          submissionSecret = nextSecret;
          submissionSigner = nextSigner;
        }
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
              : publicText(el);
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
          case 'vqa.action-context': {
            let el;
            if (message.focused) {
              el = document.activeElement;
              while (
                el?.shadowRoot?.activeElement ||
                (el?.tagName === 'IFRAME' && el.contentDocument?.activeElement)
              )
                el = el.shadowRoot?.activeElement || el.contentDocument.activeElement;
            } else el = unique(message.target);
            if (!el) throw new Error('No focused control to inspect');
            // A selector can hit an icon inside a button. Inspect the actual
            // activating ancestor rather than letting its empty label hide risk.
            el = el.closest('button,a,input[type=submit],input[type=button],[role=button]') || el;
            const form = el.form || el.closest('form');
            const labels = form
              ? [
                  ...form.querySelectorAll(
                    'button[type=submit],input[type=submit],button:not([type])',
                  ),
                ]
                  .filter(visible)
                  .map(name)
                  .join(' ')
              : '';
            const text = [name(el), message.focused ? labels : ''].join(' ');
            const actionRoute = [el.href, form?.action].filter(Boolean).some((raw) => {
              try {
                let path = new URL(raw, location.href).pathname;
                for (let n = 0; n < 2; n++) path = decodeURIComponent(path);
                return /\/(?:delete|remove|logout|signout|pay|purchase|transfer|publish|send|reset)(?:\/|$)/i.test(
                  path,
                );
              } catch {
                return true;
              }
            });
            const consequential =
              actionRoute ||
              /\b(?:delete|erase|destroy|remove account|publish|send|pay|purchase|buy|transfer|place order|confirm payment)\b/i.test(
                text,
              ) ||
              Boolean(form?.querySelector('[autocomplete^=cc-]'));
            result = {
              consequential,
              control: name(el),
              submissionKey: await submissionKey(el, message.key || ''),
              nativeForm: submissionValidity(el, message.key || ''),
            };
            break;
          }
          case 'vqa.inspect':
            result = inspectElement(message.target);
            break;
          case 'vqa.search':
            result = searchPage(message.query);
            break;
          case 'vqa.resolve':
            result = await resolve(message.target);
            break;
          case 'vqa.editable-focus': {
            const el = unique(message.target);
            const active = el.getRootNode().activeElement;
            result = {
              focused:
                editable(el) && (active === el || (el.isContentEditable && el.contains(active))),
            };
            break;
          }
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
