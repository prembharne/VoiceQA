import { isAllowedURL } from '../shared/protocol.js';

export class PageRegistry {
  switching = false;
  constructor({ state, chrome, fence, detach, attach, command, save, viewport }) {
    Object.assign(this, { state, chrome, fence, detach, attach, command, save, viewport });
  }
  ensure() {
    if (!this.state.pages?.main && this.state.target)
      this.state.pages = { main: { ...this.state.target, alias: 'main', owned: false } };
    this.state.currentPage ||= 'main';
    return this.state.pages || {};
  }
  publicPages() {
    return Object.values(this.ensure())
      .filter((p) => !p.owned)
      .map(({ alias, origin, url, title }) => ({ alias, origin, url, title }));
  }
  allows(url) {
    return Object.values(this.ensure()).some((p) => !p.owned && isAllowedURL(url, p.origin));
  }
  primary() {
    return this.ensure().main;
  }
  closable(page, tab) {
    return (
      this.allows(tab.url) ||
      ((!tab.url || tab.url === 'about:blank') && this.allows(tab.pendingUrl || page.url))
    );
  }
  check(token) {
    this.fence.check(token, this.state);
  }
  async activate(alias, token, focus = true) {
    this.check(token);
    const page = this.ensure()[alias];
    if (!page) throw new Error('The requested page is not shared.');
    const tab = await this.chrome.tabs.get(page.tabId);
    this.check(token);
    if (!this.allows(tab.url)) throw new Error('Shared page left explicitly approved origins.');
    if (this.state.target?.tabId === page.tabId) {
      this.state.target = { ...page, url: tab.url, origin: new URL(tab.url).origin };
      this.state.currentPage = alias;
      if (focus) {
        await this.chrome.tabs.update(page.tabId, { active: true });
        this.check(token);
        await this.chrome.windows.update(page.windowId, { focused: true });
        this.check(token);
      }
      this.state.paused = false;
      if (this.state.runId) await this.prepare(token);
      await this.save();
      return page;
    }
    this.switching = true;
    try {
      await this.detach();
      this.check(token);
      this.state.target = { ...page, url: tab.url, origin: new URL(tab.url).origin };
      this.state.currentPage = alias;
      this.fence.invalidate();
      const next = this.fence.token(this.state.runId, page.tabId);
      if (focus) {
        await this.chrome.tabs.update(page.tabId, { active: true });
        this.check(next);
        await this.chrome.windows.update(page.windowId, { focused: true });
        this.check(next);
      }
      this.state.paused = false;
      if (this.state.runId) {
        await this.prepare(next);
      }
      this.check(next);
      await this.save();
      return page;
    } finally {
      this.switching = false;
    }
  }
  async prepare(token) {
    await this.attach(token);
    const v = this.viewport();
    if (v)
      await this.command(
        'Emulation.setDeviceMetricsOverride',
        { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: false },
        token,
      );
    this.check(token);
  }
  async open(alias, url, token) {
    this.check(token);
    const pages = this.ensure();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias) || pages[alias] || Object.keys(pages).length >= 5)
      throw new Error('Use a unique page alias within the five-page limit.');
    const origin = new URL(url).origin;
    if (
      !Object.values(pages).some((p) => !p.owned && p.origin === origin) ||
      !isAllowedURL(url, origin)
    )
      throw new Error('The new tab origin has not been explicitly shared.');
    const tab = await this.chrome.tabs.create({
      url,
      active: false,
      windowId: this.primary().windowId,
    });
    try {
      this.check(token);
    } catch (e) {
      await this.chrome.tabs.remove(tab.id).catch(() => {});
      throw e;
    }
    pages[alias] = {
      alias,
      tabId: tab.id,
      windowId: tab.windowId,
      origin,
      url,
      title: tab.title || alias,
      owned: true,
    };
    // Chrome may return a new tab while its committed URL is still about:blank.
    // Keep the previous execution identity until the approved document is ready.
    const deadline = Date.now() + 15000;
    let loaded = false;
    while (Date.now() < deadline) {
      this.check(token);
      const current = await this.chrome.tabs.get(tab.id);
      this.check(token);
      if (current.status !== 'loading' && this.allows(current.url)) {
        loaded = true;
        break;
      }
      if (current.status === 'complete' && !this.allows(current.url))
        throw new Error('Created tab redirected outside explicitly approved origins.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!loaded) throw new Error('Created tab did not reach an approved page before the deadline.');
    await this.activate(alias, token);
    return { page: alias, origin: this.state.target.origin, url: this.state.target.url };
  }
  async close(alias, token) {
    this.check(token);
    const page = this.ensure()[alias];
    if (!page?.owned) throw new Error('Only tabs created by this run can be closed.');
    const tab = await this.chrome.tabs.get(page.tabId);
    this.check(token);
    if (!this.closable(page, tab))
      throw new Error('Created tab left its approved origin; it will not be closed automatically.');
    await this.activate('main', token);
    const next = this.fence.token(this.state.runId, this.state.target.tabId);
    this.check(next);
    this.switching = true;
    try {
      await this.chrome.tabs.remove(page.tabId);
      delete this.state.pages[alias];
      await this.save();
    } finally {
      this.switching = false;
    }
    return { page: 'main', closed: alias };
  }
  // Cleanup removes only tracked run-created tabs still in their approved origin.
  async cleanupCreated() {
    const pages = this.ensure();
    this.switching = true;
    try {
      for (const [alias, page] of Object.entries(pages)) {
        if (!page.owned) continue;
        try {
          const tab = await this.chrome.tabs.get(page.tabId);
          if (this.closable(page, tab)) await this.chrome.tabs.remove(page.tabId);
        } catch {}
        delete pages[alias];
      }
      if (pages.main) {
        this.state.target = { ...pages.main };
        this.state.currentPage = 'main';
      }
      await this.save();
    } finally {
      this.switching = false;
    }
  }
}
