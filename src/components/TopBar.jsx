import React, { useEffect, useState } from 'react';
import {
  getMonthlyUsage,
  getUser,
  isPuterLoaded,
  isSignedIn,
  signIn,
  signOut,
  whenPuterReady,
} from '../lib/puterClient.js';

export default function TopBar({ onHelp }) {
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [user, setUser] = useState(null);
  const [usage, setUsage] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const u = await getUser();
    setUser(u);
    if (u) setUsage(await getMonthlyUsage());
  };

  useEffect(() => {
    let alive = true;
    whenPuterReady()
      .then(async () => {
        if (!alive) return;
        setStatus('ready');
        await refresh();
      })
      .catch((err) => {
        if (!alive) return;
        setStatus('error');
        setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      await refresh();
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const usageInfo = describeUsage(usage);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          🖼️
        </div>
        <div>
          <h1>StyleForge Bulk</h1>
          <p>Nano Banana Pro · bulk style-matched image factory</p>
        </div>
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-actions">
        <span className="pill accent" title="Powered by Puter.js — no API key required">
          <span className="dot" /> No API key
        </span>

        {status === 'error' ? (
          <span className="pill err" title={error}>
            ⚠ Puter.js blocked
          </span>
        ) : null}

        {usageInfo ? (
          <span className={`pill ${usageInfo.tone}`} title={usageInfo.title}>
            {usageInfo.label}
          </span>
        ) : null}

        <button className="btn sm ghost" onClick={onHelp}>
          ⓘ How it works
        </button>

        {user ? (
          <>
            <span className="pill ok" title={user.username ? `@${user.username}` : ''}>
              <span className="dot" />
              {user.username || 'Signed in'}
            </span>
            <button
              className="btn sm ghost"
              onClick={async () => {
                await signOut();
                setUser(null);
                setUsage(null);
                onAuth?.(false);
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <button className="btn sm primary" onClick={handleSignIn} disabled={busy || status !== 'ready'}>
            {busy ? 'Opening…' : status === 'loading' ? 'Connecting…' : 'Sign in free'}
          </button>
        )}
      </div>
    </header>
  );
}

function friendlyAuthError(err) {
  const msg = String(err?.message || err);
  if (/popup|blocked|window/i.test(msg)) {
    return 'The sign-in popup was blocked. Allow popups for this page (or open the app in its own browser tab) and try again.';
  }
  if (/Failed to fetch|network/i.test(msg)) {
    return 'Could not reach puter.com. Check your connection or content blocker, then try again.';
  }
  return msg;
}

function describeUsage(usage) {
  if (!usage) return null;
  const cents = usage.allowanceInfo?.remaining ?? usage.remaining ?? null;
  const used = usage.totalUsage ?? null;
  try {
    if (typeof cents === 'number') {
      const dollars = cents / 100;
      return {
        label: `≈ $${dollars.toFixed(2)} left`,
        tone: dollars < 1 ? 'warn' : 'ok',
        title: 'Remaining monthly usage allowance on your own Puter account.',
      };
    }
  } catch {
    /* fall through */
  }
  if (typeof used === 'number' && used > 0) {
    return {
      label: `$${(used / 100).toFixed(2)} used`,
      tone: 'info',
      title: 'Usage so far this month on your own Puter account.',
    };
  }
  return null;
}
