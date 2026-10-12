// Node 22+ client for an explicitly local Electron/Node inspector endpoint.
// Unlike Playwright Electron.launch, this does not depend on stderr inheritance.
export async function connectInspector(endpoint, { timeout = 10000 } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw new Error('Inspector endpoint must be local');
  const socket = new WebSocket(url);
  let serial = 0;
  const pending = new Map();
  const failAll = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  socket.addEventListener('close', () => failAll(new Error('Inspector disconnected')));
  socket.addEventListener('error', () => failAll(new Error('Inspector connection failed')));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out')); }, timeout);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')); }, { once: true });
  });
  return {
    async evaluate(expression, { timeout = 30000 } = {}) {
      const id = ++serial;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector evaluation timed out')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
          expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true,
        } }));
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    },
    // Detach before waiting for graceful process exit. Otherwise Node prints
    // "Waiting for the debugger to disconnect" and cannot complete shutdown.
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Inspector detach timed out')), 5000);
        socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.close();
      });
    },
  };
}
