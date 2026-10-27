import { useEffect, useMemo, useState } from 'react';
import { skillCommandSlug, useChatStore, useConnectionStore, useProfilesStore, useModelStore, useConfigStore, botLabel } from '@hermes-pwa/core';
import type { RestClient, SystemStats, ModelProvider, ReasoningEffort, PushStatus } from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { BottomSheet } from '../components/BottomSheet';
import { SkillPicker } from '../components/SkillPicker';
import { ConfirmSheet } from '../components/ActionSheet';
import { ReadAloudSettings } from '../components/ReadAloudSettings';
import { readDefaultSkill, writeDefaultSkill } from '../lib/defaultSkill';
import { readAppearance, writeAppearance, type Appearance } from '../lib/appearance';
import { clearLocalChatCache } from '../lib/localCache';
import { HERMES_PWA_VERSION_LABEL } from '../app/version';
import { disablePushNotifications, enablePushNotifications, getPushCapability, hasBrowserPushSubscription } from '../pwa/push';
import { canPromptInstall, INSTALL_PROMPT_CHANGED_EVENT, isIosSafari, promptInstall } from '../pwa/install';

interface SettingsProps {
  rest: RestClient;
  onNavigate: (screen: string) => void;
  onLogout: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="hm-settings__section">
      <h3 className="hm-settings__section-title">{title}</h3>
      <div className="hm-settings__section-body">{children}</div>
    </section>
  );
}

