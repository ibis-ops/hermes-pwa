import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { skillCommandSlug, type Message, type RestClient, type RpcClient, type Skill } from '@hermes-pwa/core';
import { Icon } from './Icon';
import { AttachMenu } from './AttachMenu';
import { SkillPicker } from './SkillPicker';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { useVoiceConversation } from '../hooks/useVoiceConversation';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_SELECTION,
  attachmentTooLargeMessage,
  isAllowedAttachmentMime,
  tooManyAttachmentsMessage,
  unsupportedAttachmentTypeMessage,
} from './attachmentLimits';

export interface AttachmentDraft {
  id: string;
  name: string;
  path: string;
  uploading?: boolean;
  error?: string;
  /** Object URL for an image thumbnail while the draft is in the composer. */
  previewUrl?: string;
}

interface SlashCommandItem {
  command: string;
  display: string;
  description: string;
  group: string;
}

interface RawSlashEntry {
  text?: unknown;
  display?: unknown;
  meta?: unknown;
  group?: unknown;
}

const PWA_HIDDEN_SLASH_COMMANDS = new Set(['/whoami']);

function textValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (Array.isArray(part)) return String(part[1] ?? '');
        return '';
      })
      .join('')
      .trim();
  }
  return fallback;
}

function commandText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function slashCommandBase(command: string): string {
  return commandText(command).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
}

function isPwaSlashSuggestion(command: string): boolean {
  return !PWA_HIDDEN_SLASH_COMMANDS.has(slashCommandBase(command));
}

function slashItemFromEntry(entry: RawSlashEntry, fallbackGroup = 'Commands'): SlashCommandItem | null {
  const command = commandText(textValue(entry.text));
  if (!command || !command.startsWith('/') || !isPwaSlashSuggestion(command)) return null;
  const display = textValue(entry.display, command);
  return {
    command,
    display: display.startsWith('/') ? display : commandText(display),
    description: textValue(entry.meta),
    group: textValue(entry.group, fallbackGroup),
  };
}

function normalizeSlashItems(raw: unknown): SlashCommandItem[] {
  const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const pushUnique = (items: SlashCommandItem[], item: SlashCommandItem | null) => {
    if (!item || seen.has(item.command)) return;
    seen.add(item.command);
    items.push(item);
  };
  const items: SlashCommandItem[] = [];

  if (Array.isArray(result.categories)) {
    for (const category of result.categories) {
      if (!category || typeof category !== 'object') continue;
      const record = category as Record<string, unknown>;
      const group = textValue(record.name, 'Commands');
      const pairs = Array.isArray(record.pairs) ? record.pairs : [];
      for (const pair of pairs) {
        if (!Array.isArray(pair)) continue;
        pushUnique(items, slashItemFromEntry({ text: pair[0], display: pair[0], meta: pair[1], group }, group));
      }
    }
  }

  if (Array.isArray(result.pairs)) {
    for (const pair of result.pairs) {
      if (!Array.isArray(pair)) continue;
      pushUnique(items, slashItemFromEntry({ text: pair[0], display: pair[0], meta: pair[1], group: 'Commands' }));
    }
  }

  if (Array.isArray(result.items)) {
    for (const entry of result.items) {
      if (!entry || typeof entry !== 'object') continue;
      pushUnique(items, slashItemFromEntry(entry as RawSlashEntry));
    }
  }

  return items;
}

function shouldShowSlashPalette(text: string): boolean {
  return /^\/[^\n]*$/u.test(text);
}

function insertSlashCommand(command: string): string {
  const normalized = commandText(command);
  if (!normalized) return '';
  return normalized.includes(' ') ? normalized : `${normalized} `;
}

interface ComposerProps {
  onSend: (text: string) => void;
  slashCommandsRpc?: RpcClient;
  onSteer?: (text: string) => void;
  busySubmitLabel?: string;
  onStop: () => void;
  busy: boolean;
  placeholder?: string;
  messages?: Message[];
  onTranscribeAudio?: (audio: Blob) => Promise<string>;
  onSpeakVoiceText?: (text: string) => Promise<void>;
  onStopVoiceAudio?: () => void;
  onPrimeVoiceAudio?: () => void;
  onUploadFile?: (file: File) => Promise<{ path: string } | string | undefined>;
  onLayoutChange?: () => void;
  /** Enables "Use a skill" in the plus menu; the picker lists Hermes's skills through it. */
  rest?: RestClient | undefined;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function Composer({
  onSend,
  slashCommandsRpc,
  onSteer,
  busySubmitLabel = 'Steer agent',
  onStop,
  busy,
  placeholder = 'Message Hermes…',
  messages = [],
  onTranscribeAudio,
  onSpeakVoiceText,
  onStopVoiceAudio,
  onPrimeVoiceAudio,
  onUploadFile,
  onLayoutChange,
  rest,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [slashItems, setSlashItems] = useState<SlashCommandItem[]>([]);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashError, setSlashError] = useState<string | undefined>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashSuppressedText, setSlashSuppressedText] = useState<string | undefined>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaHeightRef = useRef<string>('');

