import { useEffect, useMemo, useState } from 'react';
import {
  TEAM_ROLE_MAX_CHARS,
  addToMap,
  botLabel,
  defaultTeamMap,
  describeActivity,
  possibleBosses,
  removeFromMap,
  teamTree,
  topBot,
  updateNode,
  withBots,
  workingBots,
  type BotActivity,
  type BotActivityReport,
  type BotWork,
  type RestClient,
  type TeamMap,
  type TeamTreeNode,
} from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { BotAvatar } from './BotAvatar';
import { Icon } from './Icon';
import { RouterCard } from './RouterPanel';
import { SkeletonRows } from './Skeleton';
import { formatAgo } from '../lib/chatTime';

/** How often the map asks what the bots are doing while it is on screen. */
const ACTIVITY_POLL_MS = 8000;

/** What each bot is working on, asked again every few seconds while the map is visible. */
function useBotActivity(rest: RestClient): BotActivityReport | undefined {
  const [report, setReport] = useState<BotActivityReport | undefined>();
  useEffect(() => {
    let alive = true;
    // Per run of this effect: a guard shared across runs left the remount after React's StrictMode
    // check waiting on the first run's request, so it never asked at all.
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (busy) return;
      busy = true;
      try {
        const next = await rest.botActivity();
        if (alive) setReport(next);
      } catch {
        // The map works without it; the last answer stays.
      } finally {
        busy = false;
      }
      if (alive && document.visibilityState !== 'hidden') timer = setTimeout(() => void load(), ACTIVITY_POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [rest]);
  return report;
}

const KIND_FALLBACK: Record<BotWork['kind'], string> = {
  chat: 'A chat',
  delegated: 'A job handed over',
  scheduled: 'A scheduled job',
  messaging: 'A message',
};

function workDetail(work: BotWork, more: number): string {
  const parts = [
    describeActivity(work.activity),
    work.requestedBy ? `for ${botLabel(work.requestedBy)}` : undefined,
    work.kind === 'scheduled' ? 'scheduled' : undefined,
    work.kind === 'messaging' && work.source ? `from ${work.source.charAt(0).toUpperCase()}${work.source.slice(1)}` : undefined,
    more > 0 ? `${more} more` : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The line under a bot on the map: what it is doing now, or when it last did something. */
function BotStatus({ activity }: { activity: BotActivity | undefined }) {
  if (!activity) return null;
  const first = activity.working ? activity.work[0] : undefined;
  if (first) {
    const detail = workDetail(first, activity.work.length - 1);
    return (
      <>
        <span className="hm-team__node-work" data-testid="team-node-work">
          <span className="hm-team__live-dot" aria-hidden="true" />
          <span className="hm-team__node-work-title">Working: {first.title ?? KIND_FALLBACK[first.kind]}</span>
        </span>
        {detail ? <span className="hm-team__node-work-detail">{detail}</span> : null}
      </>
    );
  }
  if (!activity.lastActiveAt) return null;
  return (
    <span className="hm-team__node-idle" data-testid="team-node-idle">
      Last active {formatAgo(activity.lastActiveAt)}
    </span>
  );
}

function liveSummary(working: string[]): string {
  if (working.length === 0) return 'No bot is working right now';
  const labels = working.map(botLabel);
  if (labels.length === 1) return `${labels[0]} is working`;
  const shown = labels.length <= 3 ? labels : [...labels.slice(0, 2), `${labels.length - 2} more`];
  return `${labels.length} bots working: ${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function messagesLine(names: string[], boss: string | null): string {
  if (names.length === 0) return 'Messages no other bot';
  if (names.length === 1 && names[0] === boss) return `Messages only ${botLabel(boss)}`;
  const labels = names.map(botLabel);
  return labels.length <= 2 ? `Messages ${labels.join(' and ')}` : `Messages ${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
}

interface TeamBranchProps {
  node: TeamTreeNode;
  map: TeamMap;
  depth: number;
  onEdit: (name: string) => void;
  activity: BotActivityReport | undefined;
}

function TeamBranch({ node, map, depth, onEdit, activity }: TeamBranchProps) {
  const info = map.nodes[node.name];
  if (!info) return null;
  const mine = activity?.bots[node.name];
  return (
    <li className="hm-team__branch" role="treeitem" aria-level={depth + 1} aria-expanded={node.children.length > 0 ? true : undefined}>
      <button
        type="button"
        className="hm-team__node"
        onClick={() => onEdit(node.name)}
        data-testid="team-node"
        data-working={mine?.working ? 'true' : undefined}
      >
        <BotAvatar name={node.name} size={36} />
        <span className="hm-team__node-text">
          <span className="hm-team__node-name">{botLabel(node.name)}</span>
          {info.role ? <span className="hm-team__node-role">{info.role}</span> : null}
          <span className="hm-team__node-lines">{messagesLine(info.canMessage, info.reportsTo)}</span>
          <BotStatus activity={mine} />
        </span>
        <span className="hm-team__node-chevron" aria-hidden="true">
          <Icon name="chevR" size={14} />
        </span>
      </button>
      {node.children.length > 0 ? (
        <ul className="hm-team__children" role="group">
          {node.children.map((child) => (
            <TeamBranch key={child.name} node={child} map={map} depth={depth + 1} onEdit={onEdit} activity={activity} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

interface TeamNodeSheetProps {
  name: string;
  map: TeamMap;
  saving: boolean;
  error: string | undefined;
  onSave: (next: TeamMap) => void;
  onClose: () => void;
}

function TeamNodeSheet({ name, map, saving, error, onSave, onClose }: TeamNodeSheetProps) {
  const node = map.nodes[name];
  const [reportsTo, setReportsTo] = useState<string | null>(node?.reportsTo ?? null);
  const [canMessage, setCanMessage] = useState<string[]>(node?.canMessage ?? []);
  const [role, setRole] = useState(node?.role ?? '');
  const [problem, setProblem] = useState<string | undefined>();
  const bosses = useMemo(() => possibleBosses(map, name), [map, name]);
  const others = useMemo(
    () => Object.keys(map.nodes).filter((other) => other !== name).sort((a, b) => botLabel(a).localeCompare(botLabel(b))),
    [map, name],
  );
  const label = botLabel(name);

  const chooseBoss = (boss: string | null) => {
    setReportsTo(boss);
    // A bot can always reach the one it reports to; unticking it stays possible.
    if (boss) setCanMessage((current) => (current.includes(boss) ? current : [...current, boss]));
  };

  const toggle = (other: string, on: boolean) =>
    setCanMessage((current) => (on ? [...new Set([...current, other])] : current.filter((entry) => entry !== other)));

  return (
    <BottomSheet
      title={label}
      onClose={onClose}
      closeDisabled={saving}
      closeLabel="Cancel"
      className="hm-sheet--team-node"
      contentClassName="hm-team-node"
      footer={
        <button
          type="button"
          className="hm-primary hm-team-node__save"
          onClick={() => {
            try {
              setProblem(undefined);
              onSave(updateNode(map, name, { reportsTo, canMessage, role }));
            } catch (err) {
              setProblem(err instanceof Error ? err.message : 'That change does not fit the map.');
            }
          }}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <label className="hm-team-node__field">
        <span className="hm-team-node__heading">Role</span>
        <textarea
          className="hm-input"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          maxLength={TEAM_ROLE_MAX_CHARS}
          rows={2}
          placeholder={`What ${label} does, in a line`}
          disabled={saving}
        />
      </label>

      <h4 className="hm-team-node__heading">Reports to</h4>
      <div className="hm-team-node__group" role="radiogroup" aria-label="Reports to">
        {[null, ...bosses].map((boss) => {
          const checked = reportsTo === boss;
          return (
            <button
              key={boss ?? 'sean'}
              type="button"
              role="radio"
              aria-checked={checked}
              className="hm-team-node__row"
              onClick={() => chooseBoss(boss)}
              disabled={saving}
            >
              {boss ? <BotAvatar name={boss} size={28} /> : <span className="hm-team-node__you" aria-hidden="true">You</span>}
              <span className="hm-team-node__row-label">{boss ? botLabel(boss) : 'Sean (top of the map)'}</span>
              {checked ? <Icon name="check" size={18} /> : null}
            </button>
          );
        })}
      </div>

      <h4 className="hm-team-node__heading">Can message</h4>
      <div className="hm-team-node__group">
        {others.length === 0 ? <p className="hm-team-node__empty hm-muted">No other bots on the map yet.</p> : null}
        {others.map((other) => (
          <label key={other} className="hm-team-node__row">
            <BotAvatar name={other} size={28} />
            <span className="hm-team-node__row-label">{botLabel(other)}</span>
            <input
              type="checkbox"
              role="switch"
              className="hm-switch"
              checked={canMessage.includes(other)}
              onChange={(event) => toggle(other, event.target.checked)}
              disabled={saving}
              aria-label={`${label} can message ${botLabel(other)}`}
            />
          </label>
        ))}
      </div>
      <p className="hm-team-node__note hm-muted">
        {label} is told who it reports to and which bots it can reach. It is a guide: nothing is blocked.
      </p>
      <button
        type="button"
        className="hm-team-node__remove"
        onClick={() => onSave(removeFromMap(map, name))}
        disabled={saving}
      >
        Take {label} off the map
      </button>
      {(problem ?? error) ? (
        <p className="hm-team-node__note hm-team-node__note--error" role="alert">
          {problem ?? error}
        </p>
      ) : null}
    </BottomSheet>
  );
}

interface TeamMapViewProps {
  rest: RestClient;
  /** The bots there are, by profile name. */
  bots: string[];
  /** Open a bot's chat (the router card's Message button). */
  onOpenBot?: ((name: string) => void) | undefined;
}

/**
 * The team map: who reports to whom and who can message whom, drawn from
 * Sean down. Tapping a bot edits its place. The plugin tells each bot its
 * place on its next turn; nothing is blocked.
 */
export function TeamMapView({ rest, bots, onOpenBot }: TeamMapViewProps) {
  const [saved, setSaved] = useState<TeamMap | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  // Bumped when something else saved the map (the router setup), so it loads again.
  const [reloadTick, setReloadTick] = useState(0);
  const activity = useBotActivity(rest);

  useEffect(() => {
    let alive = true;
    rest
      .botGraph()
      .then((map) => {
        if (!alive) return;
        setSaved(map);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof Error && err.message ? err.message : 'Could not load the team map.');
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [rest, reloadTick]);

  const map = useMemo(() => withBots(saved ?? defaultTeamMap(bots), bots), [saved, bots]);
  const tree = useMemo(() => teamTree(map, bots), [map, bots]);
  const top = topBot(Object.keys(map.nodes));
  const starting = loaded && !saved && !loadError;
  // Only the bots on this map; a bot Hermes no longer has is left out.
  const working = useMemo(() => workingBots(activity).filter((name) => Boolean(map.nodes[name])), [activity, map]);

  async function persist(next: TeamMap): Promise<boolean> {
    setSaving(true);
    setSaveError(undefined);
    try {
      setSaved(await rest.saveBotGraph(next));
      return true;
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : 'Could not save the team map.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <SkeletonRows rows={4} kind="cards" label="Loading the team map" />;

  return (
    <div className="hm-team">
      <RouterCard rest={rest} bots={bots} onMapChanged={() => setReloadTick((tick) => tick + 1)} onOpenBot={onOpenBot} />
      {loadError ? <div className="hm-warning-banner hm-warning-banner--error">{loadError}</div> : null}
      {starting && top ? (
        <div className="hm-team__banner" data-testid="team-starting">
          <p className="hm-team__banner-title">Starting map: {botLabel(top)} on top</p>
          <p className="hm-team__banner-text hm-muted">
            {botLabel(top)} can reach every bot, and the others report to it. Save it so your bots learn their places, or tap a bot to
            change its place first.
          </p>
          <button type="button" className="hm-primary hm-team__banner-save" onClick={() => void persist(map)} disabled={saving}>
            {saving ? 'Saving…' : 'Use this map'}
          </button>
        </div>
      ) : null}
      {saveError && !editing ? (
        <div className="hm-warning-banner hm-warning-banner--error" role="alert">
          {saveError}
        </div>
      ) : null}

      {activity ? (
        <p className="hm-team__live" data-testid="team-live" data-working={working.length > 0 ? 'true' : undefined}>
          {working.length > 0 ? <span className="hm-team__live-dot" aria-hidden="true" /> : null}
          <span>{liveSummary(working)}</span>
        </p>
      ) : null}
      <div className="hm-team__you-row" aria-hidden="true">
        <span className="hm-team__you">You</span>
        <span className="hm-team__you-label">Sean</span>
      </div>
      <ul className="hm-team__tree" role="tree" aria-label="Team map">
        {tree.roots.map((root) => (
          <TeamBranch key={root.name} node={root} map={map} depth={0} onEdit={setEditing} activity={activity} />
        ))}
      </ul>

      {tree.unmapped.length > 0 ? (
        <>
          <h4 className="hm-team__heading">Not on the map</h4>
          <div className="hm-team__unmapped">
            {tree.unmapped.map((name) => (
              <button
                key={name}
                type="button"
                className="hm-team__add"
                onClick={() => void persist(addToMap(map, name, top ?? null))}
                disabled={saving}
              >
                <BotAvatar name={name} size={28} />
                <span>{botLabel(name)}</span>
                <span className="hm-team__add-label">Add{top ? ` under ${botLabel(top)}` : ''}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <p className="hm-team__footnote hm-muted">
        Each bot is told its place at the start of a chat and again after you change the map: who it reports to, which bots it can
        message, and its role. It is a guide. Nothing is blocked.
      </p>

      {editing && map.nodes[editing] ? (
        <TeamNodeSheet
          key={editing}
          name={editing}
          map={map}
          saving={saving}
          error={saveError}
          onSave={(next) => {
            void persist(next).then((ok) => {
              if (ok) setEditing(undefined);
            });
          }}
          onClose={() => {
            setSaveError(undefined);
            setEditing(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
