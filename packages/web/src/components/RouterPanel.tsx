import { useEffect, useState } from 'react';
import {
  ROUTER_ROLE,
  botLabel,
  defaultTeamMap,
  useModelStore,
  useProfilesStore,
  withBots,
  withRouterOnTop,
  type RestClient,
  type RouterDecision,
  type RouterSettings,
  type RouterStatus,
} from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { BotAvatar } from './BotAvatar';
import { Icon } from './Icon';
import { useRouterStatus } from '../hooks/useRouter';
import { pickFastModel } from '../lib/routerSetup';
import { routeNoteText } from '../lib/routeNote';
import { formatListTime } from '../lib/chatTime';

const ROUTER_NAME = 'router';

/** Run in Terminal on the Mac after copying the key: it goes from the clipboard into Hermes's .env, never through the app. */
function keyCommand(keyName: string): string {
  return `hermes config set ${keyName} "$(pbpaste)"`;
}

/** What the newest answered request says about zero data retention, if anything. */
function zdrNote(decisions: RouterDecision[]): string {
  const latest = decisions.find((decision) => decision.zdr !== null);
  if (!latest) return '';
  return latest.zdr ? ' Zero data retention is on.' : ' Zero data retention is off: your Vercel plan does not include it.';
}
const LEVELS: { label: string; value: number }[] = [
  { label: 'Relaxed', value: 0.5 },
  { label: 'Normal', value: 0.6 },
  { label: 'Strict', value: 0.75 },
];

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function DecisionRow({ decision }: { decision: RouterDecision }) {
  const at = Date.parse(decision.at);
  return (
    <li className="hm-router__decision" data-testid="router-decision">
      <span className="hm-router__decision-text">{decision.preview || 'A message'}</span>
      <span className="hm-router__decision-route hm-muted">
        {Number.isFinite(at) ? `${formatListTime(at)} · ` : ''}
        {routeNoteText(decision, { detailed: true })}
      </span>
    </li>
  );
}

interface SetupProps {
  rest: RestClient;
  bots: string[];
  onStatus: (status: RouterStatus) => void;
  onMapChanged: () => void;
}

/** One tap: create Router on a fast model, put it on top of the team map, turn routing on. */
function RouterSetup({ rest, bots, onStatus, onMapChanged }: SetupProps) {
  const profiles = useProfilesStore((s) => s.profiles);
  const create = useProfilesStore((s) => s.create);
  const setModel = useProfilesStore((s) => s.setModel);
  const options = useModelStore((s) => s.options);
  const loadOptions = useModelStore((s) => s.loadOptions);
  const [model, setModelName] = useState<string | undefined>(undefined);
  const [step, setStep] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!options) void loadOptions(rest);
  }, [options, loadOptions, rest]);

  // The default bot's provider, so Router uses the same key; else Hermes's current one, else any signed-in one.
  const base = profiles.find((profile) => profile.name === 'default') ?? profiles[0];
  const providers = options?.providers ?? [];
  const provider =
    providers.find((entry) => entry.slug === base?.provider) ??
    providers.find((entry) => entry.slug === options?.provider) ??
    providers.find((entry) => entry.authenticated && entry.models.length > 0) ??
    providers.find((entry) => entry.models.length > 0);
  const providerSlug = provider?.slug;

  useEffect(() => {
    if (provider && model === undefined) setModelName(pickFastModel(provider) ?? provider.models[0]);
  }, [provider, model]);

  async function run() {
    if (!providerSlug || !model) return;
    setProblem(undefined);
    try {
      if (!profiles.some((profile) => profile.name === ROUTER_NAME)) {
        setStep('Creating Router…');
        await create(rest, { name: ROUTER_NAME, clone_from_default: true, description: ROUTER_ROLE });
      }
      setStep(`Putting Router on ${model}…`);
      await setModel(rest, ROUTER_NAME, providerSlug, model, 'none', false);
      setStep('Putting Router on top of the team map…');
      const names = [...new Set([...bots, ROUTER_NAME])];
      const saved = await rest.botGraph();
      await rest.saveBotGraph(withRouterOnTop(withBots(saved ?? defaultTeamMap(names), names), ROUTER_NAME, ROUTER_ROLE));
      onMapChanged();
      setStep('Turning routing on…');
      onStatus(await rest.saveRouter({ enabled: true, bot: ROUTER_NAME }));
    } catch (err) {
      setProblem(errorText(err, 'The router could not be set up.'));
    } finally {
      setStep(undefined);
    }
  }

  return (
    <div className="hm-router" data-testid="router-setup">
      <p className="hm-router__lead">
        Router becomes the bot you message. Jev reads each message and picks who takes it: quick ones Router answers at once on a
        fast model, real work goes to the bot that owns it.
      </p>
      <ul className="hm-router__steps">
        <li>Creates a bot named Router, copied from your default bot.</li>
        <li>Puts Router on top of the team map, above Manager.</li>
        <li>Turns routing on.</li>
      </ul>
      <label className="hm-router__field">
        <span className="hm-router__heading">Router&apos;s model</span>
        <select
          className="hm-select"
          value={model ?? ''}
          onChange={(event) => setModelName(event.target.value)}
          disabled={!provider || step !== undefined}
          aria-label="Router's model"
        >
          {!provider ? <option value="">{options ? 'No models came back from Hermes' : 'Loading…'}</option> : null}
          {provider?.models.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
      <p className="hm-router__note hm-muted">Jev reads each message you send Router, through your Vercel AI Gateway or OpenRouter key.</p>
      {problem ? (
        <p className="hm-router__note hm-router__note--error" role="alert">
          {problem}
        </p>
      ) : null}
      <button type="button" className="hm-primary hm-router__primary" onClick={() => void run()} disabled={!model || step !== undefined}>
        {step ?? 'Set up Router'}
      </button>
    </div>
  );
}