  const hasText = text.trim().length > 0;
  const hasPayload = hasText || attachments.some((a) => !a.uploading && !a.error && a.path);
  const slashPaletteOpen = shouldShowSlashPalette(text) && Boolean(slashCommandsRpc) && slashSuppressedText !== text;

  const handleTranscript = useCallback((transcript: string) => {
    setText((prev) => {
      const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
      return `${prev}${sep}${transcript}`;
    });
  }, []);

  const focusInput = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const voiceRecorder = useVoiceRecorder({
    onTranscribeAudio,
    onTranscript: handleTranscript,
    onFocusInput: focusInput,
  });

  const voiceConversation = useVoiceConversation({
    enabled: voiceModeEnabled,
    busy,
    messages,
    onSubmit: onSend,
    onTranscribeAudio,
    onSpeakText: onSpeakVoiceText,
    onStopSpeech: onStopVoiceAudio,
    onPrimeAudio: onPrimeVoiceAudio,
  });

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = window.matchMedia('(max-width: 380px)').matches ? 88 : 96;
    const nextHeight = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.height = nextHeight;
    if (textareaHeightRef.current !== nextHeight) {
      textareaHeightRef.current = nextHeight;
      onLayoutChange?.();
    }
  }, [onLayoutChange]);

  useEffect(() => {
    resize();
  }, [text, resize]);

  useEffect(() => {
    if (!slashPaletteOpen || !slashCommandsRpc) {
      setSlashItems([]);
      setSlashLoading(false);
      setSlashError(undefined);
      setSlashActiveIndex(0);
      return;
    }

    let cancelled = false;
    setSlashLoading(true);
    setSlashError(undefined);

    const load = async () => {
      try {
        const raw = text === '/'
          ? await slashCommandsRpc.request('commands.catalog')
          : await slashCommandsRpc.request('complete.slash', { text });
        if (cancelled) return;
        const items = normalizeSlashItems(raw).slice(0, 24);
        setSlashItems(items);
        setSlashActiveIndex(0);
        setSlashError(undefined);
      } catch (err) {
        if (cancelled) return;
        setSlashItems([]);
        setSlashError(err instanceof Error ? err.message : 'Slash commands unavailable');
      } finally {
        if (!cancelled) setSlashLoading(false);
      }
    };

    const timer = window.setTimeout(load, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [slashPaletteOpen, slashCommandsRpc, text]);

  const groupedSlashItems = useMemo(() => {
    const groups: Array<{ name: string; items: Array<{ item: SlashCommandItem; index: number }> }> = [];
    slashItems.forEach((item, index) => {
      const groupName = item.group || 'Commands';
      let group = groups.find((candidate) => candidate.name === groupName);
      if (!group) {
        group = { name: groupName, items: [] };
        groups.push(group);
      }
      group.items.push({ item, index });
    });
    return groups;
  }, [slashItems]);

  const closeSlashPalette = useCallback(() => {
    setSlashItems([]);
    setSlashLoading(false);
    setSlashError(undefined);
    setSlashActiveIndex(0);
  }, []);

  const applySkill = useCallback((skill: Skill | undefined) => {
    setSkillPickerOpen(false);
    if (!skill) return;
    const slug = skillCommandSlug(skill.name);
    if (!slug) return;
    // Replace a leading slash command, keep anything already typed as the instruction.
    const instruction = text.replace(/^\s*\/\S*\s*/u, '').trimStart();
    const inserted = `/${slug} ${instruction}`;
    setText(inserted);
    setSlashSuppressedText(inserted);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(inserted.length, inserted.length);
    });
  }, [text]);

  const selectSlashCommand = useCallback(
    (item: SlashCommandItem) => {
      const inserted = insertSlashCommand(item.command);
      setText(inserted);
      setSlashSuppressedText(inserted);
      closeSlashPalette();
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        resize();
      });
    },
    [closeSlashPalette, resize],
  );

  const toggleVoiceMode = useCallback(() => {
    setVoiceModeEnabled((value) => {
      const next = !value;
      if (next) {
        onPrimeVoiceAudio?.();
      } else {
        onStopVoiceAudio?.();
      }
      return next;
    });
  }, [onPrimeVoiceAudio, onStopVoiceAudio]);

  function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (voiceRecorder.status !== 'idle' || voiceConversation.status === 'transcribing') return;
    const trimmed = text.trim();
    const refs = attachments
      .filter((a) => !a.uploading && !a.error && a.path)
      .map((a) => `@file:${a.path}`);
    const finalText = [trimmed, ...refs].filter(Boolean).join('\n\n');
    if (!finalText) return;
    if (busy) {
      if (!onSteer) return;
      onSteer(finalText);
    } else {
      onSend(finalText);
    }
    setText('');
    setSlashSuppressedText(undefined);
    setAttachments((prev) => {
      prev.forEach(releasePreview);
      return [];
    });
    closeSlashPalette();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashPaletteOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashPalette();
        return;
      }
      if (slashItems.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setSlashActiveIndex((index) => {
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          return (index + delta + slashItems.length) % slashItems.length;
        });
        return;
      }
      if (slashItems.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
        e.preventDefault();
        selectSlashCommand(slashItems[Math.min(slashActiveIndex, slashItems.length - 1)]!);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || !onUploadFile) return;
    const selected = Array.from(files).map((file, index) => {
      const error =
        index >= MAX_ATTACHMENTS_PER_SELECTION
          ? tooManyAttachmentsMessage()
          : file.size > MAX_ATTACHMENT_BYTES
            ? attachmentTooLargeMessage(file.name)
            : !isAllowedAttachmentMime(file)
              ? unsupportedAttachmentTypeMessage(file.name, file.type)
              : undefined;
      const previewUrl =
        !error && file.type.startsWith('image/') && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : undefined;
      const draft: AttachmentDraft = error
        ? { id: makeId(), name: file.name, path: '', uploading: false, error }
        : { id: makeId(), name: file.name, path: '', uploading: true, ...(previewUrl ? { previewUrl } : {}) };
      return {
        file,
        draft,
        error,
      };
    });
    setAttachments((prev) => [...prev, ...selected.map((item) => item.draft)]);

    await Promise.all(
      selected
        .filter((item) => !item.error)
        .map(async ({ file, draft }) => {
          try {
            const result = await onUploadFile(file);
            const path = typeof result === 'string' ? result : result?.path;
            if (!path) throw new Error('Upload did not return a path.');
            setAttachments((prev) =>
              prev.map((a) => (a.id === draft.id ? { ...a, path, uploading: false } : a)),
            );
          } catch (err) {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === draft.id
                  ? { ...a, uploading: false, error: err instanceof Error ? err.message : 'Upload failed' }
                  : a,
              ),
            );
          }
        }),
    );
  }

  function releasePreview(draft: AttachmentDraft | undefined) {
    if (draft?.previewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(draft.previewUrl);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      releasePreview(prev.find((a) => a.id === id));
      return prev.filter((a) => a.id !== id);
    });
  }

  const isRecording = voiceRecorder.status === 'recording';
  const isDictating = voiceRecorder.status === 'recording' || voiceRecorder.status === 'transcribing';
  const isVoiceBusy =
    voiceRecorder.status === 'transcribing' ||
    voiceConversation.status === 'listening' ||
    voiceConversation.status === 'transcribing' ||
    voiceConversation.status === 'thinking' ||
    voiceConversation.status === 'speaking';

  return (
    <form className="hm-composer" onSubmit={handleSubmit}>
      {attachments.length > 0 && (
        <div className="hm-composer__attachments">
          {attachments.map((a) => (
            <span
              key={a.id}
              className={`hm-composer__chip ${a.error ? 'hm-composer__chip--error' : ''} ${a.previewUrl ? 'hm-composer__chip--image' : ''}`}
            >
              {a.previewUrl ? (
                <img className="hm-composer__chip-thumb" src={a.previewUrl} alt="" aria-hidden="true" />
              ) : (
                <span className="hm-composer__chip-icon" aria-hidden="true">
                  <Icon name="file" size={13} />
                </span>
              )}
              <span className="hm-composer__chip-name">{a.name}</span>
              {a.uploading && <span className="hm-composer__chip-spin" />}
              {a.error && <span className="hm-composer__chip-error" aria-label={a.error} />}
              {!a.uploading && (
                <button
                  type="button"
                  className="hm-composer__chip-remove"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {slashPaletteOpen && (
        <div className="hm-slash-palette" role="listbox" aria-label="Slash commands">
          <div className="hm-slash-palette__header">
            <span>Slash commands</span>
            {slashLoading ? <span className="hm-slash-palette__status">Loading…</span> : null}
          </div>
          {slashError ? <div className="hm-slash-palette__empty">{slashError}</div> : null}
          {!slashError && !slashLoading && slashItems.length === 0 ? (
            <div className="hm-slash-palette__empty">No matching commands</div>
          ) : null}
          {!slashError && groupedSlashItems.map((group) => (
            <div className="hm-slash-palette__group" key={group.name}>
              <div className="hm-slash-palette__group-title">{group.name}</div>
              {group.items.map(({ item, index }) => (
                <button
                  key={`${item.command}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === slashActiveIndex}
                  className={`hm-slash-palette__item ${index === slashActiveIndex ? 'hm-slash-palette__item--active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(item)}
                >
                  <span className="hm-slash-palette__command">{item.display}</span>
                  {item.description ? <span className="hm-slash-palette__description">{item.description}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="hm-composer__pill" data-has-text={hasText ? 'true' : 'false'} data-busy={busy ? 'true' : 'false'}>
        <button
          type="button"
          className="hm-composer__action hm-composer__action--attach"
          onClick={() => setAttachMenuOpen((v) => !v)}
          disabled={isRecording || isVoiceBusy || (!onUploadFile && !rest)}
          aria-label="Add attachment or skill"
        >
          <Icon name="plus" size={19} />
        </button>
        <AttachMenu
          open={attachMenuOpen}
          onClose={() => setAttachMenuOpen(false)}
          onFiles={handleFilesSelected}
          onSkill={rest ? () => setSkillPickerOpen(true) : undefined}
        />
        {skillPickerOpen && rest ? (
          <SkillPicker rest={rest} title="Use a skill" onPick={applySkill} onClose={() => setSkillPickerOpen(false)} />
        ) : null}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            const nextText = e.target.value;
            setText(nextText);
            if (slashSuppressedText !== undefined && nextText !== slashSuppressedText) {
              setSlashSuppressedText(undefined);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            voiceConversation.active
              ? voiceConversation.status === 'listening'
                ? 'Listening… tap the wave to stop'
                : 'Voice mode is on'
              : placeholder
          }
          disabled={isRecording || isVoiceBusy}
          aria-label="Message input"
          rows={1}
        />

        <button
          type="button"
          className={`hm-composer__action hm-composer__action--mic ${isRecording ? 'hm-composer__action--recording' : ''}`}
          onClick={voiceRecorder.dictate}
          disabled={isVoiceBusy}
          aria-label={isRecording ? 'Stop recording' : 'Record voice'}
        >
          <Icon name="mic" size={19} />
          {isRecording && (
            <span className="hm-composer__timer">{formatDuration(voiceRecorder.elapsedSeconds)}</span>
          )}
        </button>

        <button
          type="button"
          className={`hm-composer__action hm-composer__action--voice ${voiceConversation.active ? 'hm-composer__action--active' : ''}`}
          onClick={toggleVoiceMode}
          disabled={isRecording}
          aria-label={voiceConversation.active ? 'Turn off voice mode' : 'Turn on voice mode'}
        >
          <Icon name="wave" size={19} />
        </button>

        {busy && !hasPayload ? (
          <button
            type="button"
            className="hm-composer__stop"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Icon name="close" size={16} />
          </button>
        ) : (
          <button
            type="submit"
            className="hm-composer__send"
            disabled={!hasPayload || isRecording || isVoiceBusy || (busy && !onSteer)}
            aria-label={busy ? busySubmitLabel : 'Send message'}
          >
            <Icon name="arrowUp" size={20} />
          </button>
        )}
      </div>

      {isDictating && (
        <div className="hm-composer__voice-bar" role="status" aria-live="polite">
          <span className="hm-composer__voice-status">
            {voiceRecorder.status === 'recording'
              ? `Recording ${formatDuration(voiceRecorder.elapsedSeconds)} · tap mic to finish`
              : 'Transcribing voice…'}
          </span>
          <div className="hm-composer__voice-levels">
            {Array.from({ length: 5 }).map((_, i) => (
              <span
                key={i}
                className="hm-composer__voice-level"
                style={{
                  opacity:
                    voiceRecorder.status === 'recording'
                      ? Math.min(1, voiceRecorder.level * 1.5 + i * 0.15)
                      : 0.25,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {voiceModeEnabled && (
        <div className="hm-composer__voice-bar">
          <span className="hm-composer__voice-status">
            {voiceConversation.status === 'idle' && 'Voice mode on'}
            {voiceConversation.status === 'listening' && 'Listening'}
            {voiceConversation.status === 'transcribing' && 'Transcribing'}
            {voiceConversation.status === 'thinking' && 'Thinking'}
            {voiceConversation.status === 'speaking' && 'Speaking'}
          </span>
          <div className="hm-composer__voice-levels">
            {Array.from({ length: 5 }).map((_, i) => (
              <span
                key={i}
                className="hm-composer__voice-level"
                style={{
                  opacity:
                    voiceConversation.status === 'listening'
                      ? Math.min(1, voiceConversation.level * 1.5 + i * 0.15)
                      : 0.25,
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="hm-composer__voice-mute"
            onClick={voiceConversation.toggleMute}
            aria-label={voiceConversation.muted ? 'Unmute' : 'Mute'}
          >
            <Icon name={voiceConversation.muted ? 'play' : 'pause'} size={14} />
          </button>
        </div>
      )}
    </form>
  );
}
