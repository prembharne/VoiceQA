// Failed Chrome port requests are rejected, never replayed on reconnection.
export class PortChannel {
  port = null;
  pending = new Map();
  constructor({
    createPort,
    makeRequest,
    responseID,
    onMessage = () => {},
    onDisconnect = () => {},
    lastError = () => '',
    validate = () => true,
    timeout = 120000,
  }) {
    Object.assign(this, {
      createPort,
      makeRequest,
      responseID,
      onMessage,
      onDisconnect,
      lastError,
      validate,
      timeout,
    });
  }
  open() {
    if (this.port) return this.port;
    const port = this.createPort();
    this.port = port;
    port.onMessage.addListener((message) => {
      if (this.port !== port) return;
      if (!this.validate(message)) {
        this.drop(new Error('Connection returned an invalid message'), port);
        return;
      }
      const id = this.responseID(message);
      const task = id && this.pending.get(id);
      if (task) {
        clearTimeout(task.timer);
        this.pending.delete(id);
        const payload = message.payload || message;
        payload.error ? task.reject(new Error(payload.error)) : task.resolve(payload.result);
      } else if (!id) this.onMessage(message);
    });
    port.onDisconnect.addListener(() => {
      const detail = this.lastError();
      this.drop(
        new Error(detail || 'Connection interrupted. Retry to create a fresh connection.'),
        port,
      );
    });
    return port;
  }
  drop(error, port = this.port) {
    if (port && this.port !== port) return;
    this.port = null;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.pending.clear();
    try {
      port?.disconnect();
    } catch {}
    Promise.resolve(this.onDisconnect(error)).catch(() => {});
  }
  send(message) {
    const port = this.port;
    if (!port) throw new Error('Connection is not ready. Retry connection.');
    try {
      port.postMessage(message);
    } catch (error) {
      this.drop(error, port);
      throw new Error('Connection interrupted. Retry to create a fresh connection.');
    }
  }
  request(type, payload = {}, extra = {}) {
    return new Promise((resolve, reject) => {
      let request;
      try {
        this.open();
        request = this.makeRequest(type, payload, extra);
        const timer = setTimeout(
          () => {
            this.pending.delete(request.id);
            reject(new Error('Connection request timed out. Retry connection.'));
          },
          typeof this.timeout === 'function' ? this.timeout(type, payload) : this.timeout,
        );
        this.pending.set(request.id, { resolve, reject, timer });
        this.send(request);
      } catch (error) {
        const task = request && this.pending.get(request.id);
        if (task) clearTimeout(task.timer);
        if (request) this.pending.delete(request.id);
        reject(error);
      }
    });
  }
}
