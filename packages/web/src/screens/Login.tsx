import { useState } from 'react';
import type { ConnectionStore } from '@hermes-pwa/core';

interface LoginProps {
  store: ConnectionStore;
  error: string | undefined;
}

export function Login({ store, error }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const detailedProviders = store.authProviders ?? [];
  const statusProviders = store.status?.authProviders ?? [];
  const passwordProvider = detailedProviders.find((provider) => provider.supportsPassword)?.name
    ?? (statusProviders.includes('basic') ? 'basic' : undefined)
    ?? (detailedProviders.length === 0 && statusProviders.length === 0 ? 'basic' : undefined);
  const passwordSignInUnsupported = store.status?.authRequired === true && !passwordProvider;
  const submitDisabled = loading || !username || !password || !passwordProvider;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password || !passwordProvider) return;
    setLoading(true);
    await store.login(passwordProvider, username, password);
    setLoading(false);
  }

  return (
    <main className="hm-login">
      <div className="hm-login__brand">
        <img className="hm-login__logo" src="./icons/icon-192.png" alt="" aria-hidden="true" />
        <h1 className="hm-login__title">Sign in to Hermes</h1>
        <p className="hm-login__subtitle">Same login as the Hermes dashboard.</p>
      </div>

      {passwordSignInUnsupported ? (
        <div className="hm-login__error" role="alert">
          <strong>Password sign-in unavailable</strong>
          <span>This Hermes server does not support password sign-in in the mobile PWA.</span>
        </div>
      ) : (
        <form className="hm-login__form" onSubmit={onSubmit} noValidate>
          <div className="hm-login__group">
            <label className="hm-login__field" htmlFor="username">
              <span className="hm-login__label">Username</span>
              <input
                id="username"
                className="hm-login__input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                required
              />
            </label>
            <label className="hm-login__field" htmlFor="password">
              <span className="hm-login__label">Password</span>
              <input
                id="password"
                className="hm-login__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                enterKeyHint="go"
                required
              />
            </label>
          </div>

          {error ? (
            <p className="hm-login__error" role="alert">{error}</p>
          ) : null}

          <button className="hm-primary hm-login__submit" type="submit" disabled={submitDisabled} aria-busy={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
    </main>
  );
}
