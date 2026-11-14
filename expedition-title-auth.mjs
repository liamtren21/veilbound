export async function requestTitleAuth(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {
    cache: 'no-store', signal: AbortSignal.timeout(8000),
  } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (response.status === 401 && path === 'session') return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Sign-in unavailable.');
  return data;
}

export function titleAuthenticated(session) {
  return Boolean(session?.accountId || session?.social);
}

export function notifyTitleLoginComplete(attempt) {
  const channel = new BroadcastChannel('veilbound-login-' + attempt);
  channel.postMessage('complete');
  channel.close();
}

export async function openTitleLogin(method, signal) {
  const attempt = crypto.randomUUID();
  const params = new URLSearchParams({ method, attempt });
  const popup = window.open('/expedition-login.html?' + params, 'veilbound-login', 'popup,width=510,height=690');
  if (!popup) throw new Error('Allow pop-ups for this game and try again.');
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel('veilbound-login-' + attempt);
    function cleanup() {
      channel.close();
      clearTimeout(timer);
      clearInterval(walletWatcher);
      signal?.removeEventListener('abort', cancel);
    }
    function cancel() {
      cleanup();
      popup.close();
      reject(new Error('Sign-in was cancelled. Try again.'));
    }
    channel.onmessage = async event => {
      if (event.data !== 'complete') return;
      cleanup();
      try {
        const session = await requestTitleAuth('session');
        if (!titleAuthenticated(session)) throw new Error('Sign-in did not complete. Try again.');
        resolve(session);
      } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => {
      cleanup();
      popup.close();
      reject(new Error('Sign-in timed out. Try again.'));
    }, 300000);
    const walletWatcher = method === 'wallet' ? setInterval(() => {
      if (popup.closed) cancel();
    }, 650) : undefined;
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
