import { useCallback, useEffect, useState } from 'react';
import {
  messagingStateLabel,
  sortMessagingPlatforms,
  type MessagingPlatform,
  type RestClient,
} from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { SkeletonRows } from '../components/Skeleton';

interface MessagingProps {
  rest: RestClient;
}

const REFRESH_MS = 30_000;

function fmtAge(updatedAt: number | undefined, nowMs: number): string {
  if (!updatedAt) return '';
  const s = Math.max(0, Math.round((nowMs - updatedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function PlatformRow({ platform, nowMs }: { platform: MessagingPlatform; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const live = platform.state === 'connected' || platform.state === 'connecting';
  const detail =
    platform.state === 'error'
      ? platform.errorMessage ?? 'The gateway reported an error.'
      : platform.state === 'connected' && platform.homeChannel
        ? `Home: ${platform.homeChannel}`
        : platform.state === 'disabled' && !platform.configured && platform.requiredTotal > 0
          ? `${platform.requiredSet} of ${platform.requiredTotal} settings filled in`
          : '';
  const age = live || platform.state === 'error' ? fmtAge(platform.updatedAt, nowMs) : '';

  return (
    <div className={`hm-bot hm-bot--${platform.state}`} data-testid="messaging-platform" data-state={platform.state}>
      <button
        type="button"
        className="hm-bot__row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${platform.name}, ${messagingStateLabel(platform)}`}
      >
        <span className="hm-bot__dot" aria-hidden="true" />
        <span className="hm-bot__body">
          <span className="hm-bot__name">{platform.name}</span>
          <span className="hm-bot__meta hm-muted">
            {messagingStateLabel(platform)}
            {detail ? ` · ${detail}` : ''}
          </span>
        </span>
        {age ? <span className="hm-bot__age hm-muted">{age}</span> : null}
        <span className="hm-bot__chevron" aria-hidden="true">
          <Icon name="chevD" size={14} />
        </span>
      </button>
      {open ? (
        <div className="hm-bot__detail">
          {platform.description ? <p>{platform.description}</p> : null}
          {platform.state === 'error' && platform.errorMessage ? <p className="hm-bot__error">{platform.errorMessage}</p> : null}
          <p className="hm-muted">
            {platform.configured
              ? 'Tokens and allow lists are managed in the Hermes dashboard on the Mac.'
              : 'Set this up in the Hermes dashboard on the Mac (Messaging), then it shows here.'}
          </p>
          {platform.docsUrl ? (
            <a className="hm-bot__link" href={platform.docsUrl} target="_blank" rel="noopener noreferrer">
              Provider docs
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Which chat services have a Hermes bot, and whether each one is connected. */
export function Messaging({ rest }: MessagingProps) {
  const [platforms, setPlatforms] = useState<MessagingPlatform[] | undefined>(undefined);
  const [gatewayRunning, setGatewayRunning] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const overview = await rest.messagingPlatforms();
      setPlatforms(sortMessagingPlatforms(overview.platforms));
      setGatewayRunning(overview.gatewayRunning);
      setError(undefined);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load the messaging platforms.');
    }
  }, [rest]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const active = (platforms ?? []).filter((p) => p.state !== 'disabled');
  const available = (platforms ?? []).filter((p) => p.state === 'disabled');

  return (
    <div className="hm-messaging hm-scroll">
      <p className="hm-messaging__lead hm-muted">
        Chat apps where Hermes answers as a bot. Connections run on the Mac; this page only shows their state.
      </p>
      {error ? <div className="hm-warning-banner hm-warning-banner--error">{error}</div> : null}
      {gatewayRunning === false ? (
        <div className="hm-warning-banner">The gateway is stopped, so no bot is online. Start it from System.</div>
      ) : null}

      {platforms === undefined && !error ? <SkeletonRows rows={4} label="Loading messaging" /> : null}

      {platforms !== undefined ? (
        <>
          <section className="hm-settings__section">
            <h3 className="hm-settings__section-title">Set up</h3>
            <div className="hm-settings__section-body hm-bot-list">
              {active.length === 0 ? (
                <p className="hm-bot-list__empty hm-muted">No chat app is set up yet. Add one in the Hermes dashboard on the Mac.</p>
              ) : (
                active.map((p) => <PlatformRow key={p.id} platform={p} nowMs={nowMs} />)
              )}
            </div>
          </section>
          {available.length > 0 ? (
            <section className="hm-settings__section">
              <h3 className="hm-settings__section-title">Available</h3>
              <div className="hm-settings__section-body hm-bot-list">
                {available.map((p) => (
                  <PlatformRow key={p.id} platform={p} nowMs={nowMs} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