interface SettingsProps {
  rest: RestClient;
  status: RouterStatus;
  onStatus: (status: RouterStatus) => void;
  onOpenBot?: ((name: string) => void) | undefined;
}

function RouterSettingsBody({ rest, status, onStatus, onOpenBot }: SettingsProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const { settings, keyConfigured, provider, keyName, decisions } = status;
  const command = keyCommand(keyName);

  async function save(patch: Partial<Omit<RouterSettings, 'updatedAt'>>) {
    setBusy(true);
    setProblem(undefined);
    try {
      onStatus(await rest.saveRouter(patch));
    } catch (err) {
      setProblem(errorText(err, 'That did not save. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard here; the command stays on screen to type.
    }
  }

  return (
    <div className="hm-router" data-testid="router-settings">
      <div className="hm-router__hero">
        <BotAvatar name={settings.bot} size={56} />
        <span className="hm-router__name">{botLabel(settings.bot)}</span>
        {onOpenBot ? (
          <button type="button" className="hm-bot-details__message" onClick={() => onOpenBot(settings.bot)}>
            <Icon name="chat" size={18} />
            <span>Message</span>
          </button>
        ) : null}
      </div>

      <div className="hm-router__group">
        <label className="hm-router__row">
          <span className="hm-router__row-body">
            <span className="hm-router__row-label">Route with Jev</span>
            <span className="hm-router__row-sub hm-muted">
              {settings.enabled ? 'Jev picks who takes each message.' : `${botLabel(settings.bot)} answers everything itself.`}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="hm-switch"
            checked={settings.enabled}
            onChange={(event) => void save({ enabled: event.target.checked })}
            disabled={busy}
            aria-label="Route with Jev"
          />
        </label>
        <div className="hm-router__row" data-testid="router-key">
          <span className="hm-router__row-body">
            <span className="hm-router__row-label">Jev</span>
            <span className="hm-router__row-sub hm-muted">
              {keyConfigured
                ? `Connected through ${provider ?? 'your key'} on the Mac.${zdrNote(decisions)}`
                : `Not set up yet, so ${botLabel(settings.bot)} decides by itself. Copy your Vercel AI Gateway key, then run this in Terminal on the Mac:`}
            </span>
            {!keyConfigured ? (
              <button type="button" className="hm-router__command" onClick={() => void copyCommand()} aria-label="Copy the command">
                <code>{command}</code>
                <span className="hm-router__command-copy">{copied ? 'Copied' : 'Copy'}</span>
              </button>
            ) : null}
          </span>
          <span className={`hm-router__dot${keyConfigured ? ' hm-router__dot--on' : ''}`} aria-hidden="true" />
        </div>
      </div>

      <h4 className="hm-router__heading">Hand off when Jev is</h4>
      <div className="hm-segmented" role="radiogroup" aria-label="How sure Jev must be">
        {LEVELS.map((level) => (
          <button
            key={level.label}
            type="button"
            role="radio"
            aria-checked={Math.abs(settings.minConfidence - level.value) < 0.01}
            className={`hm-segmented__item${Math.abs(settings.minConfidence - level.value) < 0.01 ? ' hm-segmented__item--active' : ''}`}
            onClick={() => void save({ minConfidence: level.value })}
            disabled={busy}
          >
            {level.label} {Math.round(level.value * 100)}%
          </button>
        ))}
      </div>
      <p className="hm-router__note hm-muted">Below that, Jev&apos;s pick is only a hint and {botLabel(settings.bot)} decides.</p>

      <h4 className="hm-router__heading">Latest decisions</h4>
      {decisions.length === 0 ? (
        <p className="hm-router__note hm-muted">None yet. Message {botLabel(settings.bot)} and they show up here.</p>
      ) : (
        <ul className="hm-router__decisions">
          {decisions.slice(0, 15).map((decision, index) => (
            <DecisionRow key={`${decision.at}-${decision.key}-${index}`} decision={decision} />
          ))}
        </ul>
      )}
      <p className="hm-router__note hm-muted">
        Jev reads each message you send {botLabel(settings.bot)}, through {provider ?? 'Vercel AI Gateway or OpenRouter'}.
      </p>
      {problem ? (
        <p className="hm-router__note hm-router__note--error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

interface RouterCardProps {
  rest: RestClient;
  bots: string[];
  /** The setup changed the team map: reload it. */
  onMapChanged: () => void;
  onOpenBot?: ((name: string) => void) | undefined;
}

/** The router at the top of the Team view: its state at a glance, and a sheet to set it up or change it. */
export function RouterCard({ rest, bots, onMapChanged, onOpenBot }: RouterCardProps) {
  const { status, missing, error, setStatus } = useRouterStatus(rest);
  const [open, setOpen] = useState(false);

  if (missing) {
    return (
      <div className="hm-router-card hm-router-card--muted" data-testid="router-card">
        <span className="hm-router-card__icon" aria-hidden="true">
          <Icon name="bolt" size={18} />
        </span>
        <span className="hm-router-card__body">
          <span className="hm-router-card__title">Router</span>
          <span className="hm-router-card__text hm-muted">Turns on once the Hermes dashboard on your Mac restarts.</span>
        </span>
      </div>
    );
  }
  if (!status) return error ? <p className="hm-router__note hm-router__note--error">{error}</p> : null;

  const exists = bots.includes(status.settings.bot);
  const summary = !exists
    ? 'Jev reads each message and picks who takes it. Set it up in one tap.'
    : !status.settings.enabled
      ? 'Off: Router answers everything itself.'
      : status.keyConfigured
        ? 'On: Jev picks who takes each message.'
        : 'On, but Jev needs its key on the Mac. Router decides for now.';

  return (
    <>
      <button type="button" className="hm-router-card" onClick={() => setOpen(true)} data-testid="router-card" aria-label="Router settings">
        {exists ? (
          <BotAvatar name={status.settings.bot} size={36} />
        ) : (
          <span className="hm-router-card__icon" aria-hidden="true">
            <Icon name="bolt" size={18} />
          </span>
        )}
        <span className="hm-router-card__body">
          <span className="hm-router-card__title">
            {exists ? botLabel(status.settings.bot) : 'Router'}
            {exists ? (
              <span className={`hm-router-card__state${status.settings.enabled ? ' hm-router-card__state--on' : ''}`}>
                {status.settings.enabled ? 'On' : 'Off'}
              </span>
            ) : null}
          </span>
          <span className="hm-router-card__text hm-muted">{summary}</span>
        </span>
        <span className="hm-router-card__chevron" aria-hidden="true">
          <Icon name="chevR" size={14} />
        </span>
      </button>
      {open ? (
        <BottomSheet title={exists ? 'Router' : 'Set up Router'} onClose={() => setOpen(false)} contentClassName="hm-router-sheet">
          {exists ? (
            <RouterSettingsBody rest={rest} status={status} onStatus={setStatus} onOpenBot={onOpenBot} />
          ) : (
            <RouterSetup rest={rest} bots={bots} onStatus={setStatus} onMapChanged={onMapChanged} />
          )}
        </BottomSheet>
      ) : null}
    </>
  );
}
