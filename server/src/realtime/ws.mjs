import { WebSocket, WebSocketServer } from 'ws';

const route = /^\/api\/realtime\/(duel|coop)\/([\w-]+)$/;

export function attachRealtime(server, { origin, modes, sessions, getToken }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const peers = new Set();
  let disposed = false;
  const reject = (socket, status) => socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  const routeFor = (peer, method, suffix = '', body) => modes.route({
    path: peer.path + suffix, method, accountId: peer.accountId, body,
  });
  const send = (peer, packet) => {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > 65_536) return peer.ws.close(1008, 'slow consumer');
    peer.ws.send(JSON.stringify(packet));
  };
  const push = peer => {
    if (sessions.read(peer.token) !== peer.accountId) return peer.ws.close(1008, 'session required');
    try {
      const state = routeFor(peer, 'GET');
      const snapshot = JSON.stringify(state);
      if (snapshot !== peer.lastSnapshot) {
        peer.lastSnapshot = snapshot;
        send(peer, { type: 'state', state });
      }
    } catch {
      peer.ws.close(1008, 'room unavailable');
    }
  };
  const timer = setInterval(() => {
    const now = Date.now();
    for (const peer of peers) {
      if (peer.ws.readyState !== WebSocket.OPEN) continue;
      if (now - peer.lastPong > 30_000) {
        peer.ws.terminate();
        continue;
      }
      if (now - peer.lastPing > 10_000) {
        peer.lastPing = now;
        peer.ws.ping();
      }
      push(peer);
    }
  }, 500);
  timer.unref();
  server.on('upgrade', (request, socket, head) => {
    const match = route.exec(request.url ?? '');
    if (!match || !modes) return reject(socket, '404 Not Found');
    if (request.headers.origin !== origin) return reject(socket, '403 Forbidden');
    const token = getToken(request);
    const accountId = sessions.read(token);
    if (!accountId) return reject(socket, '401 Unauthorized');
    const [, mode, room] = match;
    const path = '/api/modes/' + mode + '/' + room;
    try {
      const state = modes.route({ path, method: 'GET', accountId });
      if (!state.phase) return reject(socket, '409 Conflict');
    } catch {
      return reject(socket, '403 Forbidden');
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const peer = { ws, token, accountId, mode, path, lastPing: Date.now(), lastPong: Date.now() };
      ws.on('pong', () => { peer.lastPong = Date.now(); });
      peers.add(peer);
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        peers.delete(peer);
        if (mode === 'coop' && ![...peers].some(other => other.path === path && other.accountId === accountId)) {
          try { routeFor(peer, 'POST', '/presence', { online: false }); } catch {}
        }
      });
      if (mode === 'coop') {
        try { routeFor(peer, 'POST', '/presence', { online: true }); } catch { ws.close(1008); }
      }
      ws.on('message', (data, binary) => {
        if (sessions.read(token) !== accountId) return ws.close(1008, 'session required');
        try {
          if (binary) throw new Error('invalid_message');
          const message = JSON.parse(data.toString());
          if (message?.type === 'act' && message.action && typeof message.action === 'object') {
            routeFor(peer, 'POST', '/act', message.action);
          } else if (message?.type === 'resume' && mode === 'duel') {
            routeFor(peer, 'POST', '/resume', {});
          } else throw new Error('invalid_message');
          for (const connection of peers) if (connection.path === path) push(connection);
        } catch (error) {
          send(peer, { type: 'error', error: error.code ?? 'INVALID_MESSAGE' });
          push(peer);
        }
      });
      push(peer);
    });
  });
  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    for (const peer of peers) peer.ws.terminate();
    wss.close();
  };
}

