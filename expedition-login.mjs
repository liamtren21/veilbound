import { NearConnector } from '@hot-labs/near-connect';
import { notifyTitleLoginComplete, requestTitleAuth } from './expedition-title-auth.mjs?v=title-login-v2';

const params = new URLSearchParams(location.search);
const method = params.get('method');
const attempt = params.get('attempt');
const status = document.querySelector('#status');
const button = document.querySelector('#connect');
const messages = {
  challenge_unavailable: 'Your sign-in request expired. Choose your wallet again.',
  profile_conflict: 'This wallet is already linked to another game profile.',
  WALLET_AUTH_UNAVAILABLE: 'Wallet verification is temporarily unavailable.',
};

function complete() {
  if (attempt) {
    notifyTitleLoginComplete(attempt);
    window.close();
  }
  status.textContent = 'Signed in. You can close this window.';
}

if (method === 'wallet') {
  const connector = new NearConnector({ network: 'testnet', features: { signMessage: true } });
  async function connectWallet() {
    button.hidden = true;
    status.textContent = 'Select a NEAR testnet wallet, then approve the sign-in message.';
    try {
      const wallet = await connector.connect();
      const challenge = await requestTitleAuth('auth/wallet/challenge', {});
      const { accountId, publicKey, signature } = await wallet.signMessage({
        network: 'testnet', message: challenge.message, recipient: challenge.recipient,
        nonce: Uint8Array.from(atob(challenge.nonce), character => character.charCodeAt(0)),
      });
      await requestTitleAuth('auth/wallet/verify', { state: challenge.state, accountId, publicKey, signature });
      complete();
    } catch (error) {
      if (error.message === 'User rejected' && attempt) window.close();
      status.textContent = messages[error.message] ?? 'Wallet sign-in could not be completed.';
      button.hidden = false;
    }
  }
  button.onclick = connectWallet;
  void connectWallet();
} else if (method === 'social') {
  status.textContent = 'Opening Google sign-in...';
  try {
    const { google } = await requestTitleAuth('auth/social/config');
    if (!google) throw new Error('Google sign-in is unavailable on this server.');
    const { authorizationUrl } = await requestTitleAuth('auth/social/begin', {});
    if (attempt) sessionStorage.setItem('veilbound-title-popup', attempt);
    location.replace(authorizationUrl);
  } catch (error) { status.textContent = error.message; }
}
