import { notifyTitleLoginComplete } from './expedition-title-auth.mjs?v=title-login-v2';

const params = new URLSearchParams(location.search);
history.replaceState(null, '', location.pathname);
try {
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state || params.has('error')) throw new Error('Google sign-in was cancelled or denied.');
  const response = await fetch('/api/auth/social/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, state }),
  });
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    const messages = {
      profile_conflict: 'This Google account is linked to a different game profile.',
      SOCIAL_ATTEMPT_UNAVAILABLE: 'This sign-in attempt expired or was replaced. Start Google sign-in again.',
    };
    throw new Error(messages[error] ?? 'Google sign-in could not be verified. Close this window and try again from the game.');
  }
  const attempt = sessionStorage.getItem('veilbound-title-popup');
  if (attempt) {
    sessionStorage.removeItem('veilbound-title-popup');
    notifyTitleLoginComplete(attempt);
    document.getElementById('status').textContent = 'Signed in. Return to VEILBOUND.';
    window.close();
  } else {
    location.replace('/online-expedition.html');
  }
} catch (error) {
  document.getElementById('status').textContent = error.message;
  if (sessionStorage.getItem('veilbound-title-popup')) {
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close window';
    close.onclick = () => window.close();
    document.getElementById('back').replaceWith(close);
  }
}
