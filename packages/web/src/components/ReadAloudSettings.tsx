import { useEffect, useState } from 'react';
import { HermesHttpError, type RestClient, type SpeechVoice, type SpeechVoices } from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { useReadAloud } from '../hooks/useReadAloud';
import { readAloud } from '../lib/readAloud';
import { READ_ALOUD_RATES, readReadAloudSettings, writeReadAloudSettings, type ReadAloudSettings as Settings } from '../lib/readAloudSettings';

const SAMPLE_ID = 'read-aloud-sample';
const SAMPLE_TEXT = 'This is how replies sound when you tap Listen.';

const ACCENTS: Record<string, string> = {
  'en-US': 'American',
  'en-GB': 'British',
  'en-AU': 'Australian',
  'en-IE': 'Irish',
  'en-IN': 'Indian',
  'en-ZA': 'South African',
  'en-SC': 'Scottish',
};

function voiceDetail(voice: SpeechVoice): string {
  const accent = ACCENTS[voice.lang] ?? voice.lang;
  if (voice.quality === 'premium') return `${accent} · Premium`;
  if (voice.quality === 'enhanced') return `${accent} · Enhanced`;
  return accent;
}

interface VoicePickerProps {
  voices: SpeechVoice[];
  automatic: SpeechVoice | undefined;
  selected: string | undefined;
  onPick: (voice: SpeechVoice | undefined) => void;
  onClose: () => void;
}

function VoicePicker({ voices, automatic, selected, onPick, onClose }: VoicePickerProps) {
  const rows: Array<{ key: string; voice: SpeechVoice | undefined; name: string; detail: string }> = [
    {
      key: 'automatic',
      voice: undefined,
      name: 'Automatic',
      detail: automatic ? `The best voice on your Mac, now ${automatic.name}` : 'The best voice on your Mac',
    },
    ...voices.map((voice) => ({ key: voice.id, voice, name: voice.name, detail: voiceDetail(voice) })),
  ];
  return (
    <BottomSheet title="Voice" onClose={onClose} className="hm-sheet--voices" contentClassName="hm-skill-picker">
      <div className="hm-skill-picker__group">
        {rows.map((row) => {
          const isSelected = row.voice ? row.voice.id === selected : selected === undefined;
          return (
            <button
              key={row.key}
              type="button"
              className={`hm-skill-picker__row ${isSelected ? 'hm-skill-picker__row--selected' : ''}`}
              onClick={() => onPick(row.voice)}
              aria-pressed={isSelected}
              data-testid="voice-row"
            >
              <span className="hm-skill-picker__body">
                <span className="hm-skill-picker__name">{row.name}</span>
                <span className="hm-skill-picker__desc hm-muted">{row.detail}</span>
              </span>
              {isSelected ? <Icon name="check" size={16} /> : null}
            </button>
          );
        })}
      </div>
      <p className="hm-muted hm-voice-picker__note">Picking a voice plays a short sample.</p>
    </BottomSheet>
  );
}

/**
 * Settings for Listen under replies: the Mac voice that reads them, the
 * speed, and a sample. The voices are the ones installed on the Mac that runs
 * Hermes; the speech is made there, so reply text stays on the Mac.
 */
export function ReadAloudSettings({ rest }: { rest: RestClient }) {
  const [settings, setSettings] = useState<Settings>(() => readReadAloudSettings());
  const [voices, setVoices] = useState<SpeechVoices | undefined>(undefined);
  // Why the Mac's voices are missing: an old dashboard still running, or no Mac speech at all.
  const [failed, setFailed] = useState<'restart' | 'unreachable' | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const reading = useReadAloud();

  useEffect(() => {
    let alive = true;
    rest
      .speechVoices()
      .then((result) => {
        if (alive) setVoices(result);
      })
      .catch((err: unknown) => {
        if (alive) setFailed(err instanceof HermesHttpError && err.status === 404 ? 'restart' : 'unreachable');
      });
    return () => {
      alive = false;
    };
  }, [rest]);

  const update = (next: Settings) => {
    setSettings(next);
    writeReadAloudSettings(next);
  };

  const macVoices = voices?.available ? voices.voices : [];
  const onMac = macVoices.length > 0;
  const automatic = macVoices.find((voice) => voice.id === voices?.defaultVoice) ?? macVoices[0];
  const chosen = settings.voice ? macVoices.find((voice) => voice.id === settings.voice) : undefined;
  const hasNaturalVoice = macVoices.some((voice) => voice.quality !== 'standard');
  const sampling = reading.messageId === SAMPLE_ID && reading.status !== 'idle';
  const checking = voices === undefined && failed === undefined;
  const voiceValue = checking ? 'Checking…' : onMac ? (chosen?.name ?? `Automatic (${automatic?.name ?? 'best'})`) : 'This phone';

  return (
    <>
      <button
        type="button"
        className="hm-settings-row hm-settings-row--link"
        onClick={() => setPickerOpen(true)}
        disabled={!onMac}
        aria-label="Read aloud voice"
      >
        <span className="hm-settings-row__body">
          <span className="hm-settings-row__label">Voice</span>
          <span className="hm-settings-row__sub hm-muted">
            {checking
              ? 'Looking for the voices on your Mac.'
              : onMac
                ? 'Spoken on your Mac, so reply text stays there.'
                : failed === 'restart'
                  ? "Your Mac's voices turn on once the Hermes dashboard restarts. Until then this phone reads."
                  : failed === 'unreachable'
                    ? 'Could not reach your Mac just now, so this phone reads.'
                    : 'Hermes cannot speak on its computer, so this phone reads instead.'}
          </span>
        </span>
        <span className="hm-settings-row__value hm-muted" data-testid="read-aloud-voice">
          {voiceValue}
        </span>
        {onMac ? (
          <span className="hm-settings-row__chevron" aria-hidden="true">
            <Icon name="chevR" size={14} />
          </span>
        ) : null}
      </button>
      <div className="hm-segmented" role="radiogroup" aria-label="Reading speed">
        {READ_ALOUD_RATES.map(({ label, value }) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={settings.rate === value}
            className={`hm-segmented__item${settings.rate === value ? ' hm-segmented__item--active' : ''}`}
            onClick={() => update({ ...settings, rate: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" className="hm-settings-row hm-settings-row--link" onClick={() => readAloud.toggle(SAMPLE_ID, SAMPLE_TEXT)}>
        <span className="hm-settings-row__label hm-settings-row__label--accent">{sampling ? 'Stop the sample' : 'Play a sample'}</span>
      </button>
      {reading.messageId === SAMPLE_ID && reading.error ? (
        <p className="hm-settings__footnote hm-message__meta-error" role="status">
          {reading.error}
        </p>
      ) : null}
      {onMac && !hasNaturalVoice ? (
        <p className="hm-settings__footnote hm-muted" data-testid="premium-voice-hint">
          For a more natural voice, download a Premium voice such as Ava or Zoe on your Mac: System Settings › Accessibility › Read
          &amp; Speak › System voice › Manage Voices. It shows up here once it is installed.
        </p>
      ) : null}
      {pickerOpen ? (
        <VoicePicker
          voices={macVoices}
          automatic={automatic}
          selected={settings.voice}
          onPick={(voice) => {
            const next = { ...settings, voice: voice?.id };
            update(next);
            const name = voice?.name ?? automatic?.name;
            readAloud.start(SAMPLE_ID, name ? `Hi, this is ${name}. ${SAMPLE_TEXT}` : SAMPLE_TEXT);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  );
}
