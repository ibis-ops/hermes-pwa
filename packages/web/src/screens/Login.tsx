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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password || !passwordProvider) return;
    setLoading(true);
    await store.login(passwordProvider, username, password);
    setLoading(false);
  }

  return (
    <main className="hm-app-shell">
      <section className="hm-hero">
        <h1>Sign in to Hermes</h1>
        <p className="hm-subtitle">Use your Dashboard credentials. Hermes Mobile shares the same session.</p>
      </section>

      {passwordSignInUnsupported ? (
        <div className="hm-card-list">
          <div className="hm-warning-banner hm-warning-banner--error" role="alert">
            <strong>Password sign-in unavailable</strong>
            <p>This Hermes server does not support password sign-in in the mobile PWA.</p>
          </div>
        </div>
      ) : (
        <form className="hm-card-list" onSubmit={onSubmit}>
          {error ? (
            <div className="hm-warning-banner hm-warning-banner--error" role="alert">
              <strong>Login failed</strong>
              <p>{error}</p>
            </div>
          ) : null}

          <label className="hm-check-card" htmlFor="username">
            <span className="hm-status-label">Username</span>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your-username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </label>

          <label className="hm-check-card" htmlFor="password">
            <span className="hm-status-label">Password</span>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </label>

          <button className="hm-primary" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
    </main>
  );
}
