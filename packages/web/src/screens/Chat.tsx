import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useChatStore,
  useConnectionStore,
  useSessionsStore,
  useProfilesStore,
  useActivityStore,
  useConfigStore,
  sessionSourceLabel,
  type RpcClient,
  type RestClient,
} from '@hermes-pwa/core';
import { MessageBubble } from '../components/MessageBubble';
import { Composer } from '../components/Composer';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentTooLargeMessage,
  isAllowedAttachmentMime,
  safeAttachmentBasename,
  unsupportedAttachmentTypeMessage,
} from '../components/attachmentLimits';
import { Icon } from '../components/Icon';
import { parseMaybeObject } from '../lib/toolView';
import { pendingApprovalsForMessage, selectPendingApprovals } from '../lib/pendingApprovals';

interface ChatProps {
  rpc: RpcClient;
  rest: RestClient;
}

type BusyInputMode = 'queue' | 'steer' | 'interrupt';
type LiveStatus = { text: string };

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
// eslint-disable-next-line no-control-regex -- strips C0/DEL bytes from legacy gateway status frames.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]+/gu;
const NON_CHAT_STATUS_KINDS = new Set(['lifecycle', 'compress', 'compressing', 'compression']);
const NON_CHAT_STATUS_TEXT = /\b(compacting context|summarizing earlier conversation|compression summary|preflight compression)\b/i;
const CHAT_HISTORY_REFRESH_INTERVAL_MS = 5_000;
const SILENT_WAV_DATA_URL =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

function normalizeBusyInputMode(value: unknown): BusyInputMode {
  return value === 'queue' || value === 'interrupt' || value === 'steer' ? value : 'queue';
}

function latestStatusSegment(value: unknown): string {
  if (typeof value !== 'string') return '';
  const withoutAnsi = value.replace(ANSI_ESCAPE_PATTERN, '');
  return withoutAnsi
    .split(/[\r\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1) ?? '';
}

function cleanLiveStatus(value: unknown): string {
  return latestStatusSegment(value).replace(CONTROL_CHAR_PATTERN, ' ').replace(/\s+/gu, ' ').trim();
}

function extractMessageText(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.rendered === 'string') return payload.rendered;
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message === 'string') return payload.message;
  if (payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)) {
    const message = payload.message as Record<string, unknown>;
    if (typeof message.text === 'string') return message.text;
    if (typeof message.content === 'string') return message.content;
    if (typeof message.rendered === 'string') return message.rendered;
  }
  return undefined;
}

function extractLiveStatus(payload: Record<string, unknown> | undefined): LiveStatus | undefined {
  const text = cleanLiveStatus(payload?.text);
  return text ? { text } : undefined;
}

function isNonChatStatus(kind: string, payload: Record<string, unknown> | undefined): boolean {
  if (NON_CHAT_STATUS_KINDS.has(kind)) return true;
  const rawText = typeof payload?.text === 'string' ? payload.text : '';
  return NON_CHAT_STATUS_TEXT.test(rawText);
}