type BusyInputMode = 'queue' | 'steer' | 'interrupt';
const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function reasoningLabel(effort: ReasoningEffort | undefined): string {
  if (!effort) return 'Default';
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function normalizeBusyInputMode(value: unknown): BusyInputMode {
  return value === 'queue' || value === 'interrupt' || value === 'steer' ? value : 'queue';
}

function busyInputModeLabel(value: BusyInputMode): string {
  if (value === 'queue') return 'Queue after current turn';
  if (value === 'interrupt') return 'Interrupt current turn';
  return 'Steer running turn';
}

function busyInputModeDescription(value: BusyInputMode): string {
  if (value === 'queue') return 'Messages typed while Hermes is busy are sent after the current turn finishes.';
  if (value === 'interrupt') return 'Messages typed while Hermes is busy interrupt the current turn, then send as the next prompt.';
  return 'Messages typed while Hermes is busy are injected into the running turn without interrupting.';
}

function SettingsRow({ label, value, children, action }: { label: string; value?: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="hm-settings-row">
      <span className="hm-settings-row__label">{label}</span>
      {value ? <span className="hm-settings-row__value hm-muted">{value}</span> : children}
      {action}
    </div>
  );
}

export function Settings({ rest, onNavigate, onLogout }: SettingsProps) {
  const { status } = useConnectionStore();
  const activeName = useProfilesStore((s) => s.activeName);
  const activeProfile = useProfilesStore((s) => s.profiles.find((p) => p.name === s.activeName));
  const loadProfiles = useProfilesStore((s) => s.load);
  const { options, info, loading: modelLoading, setting, error: modelError, loadOptions, loadInfo, setMainModel } = useModelStore();
  const config = useConfigStore((s) => s.config);
  const configLoading = useConfigStore((s) => s.loading);
  const configSaving = useConfigStore((s) => s.saving);
  const configError = useConfigStore((s) => s.error);
  const loadConfig = useConfigStore((s) => s.load);
  const updateConfig = useConfigStore((s) => s.update);
  const busyInputMode = normalizeBusyInputMode(config?.display?.busy_input_mode);
  const [stats, setStats] = useState<SystemStats | undefined>();
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | undefined>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [skillSheetOpen, setSkillSheetOpen] = useState(false);
  const [defaultSkill, setDefaultSkill] = useState<string | undefined>(() => readDefaultSkill(activeName));
  useEffect(() => {
    setDefaultSkill(readDefaultSkill(activeName));
  }, [activeName]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort>('high');
  const [selectedShowReasoning, setSelectedShowReasoning] = useState(false);
  const [localSetting, setLocalSetting] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus | undefined>();
  const [pushLoading, setPushLoading] = useState(true);
  const [pushError, setPushError] = useState<string | undefined>();
  const [pushBusy, setPushBusy] = useState(false);
  const [installPromptAvailable, setInstallPromptAvailable] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installOutcome, setInstallOutcome] = useState<string | undefined>();
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance());
  const [confirming, setConfirming] = useState<'logout' | 'clear-cache' | undefined>();
  const [cacheCleared, setCacheCleared] = useState(false);
  // This phone's own subscription, as the browser holds it; the server list
  // also carries the other devices.
  const [deviceSubscribed, setDeviceSubscribed] = useState(false);
  const [deviceCheck, setDeviceCheck] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void hasBrowserPushSubscription().then((value) => {
      if (!cancelled) setDeviceSubscribed(value);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceCheck]);

  const gatewayHost = typeof window !== 'undefined' ? window.location.host : 'hermes.local:9119';
  const authLabel = status?.authRequired
    ? (status.authProviders?.join(', ') || 'Basic')
    : (status ? 'None' : '—');
  const modelLabel = activeProfile?.model ?? info?.model ?? '—';
  const pushProfile = activeName || 'default';
  const pushCapability = useMemo(() => getPushCapability(), []);
  const iosSafari = useMemo(() => isIosSafari(), []);
  const activePushSubscription = pushStatus?.subscriptions.find((sub) => sub.enabled) ?? pushStatus?.subscriptions[0];
  const notificationsUnavailableReason = !pushCapability.supported
    ? (pushCapability.reason ?? 'This browser cannot show notifications.')
    : pushStatus && !pushStatus.available
      ? (pushStatus.reason ?? 'Notifications are not set up on the Mac.')
      : pushStatus && !pushStatus.vapidPublicKey
        ? 'Notifications are not set up on the Mac.'
        : undefined;
  const pushStatusLabel = pushLoading
    ? 'Loading…'
    : pushStatus?.available
      ? 'Available'
      : (pushStatus?.reason ?? pushCapability.reason ?? 'Unavailable');

  useEffect(() => {
    void loadOptions(rest);
    void loadInfo(rest);
    void loadConfig(rest);
  }, [rest, loadOptions, loadInfo, loadConfig]);

  useEffect(() => {
    setStatsLoading(true);
    rest
      .systemStats()
      .then((s) => {
        setStats(s);
        setStatsError(undefined);
      })
      .catch((err) => setStatsError(err instanceof Error ? err.message : 'Failed to load stats'))
      .finally(() => setStatsLoading(false));
  }, [rest]);

  function reloadPushStatus() {
    setPushLoading(true);
    rest
      .pushStatus(pushProfile)
      .then((next) => {
        setPushStatus(next);
        setPushError(undefined);
      })
      .catch((err) => setPushError(err instanceof Error ? err.message : 'Failed to load push status'))
      .finally(() => setPushLoading(false));
  }

  useEffect(() => {
    reloadPushStatus();
    // reloadPushStatus intentionally closes over the latest rest client and push profile only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rest, pushProfile]);

  useEffect(() => {
    const refreshInstallPrompt = () => setInstallPromptAvailable(canPromptInstall());
    refreshInstallPrompt();
    window.addEventListener(INSTALL_PROMPT_CHANGED_EVENT, refreshInstallPrompt);
    window.addEventListener('focus', refreshInstallPrompt);
    return () => {
      window.removeEventListener(INSTALL_PROMPT_CHANGED_EVENT, refreshInstallPrompt);
      window.removeEventListener('focus', refreshInstallPrompt);
    };
  }, []);

  const providersBySlug = useMemo(() => {
    const map = new Map<string, ModelProvider>();
    options?.providers.forEach((p) => map.set(p.slug, p));
    return map;
  }, [options]);

  function openSheet() {
    const providerSlug = activeProfile?.provider ?? info?.provider ?? options?.provider ?? options?.providers[0]?.slug ?? '';
    const provider = providersBySlug.get(providerSlug);
    const model = activeProfile?.model ?? info?.model ?? options?.model ?? provider?.models[0] ?? '';
    setSelectedProvider(providerSlug);
    setSelectedModel(model);
    setSelectedEffort(activeProfile?.reasoningEffort ?? 'high');
    setSelectedShowReasoning(activeProfile?.showReasoning ?? false);
    setSheetOpen(true);
  }

  function closeSheet() {
    setSheetOpen(false);
  }

  function handleProviderChange(providerSlug: string) {
    setSelectedProvider(providerSlug);
    const provider = providersBySlug.get(providerSlug);
    setSelectedModel(provider?.models[0] ?? '');
  }

  async function handleSave() {
    setLocalSetting(true);
    try {
      const result = await setMainModel(rest, selectedProvider, selectedModel, false, activeName, selectedEffort, selectedShowReasoning);
      if (result.confirm_required) {
        const ok = confirm(result.confirm_message ?? 'This model may be expensive. Continue?');
        if (ok) {
          await setMainModel(rest, selectedProvider, selectedModel, true, activeName, selectedEffort, selectedShowReasoning);
        }
      }
      if (activeName) await loadProfiles(rest);
      closeSheet();
    } catch {
      /* error surfaced in store */
    } finally {
      setLocalSetting(false);
    }
  }

  async function handleBusyInputModeChange(mode: BusyInputMode) {
    try {
      await updateConfig(rest, 'display.busy_input_mode', mode);
    } catch {
      /* error surfaced in config store */
    }
  }

  async function handleEnablePush() {
    setPushBusy(true);
    setPushError(undefined);
    try {
      if (!pushStatus?.vapidPublicKey) {
        throw new Error(pushStatus?.reason ?? 'Push server is missing a VAPID public key.');
      }
      await enablePushNotifications(rest, pushStatus.vapidPublicKey, activeName || 'default');
      reloadPushStatus();
      setDeviceCheck((n) => n + 1);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to enable notifications');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleDisablePush() {
    setPushBusy(true);
    setPushError(undefined);
    try {
      await disablePushNotifications(rest, activePushSubscription?.id, pushProfile);
      reloadPushStatus();
      setDeviceCheck((n) => n + 1);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to disable notifications');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleTestPush() {
    if (!activePushSubscription?.id) return;
    setPushBusy(true);
    setPushError(undefined);
    try {
      await rest.pushTest(activePushSubscription.id, pushProfile);
      reloadPushStatus();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to send test notification');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleInstallApp() {
    setInstalling(true);
    setInstallOutcome(undefined);
    try {
      const outcome = await promptInstall();
      setInstallOutcome(outcome === 'unavailable' ? 'Install prompt is not available in this browser right now.' : `Install ${outcome}.`);
      setInstallPromptAvailable(canPromptInstall());
    } finally {
      setInstalling(false);
    }
  }

  const currentProvider = providersBySlug.get(selectedProvider);
  const saving = setting || localSetting;

  return (
    <div className="hm-settings hm-scroll">
      {statsError && <div className="hm-warning-banner hm-warning-banner--error">{statsError}</div>}
      {modelError && <div className="hm-warning-banner hm-warning-banner--error">{modelError}</div>}
      {configError && <div className="hm-warning-banner hm-warning-banner--error">{configError}</div>}
      {pushError && <div className="hm-warning-banner hm-warning-banner--error">{pushError}</div>}

      <Section title="Bots">
        <button
          className="hm-settings-row hm-settings-row--link"
          onClick={() => onNavigate('profiles')}
          aria-label="Manage bots"
        >
          <span className="hm-settings-row__body">
            <span className="hm-settings-row__label">Manage bots</span>
            {activeProfile && (
              <span className="hm-settings-row__sub hm-muted">
                Active: {activeProfile.displayName && activeProfile.displayName !== activeProfile.name ? activeProfile.displayName : botLabel(activeProfile.name)}
              </span>
            )}
          </span>
          <span className="hm-settings-row__chevron" aria-hidden="true">
            <Icon name="chevR" size={14} />
          </span>
        </button>
      </Section>

      <Section title="Appearance">
        <div className="hm-segmented" role="radiogroup" aria-label="Appearance">
          {(['system', 'light', 'dark'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={appearance === value}
              className={`hm-segmented__item${appearance === value ? ' hm-segmented__item--active' : ''}`}
              onClick={() => {
                setAppearance(value);
                writeAppearance(value);
              }}
            >
              {value === 'system' ? 'Automatic' : value === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <p className="hm-settings__footnote hm-muted">Automatic follows the phone's light or dark setting.</p>
      </Section>

      <Section title="Read aloud">
        <ReadAloudSettings rest={rest} />
      </Section>

      <Section title="Connection">
        <SettingsRow label="Gateway URL" value={gatewayHost} />
        <SettingsRow label="Auth" value={authLabel} />
        <SettingsRow
          label="Model"
          value={modelLabel}
          action={
            <button
              type="button"
              className="hm-agent-card__activate"
              onClick={openSheet}
              disabled={modelLoading}
              aria-label="Change model"
            >
              Change
            </button>
          }
        />
        <button
          className="hm-settings-row hm-settings-row--link hm-settings-row--destructive"
          onClick={() => setConfirming('logout')}
          aria-label="Log out"
        >
          <span className="hm-settings-row__label">Log out</span>
          <span className="hm-settings-row__chevron" aria-hidden="true">
            <Icon name="logout" size={14} />
          </span>
        </button>
      </Section>

      <Section title="Notifications">
        <label className="hm-settings-row hm-settings-row--switch">
          <span className="hm-settings-row__body">
            <span className="hm-settings-row__label">Notify this phone</span>
            <span className="hm-settings-row__sub hm-muted">
              {pushLoading
                ? 'Checking…'
                : deviceSubscribed
                  ? 'Approvals and finished replies arrive as notifications.'
                  : notificationsUnavailableReason ?? 'Get a notification when Hermes needs you.'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="hm-switch"
            checked={deviceSubscribed}
            disabled={pushBusy || pushLoading || (!deviceSubscribed && Boolean(notificationsUnavailableReason))}
            onChange={(event) => void (event.target.checked ? handleEnablePush() : handleDisablePush())}
            aria-label="Notify this phone"
          />
        </label>
        {activePushSubscription?.enabled && activePushSubscription.id ? (
          <button
            type="button"
            className="hm-settings-row hm-settings-row--link"
            disabled={pushBusy}
            onClick={() => void handleTestPush()}
          >
            <span className="hm-settings-row__label hm-settings-row__label--accent">{pushBusy ? 'Sending…' : 'Send a test notification'}</span>
          </button>
        ) : null}
        {pushCapability.iosStandaloneRequired ? (
          <p className="hm-settings__footnote hm-muted">On iPhone, add Hermes to the Home Screen first: notifications only work from the installed app.</p>
        ) : null}
        <details className="hm-settings__details">
          <summary className="hm-muted">Details</summary>
          <SettingsRow label="Browser" value={pushCapability.supported ? `Supported · permission ${pushCapability.permission}` : (pushCapability.reason ?? 'Unsupported')} />
          <SettingsRow label="Server" value={pushStatusLabel} />
          <SettingsRow label="Devices" value={pushLoading ? 'Loading…' : String(pushStatus?.subscriptions.filter((sub) => sub.enabled).length ?? 0)} />
        </details>
      </Section>

      <Section title="Install app">
        <SettingsRow
          label="Browser install"
          value={installPromptAvailable ? 'Install prompt ready' : 'Use browser menu or Add to Home Screen'}
        />
        {installPromptAvailable ? (
          <button
            type="button"
            className="hm-filter-chip"
            disabled={installing}
            onClick={() => void handleInstallApp()}
          >
            Install Hermes Mobile
          </button>
        ) : iosSafari ? (
          <p className="hm-muted">iPhone/iPad Safari: tap Share, then choose Add to Home Screen.</p>
        ) : (
          <p className="hm-muted">If no install prompt is available, use your browser menu and choose Add to Home Screen / Install app.</p>
        )}
        {installOutcome && <p className="hm-muted">{installOutcome}</p>}
      </Section>

      <Section title="Chat behavior">
        <button
          type="button"
          className="hm-settings-row hm-settings-row--link"
          onClick={() => setSkillSheetOpen(true)}
          aria-label="Default skill"
        >
          <span className="hm-settings-row__body">
            <span className="hm-settings-row__label">Default skill</span>
            <span className="hm-settings-row__sub hm-muted">
              {defaultSkill ? `New chats on this profile start with /${defaultSkill}` : 'New chats start without a skill'}
            </span>
          </span>
          <span className="hm-settings-row__value hm-muted">{defaultSkill ? `/${defaultSkill}` : 'None'}</span>
          <span className="hm-settings-row__chevron" aria-hidden="true">
            <Icon name="chevR" size={14} />
          </span>
        </button>
        {skillSheetOpen ? (
          <SkillPicker
            rest={rest}
            title="Default skill"
            selected={defaultSkill}
            allowNone
            onPick={(skill) => {
              const slug = skill ? skillCommandSlug(skill.name) : undefined;
              writeDefaultSkill(activeName, slug);
              setDefaultSkill(slug);
              setSkillSheetOpen(false);
            }}
            onClose={() => setSkillSheetOpen(false)}
          />
        ) : null}
        <SettingsRow label="Busy input" value={configLoading ? 'Loading…' : busyInputModeLabel(busyInputMode)} />
        <p className="hm-muted">{busyInputModeDescription(busyInputMode)}</p>
        <div className="hm-settings__segmented" role="radiogroup" aria-label="Busy input mode">
          {(['steer', 'queue', 'interrupt'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`hm-filter-chip ${busyInputMode === mode ? 'hm-filter-chip--active' : ''}`}
              disabled={configLoading || configSaving}
              onClick={() => void handleBusyInputModeChange(mode)}
              role="radio"
              aria-checked={busyInputMode === mode}
            >
              {busyInputModeLabel(mode)}
            </button>
          ))}
        </div>
      </Section>

      <Section title="This phone">
        <button
          type="button"
          className="hm-settings-row hm-settings-row--link hm-settings-row--destructive"
          onClick={() => setConfirming('clear-cache')}
        >
          <span className="hm-settings-row__body">
            <span className="hm-settings-row__label">Clear saved chats on this phone</span>
            <span className="hm-settings-row__sub hm-muted">
              {cacheCleared ? 'Cleared. Chats are still on the Mac, under Sessions.' : 'Cached transcripts and unsent drafts. Chats on the Mac stay.'}
            </span>
          </span>
        </button>
      </Section>

      <Section title="About">
        <SettingsRow label="PWA client" value={HERMES_PWA_VERSION_LABEL} />
        <SettingsRow label="Hermes backend" value={statsLoading ? 'Loading…' : (stats?.version ?? '—')} />
        <button
          className="hm-settings-row hm-settings-row--link"
          onClick={() => onNavigate('command')}
          aria-label="Open system command center"
        >
          <span className="hm-settings-row__body">
            <span className="hm-settings-row__label">System command center</span>
            <span className="hm-settings-row__sub hm-muted">Restart, update, doctor</span>
          </span>
          <span className="hm-settings-row__chevron" aria-hidden="true">
            <Icon name="chevR" size={14} />
          </span>
        </button>
      </Section>

      {confirming === 'logout' ? (
        <ConfirmSheet
          title="Log out of Hermes?"
          message="Chats cached on this phone and unsent drafts are cleared. Everything on the Mac stays."
          confirmLabel="Log out"
          destructive
          onConfirm={onLogout}
          onClose={() => setConfirming(undefined)}
        />
      ) : null}
      {confirming === 'clear-cache' ? (
        <ConfirmSheet
          title="Clear saved chats?"
          message="The transcripts and drafts this phone keeps for a fast start are removed. The chats themselves stay on the Mac."
          confirmLabel="Clear"
          destructive
          onConfirm={() => {
            clearLocalChatCache();
            useChatStore.getState().clear(activeName);
            setCacheCleared(true);
          }}
          onClose={() => setConfirming(undefined)}
        />
      ) : null}

      {sheetOpen && (
        <BottomSheet
          title="Model"
          onClose={closeSheet}
          closeDisabled={saving}
          footer={
            <div className="hm-projects__inline-actions">
              <button
                type="button"
                className="hm-primary hm-projects__inline-save"
                disabled={saving || !selectedProvider || !selectedModel}
                onClick={() => void handleSave()}
              >
                {saving ? 'Saving…' : 'Save model'}
              </button>
              <button type="button" className="hm-ghost" onClick={closeSheet} disabled={saving}>
                Cancel
              </button>
            </div>
          }
        >
              <div className="hm-projects__field">
                <label className="hm-projects__label">Provider</label>
                <select
                  className="hm-select"
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={saving}
                >
                  {options?.providers.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name} {p.authenticated ? '✓' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hm-projects__field">
                <label className="hm-projects__label">Model</label>
                <select
                  className="hm-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={saving}
                >
                  {currentProvider?.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hm-projects__field">
                <label className="hm-projects__label">Reasoning effort</label>
                <select
                  className="hm-select"
                  value={selectedEffort}
                  onChange={(e) => setSelectedEffort(e.target.value as ReasoningEffort)}
                  disabled={saving}
                >
                  {REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {reasoningLabel(effort)}
                    </option>
                  ))}
                </select>
              </div>

              <label className="hm-settings-row hm-settings-row--checkbox">
                <input
                  type="checkbox"
                  checked={selectedShowReasoning}
                  onChange={(e) => setSelectedShowReasoning(e.target.checked)}
                  disabled={saving}
                />
                <span>Show thinking / reasoning in chat</span>
              </label>
        </BottomSheet>
      )}
    </div>
  );
}