export function Chat({ rpc, rest }: ChatProps) {
  const {
    messages,
    streaming,
    submit,
    steer,
    interrupt,
    ensureLiveSession,
    error,
    sessionId,
    storedSessionId,
  } = useChatStore();
  const pendingApprovals = useActivityStore(useShallow((s) => selectPendingApprovals(s.items)));
  const pendingApprovalCount = pendingApprovals.length;
  const { sessions, load } = useSessionsStore();
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.load);
  const busyInputMode = normalizeBusyInputMode(config?.display?.busy_input_mode);
  const activeName = useProfilesStore((s) => s.activeName);
  const currentName = useProfilesStore((s) => s.currentName);
  const connection = useConnectionStore();
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollFrameKindRef = useRef<'animation' | 'timeout'>('animation');
  const restoredRef = useRef(false);
  const initialRestoreDoneRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const queuedPromptsRef = useRef<string[]>([]);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceAudioSequenceRef = useRef(0);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>({ text: '' });
  const [composerLayoutVersion, setComposerLayoutVersion] = useState(0);
  const profileForSubmit = activeName === currentName ? activeName : currentName;
  const activeSessionIds = useMemo(
    () => [sessionId, storedSessionId].filter((value): value is string => Boolean(value)),
    [sessionId, storedSessionId],
  );

  const enqueuePrompt = useCallback((text: string, options: { front?: boolean } = {}) => {
    if (options.front) {
      queuedPromptsRef.current.unshift(text);
    } else {
      queuedPromptsRef.current.push(text);
    }
  }, []);

  const handleComposerLayoutChange = useCallback(() => {
    setComposerLayoutVersion((value) => value + 1);
  }, []);

  const markLocalInputShouldScroll = useCallback(() => {
    atBottomRef.current = true;
    forceScrollRef.current = true;
  }, []);

  const drainQueuedPrompt = useCallback(() => {
    const next = queuedPromptsRef.current.shift();
    if (next) {
      markLocalInputShouldScroll();
      void submit(rpc, next, profileForSubmit).then((result) => {
        if (result === 'busy') {
          enqueuePrompt(next, { front: true });
        }
      });
    }
  }, [enqueuePrompt, markLocalInputShouldScroll, rpc, submit, profileForSubmit]);

  useEffect(() => {
    if (connection.state !== 'connected' || restoredRef.current) return;
    restoredRef.current = true;
    void loadConfig(rest);
    if (activeName && activeName !== currentName) {
      // The gateway is running a different profile; avoid auto-restoring a session
      // that belongs to the selected profile over a single-profile WebSocket.
      useChatStore.getState().clear(activeName);
      void load(rest);
      initialRestoreDoneRef.current = true;
      return;
    }

    let cancelled = false;
    void (async () => {
      // Restore depends on the session list for openable-head resolution. Loading
      // first lets the chat resolve the current compressed head instead of stale
      // cached/tool-only history.
      await load(rest);
      if (cancelled) return;
      // Cached messages are only a visual fallback. The cached live session_id can
      // be stale after dashboard/gateway reload, so always reconcile it against
      // the backend before the next prompt.submit.
      try {
        await useChatStore.getState().restore(rest, rpc, activeName);
      } finally {
        if (!cancelled) initialRestoreDoneRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.state, load, loadConfig, rpc, rest, activeName, currentName]);

  useEffect(() => {
    if (connection.state !== 'connected') return undefined;
    if (activeName && activeName !== currentName) return undefined;
    const refresh = () => {
      if (!initialRestoreDoneRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      void (async () => {
        try {
          // Refresh the session list first. Sessions can rotate to a newer stored
          // head after compression or gateway resume; refreshHistory resolves
          // stale aliases through useSessionsStore.
          await load(rest);
          await useChatStore.getState().refreshHistory(rest, activeName);
        } finally {
          refreshInFlightRef.current = false;
        }
      })();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    refresh();
    const interval = window.setInterval(refresh, CHAT_HISTORY_REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [connection.state, load, rest, activeName, currentName]);

  useEffect(() => {
    const refreshActiveHistory = async () => {
      await useSessionsStore.getState().load(rest);
      await useChatStore.getState().refreshHistory(rest, activeName);
    };

    const eventBelongsToActiveChat = (e: import('@hermes-pwa/core').RpcEvent) => {
      const { sessionId, storedSessionId, streaming, cacheProfile } = useChatStore.getState();
      if (!e.sessionId) {
        const profileMatches = !activeName || !cacheProfile || cacheProfile === activeName;
        return streaming && profileMatches && Boolean(sessionId || storedSessionId);
      }
      return e.sessionId === sessionId || e.sessionId === storedSessionId;
    };
    const beginAssistant = () => {
      useChatStore.getState().beginAssistant();
    };
    const onMessageStart = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
    };
    const onDelta = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      useChatStore.getState().appendDelta(typeof payload?.text === 'string' ? payload.text : '');
    };
    const onDone = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      const finalText = extractMessageText(payload);
      useChatStore.getState().finishAssistant(finalText);
      setLiveStatus({ text: '' });
      void refreshActiveHistory();
      drainQueuedPrompt();
    };
    const extractToolInput = (payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
      if (!payload) return undefined;
      const base: Record<string, unknown> = {};
      if (typeof payload.context === 'string' && payload.context.trim()) base.context = payload.context.trim();
      if (typeof payload.preview === 'string' && payload.preview.trim()) base.preview = payload.preview.trim();
      const direct = parseMaybeObject(payload.args ?? payload.arguments);
      if (Object.keys(direct).length > 0) return { ...base, ...direct };
      const input = parseMaybeObject(payload.input);
      const nested = parseMaybeObject(
        input.args ?? input.arguments ?? input.parameters ?? input.input ?? (input.function as Record<string, unknown>)?.arguments ?? (input.function as Record<string, unknown>)?.args,
      );
      if (Object.keys(nested).length > 0) return { ...base, ...nested };
      if (Object.keys(input).length > 0) return { ...base, ...input };
      return Object.keys(base).length > 0 ? base : undefined;
    };

    const toolExists = (id: string): boolean => {
      const { messages } = useChatStore.getState();
      const last = messages[messages.length - 1];
      return last?.role === 'assistant' && (last.toolCalls ?? []).some((t) => t.id === id);
    };

    const onToolStart = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      const id = String(payload?.tool_id ?? Date.now());
      const input = extractToolInput(payload);
      const tool: import('@hermes-pwa/core').ToolCall = {
        id,
        name: String(payload?.name ?? 'unknown'),
      };
      if (input) tool.input = input;
      if (toolExists(id)) {
        useChatStore.getState().updateToolCall(id, tool);
      } else {
        useChatStore.getState().appendToolCall(tool);
      }
    };

    const onToolComplete = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      const id = String(payload?.tool_id ?? Date.now());
      const result = payload?.result;
      const authoritativeTodos = Array.isArray(payload?.todos) ? { todos: payload.todos } : undefined;
      const output = authoritativeTodos
        ? JSON.stringify(authoritativeTodos)
        : typeof result === 'string'
          ? result
          : typeof result === 'object' && result !== null
            ? JSON.stringify(result)
            : undefined;
      const patch: import('@hermes-pwa/core').ToolCall = {
        id,
        name: String(payload?.name ?? 'unknown'),
      };
      if (output) patch.output = output;
      if (toolExists(id)) {
        useChatStore.getState().updateToolCall(id, patch);
      } else {
        useChatStore.getState().appendToolCall(patch);
      }
    };

    const setCleanLiveStatus = (payload: Record<string, unknown> | undefined) => {
      const status = extractLiveStatus(payload);
      if (!status) return;
      setLiveStatus(status);
    };

    const onThinkingDelta = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      setCleanLiveStatus(payload);
    };

    const onStatusUpdate = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      const payload = e.payload as Record<string, unknown> | undefined;
      const kind = typeof payload?.kind === 'string' ? payload.kind : 'status';
      if (kind === 'ready') {
        setLiveStatus({ text: '' });
        return;
      }
      if (isNonChatStatus(kind, payload)) return;
      const { messages, streaming } = useChatStore.getState();
      const last = messages[messages.length - 1];
      if (!streaming || last?.role !== 'assistant') return;
      setCleanLiveStatus(payload);
    };

    const onReasoningDelta = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      const text = typeof payload?.text === 'string' ? payload.text : '';
      useChatStore.getState().appendThinking(text);
    };

    const onReasoningAvailable = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      const text = typeof payload?.text === 'string' ? payload.text : '';
      useChatStore.getState().appendThinking(text, true);
    };

    const onError = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      beginAssistant();
      const payload = e.payload as Record<string, unknown> | undefined;
      const message = typeof payload?.message === 'string' ? payload.message : 'Hermes reported an error.';
      useChatStore.getState().failAssistant(message);
      setLiveStatus({ text: '' });
      void useSessionsStore.getState().load(rest);
    };

    const onSessionInfo = (e: import('@hermes-pwa/core').RpcEvent) => {
      if (!eventBelongsToActiveChat(e)) return;
      const payload = e.payload as Record<string, unknown> | undefined;
      if (payload?.running === false) {
        useChatStore.getState().markIdle();
        setLiveStatus({ text: '' });
        void refreshActiveHistory();
        drainQueuedPrompt();
      }
    };

    rpc.events.addEventListener('message.start', onMessageStart);
    rpc.events.addEventListener('message.delta', onDelta);
    rpc.events.addEventListener('message.complete', onDone);
    rpc.events.addEventListener('tool.start', onToolStart);
    rpc.events.addEventListener('tool.progress', onToolStart);
    rpc.events.addEventListener('tool.generating', onToolStart);
    rpc.events.addEventListener('tool.complete', onToolComplete);
    rpc.events.addEventListener('thinking.delta', onThinkingDelta);
    rpc.events.addEventListener('status.update', onStatusUpdate);
    rpc.events.addEventListener('reasoning.delta', onReasoningDelta);
    rpc.events.addEventListener('reasoning.available', onReasoningAvailable);
    rpc.events.addEventListener('error', onError);
    rpc.events.addEventListener('session.info', onSessionInfo);

    return () => {
      rpc.events.removeEventListener('message.start', onMessageStart);
      rpc.events.removeEventListener('message.delta', onDelta);
      rpc.events.removeEventListener('message.complete', onDone);
      rpc.events.removeEventListener('tool.start', onToolStart);
      rpc.events.removeEventListener('tool.progress', onToolStart);
      rpc.events.removeEventListener('tool.generating', onToolStart);
      rpc.events.removeEventListener('tool.complete', onToolComplete);
      rpc.events.removeEventListener('thinking.delta', onThinkingDelta);
      rpc.events.removeEventListener('status.update', onStatusUpdate);
      rpc.events.removeEventListener('reasoning.delta', onReasoningDelta);
      rpc.events.removeEventListener('reasoning.available', onReasoningAvailable);
      rpc.events.removeEventListener('error', onError);
      rpc.events.removeEventListener('session.info', onSessionInfo);
    };
  }, [rpc, rest, activeName, drainQueuedPrompt]);

  const lastMessage = messages[messages.length - 1];
  const lastToolSignal = lastMessage?.toolCalls
    ?.map((tool) => `${tool.id}:${tool.name}:${typeof tool.output === 'string' ? tool.output.length : 0}`)
    .join('|') ?? '';
  const scrollContentSignal = [
    messages.length,
    lastMessage?.id ?? '',
    lastMessage?.text.length ?? 0,
    lastMessage?.thinking?.length ?? 0,
    lastMessage?.toolCalls?.length ?? 0,
    lastToolSignal,
  ].join(':');

  useEffect(() => {
    const el = listRef.current;
    const shouldForce = forceScrollRef.current;
    if (!el || (!atBottomRef.current && !shouldForce) || scrollFrameRef.current !== null) return;
    const scroll = () => {
      scrollFrameRef.current = null;
      const current = listRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      forceScrollRef.current = false;
    };
    if (typeof window.requestAnimationFrame === 'function') {
      scrollFrameKindRef.current = 'animation';
      scrollFrameRef.current = window.requestAnimationFrame(scroll);
    } else {
      scrollFrameKindRef.current = 'timeout';
      scrollFrameRef.current = window.setTimeout(scroll, 0);
    }
  }, [scrollContentSignal, pendingApprovalCount, liveStatus.text, streaming, error, composerLayoutVersion]);

  useEffect(() => {
    return () => {
      const frame = scrollFrameRef.current;
      if (frame === null) return;
      if (scrollFrameKindRef.current === 'animation' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frame);
      } else {
        window.clearTimeout(frame);
      }
      scrollFrameRef.current = null;
    };
  }, []);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }

  const currentSession = sessions.find((s) => {
    if (!storedSessionId) return false;
    return s.id === storedSessionId || s.lineageRootId === storedSessionId;
  });
  const branchLabel = currentSession?.source
    ? (sessionSourceLabel(currentSession.source) ?? 'branch')
    : currentSession?.cwd ?? 'branch';

  const activeProfile = useProfilesStore((s) => s.profiles.find((p) => p.name === s.activeName));
  const profileLabel = activeProfile?.displayName ?? activeName ?? 'default';
  const modelLabel = activeProfile?.model ?? 'GPT-5.5';
  const busySubmitLabel =
    busyInputMode === 'queue' ? 'Queue message' : busyInputMode === 'interrupt' ? 'Interrupt and send' : 'Steer agent';
  const busyPlaceholder =
    busyInputMode === 'queue'
      ? 'Queue message for after this turn…'
      : busyInputMode === 'interrupt'
        ? 'Interrupt current turn and send…'
        : 'Steer the running turn…';

  const handleBusyInput = useCallback(
    (text: string, options: { fallbackToFront?: boolean } = {}) => {
      markLocalInputShouldScroll();
      const front = options.fallbackToFront === true;
      if (busyInputMode === 'interrupt') {
        enqueuePrompt(text, { front: true });
        void interrupt(rpc, { keepStreaming: true });
        return;
      }
      if (busyInputMode === 'queue') {
        enqueuePrompt(text, { front });
        return;
      }
      void steer(rpc, text).then((accepted) => {
        if (!accepted) {
          enqueuePrompt(text, { front });
        }
      });
    },
    [busyInputMode, enqueuePrompt, interrupt, markLocalInputShouldScroll, rpc, steer],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      markLocalInputShouldScroll();
      void submit(rpc, text, profileForSubmit).then((result) => {
        if (result === 'busy') {
          handleBusyInput(text);
        }
      });
    },
    [handleBusyInput, markLocalInputShouldScroll, profileForSubmit, rpc, submit],
  );

  const handleSend = useCallback(
    (text: string) => submitPrompt(text),
    [submitPrompt],
  );

  const handleTranscribeAudio = useCallback(
    async (audio: Blob) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(audio);
      });
      return rest.audioTranscribe(dataUrl, audio.type);
    },
    [rest],
  );

  const stopVoiceAudio = useCallback(() => {
    voiceAudioSequenceRef.current += 1;
    const audio = voiceAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }, []);

  const primeVoiceAudio = useCallback(() => {
    if (typeof Audio === 'undefined') return;
    const audio = voiceAudioRef.current ?? new Audio();
    audio.setAttribute('playsinline', '');
    voiceAudioRef.current = audio;
    if (!audio.src) audio.src = SILENT_WAV_DATA_URL;
    void audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
      })
      .catch(() => {
        // Best-effort iOS unlock. Real playback still reports an error later if blocked.
      });
  }, []);

  const speakVoiceText = useCallback(
    async (text: string) => {
      const speakable = text.trim();
      if (!speakable) return;
      const ownSequence = voiceAudioSequenceRef.current;
      const response = await rest.audioSpeak(speakable);
      if (ownSequence !== voiceAudioSequenceRef.current) return;
      const audio = voiceAudioRef.current ?? new Audio();
      audio.setAttribute('playsinline', '');
      voiceAudioRef.current = audio;
      audio.src = response.dataUrl;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
        };
        const onEnded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('Voice playback failed.'));
        };
        audio.addEventListener('ended', onEnded, { once: true });
        audio.addEventListener('error', onError, { once: true });
        void audio.play().catch((error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error('Voice playback was blocked.'));
        });
      });
      if (ownSequence === voiceAudioSequenceRef.current) {
        audio.removeAttribute('src');
        audio.load();
      }
    },
    [rest],
  );

  useEffect(() => () => stopVoiceAudio(), [stopVoiceAudio]);

  const handleUploadFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(attachmentTooLargeMessage(file.name));
      }
      if (!isAllowedAttachmentMime(file)) {
        throw new Error(unsupportedAttachmentTypeMessage(file.name, file.type));
      }
      const safeName = safeAttachmentBasename(file.name);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { sessionId } = await ensureLiveSession(rpc, profileForSubmit);
      const result = await rpc.request<{
        path?: string;
        ref_path?: string;
        file?: { path?: string; ref_path?: string };
      }>('file.attach', {
        session_id: sessionId,
        path: safeName,
        name: safeName,
        data_url: dataUrl,
      });
      const path = result?.ref_path ?? result?.file?.ref_path ?? result?.path ?? result?.file?.path;
      if (!path) throw new Error('Upload response did not include a path.');
      return { path };
    },
    [ensureLiveSession, profileForSubmit, rpc],
  );

  if (connection.state === 'init' || connection.state === 'login' || connection.state === 'offline') {
    return (
      <div className="hm-empty-state">
        <p>Connecting to Hermes…</p>
        <p className="hm-muted">{connection.error ?? 'Please wait.'}</p>
      </div>
    );
  }

  return (
    <div className="hm-chat">
      <div
        className="hm-chat__messages hm-scroll"
        ref={listRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={streaming}
        aria-label="Conversation"
      >
        <div className="hm-chat__context">
          <span className="hm-chat__context-chip hm-chat__context-chip--primary">
            <Icon name="robot" size={12} />
            {profileLabel}
          </span>
          <span className="hm-chat__context-chip hm-chat__context-chip--secondary">{modelLabel}</span>
          <span className="hm-chat__context-chip hm-chat__context-chip--secondary">
            <Icon name="branch" size={12} />
            {branchLabel}
          </span>
        </div>

        {messages.length === 0 ? (
          <div className="hm-empty-state hm-empty-state--chat">
            <div className="hm-mark">H</div>
            <h2>Start a conversation with Hermes</h2>
            <p className="hm-muted">Open the session drawer to resume history, or send a message to begin a fresh mobile chat.</p>
          </div>
        ) : (
          messages.map((m, index) => (
            <MessageBubble
              key={m.id}
              message={m}
              rpc={rpc}
              rest={rest}
              isLast={index === messages.length - 1}
              streaming={streaming}
              liveStatus={index === messages.length - 1 && streaming ? liveStatus.text : ''}
              liveFace={undefined}
              pendingApprovals={pendingApprovalsForMessage(pendingApprovals, index, messages.length)}
              activeSessionIds={activeSessionIds}
            />
          ))
        )}

        {error ? <div className="hm-warning-banner hm-warning-banner--error">{error}</div> : null}
      </div>
      <Composer
        onSend={handleSend}
        slashCommandsRpc={rpc}
        onSteer={handleBusyInput}
        onStop={() => void interrupt(rpc)}
        busy={streaming}
        busySubmitLabel={busySubmitLabel}
        placeholder={streaming ? busyPlaceholder : 'Reply or steer the agent…'}
        messages={messages}
        onTranscribeAudio={handleTranscribeAudio}
        onSpeakVoiceText={speakVoiceText}
        onStopVoiceAudio={stopVoiceAudio}
        onPrimeVoiceAudio={primeVoiceAudio}
        onUploadFile={handleUploadFile}
        onLayoutChange={handleComposerLayoutChange}
      />
    </div>
  );
}
