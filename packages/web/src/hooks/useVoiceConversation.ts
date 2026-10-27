import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@hermes-pwa/core';
import { useMicRecorder } from './useMicRecorder';
import { voiceErrorMessage } from './useVoiceRecorder';

/** Long enough for a slow gateway to start the turn; after that the loop listens again. */
const TURN_START_TIMEOUT_MS = 20_000;

export type ConversationStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface VoiceConversationOptions {
  enabled: boolean;
  busy: boolean;
  messages: Message[];
  onSubmit: (text: string) => void;
  onTranscribeAudio?: ((audio: Blob) => Promise<string>) | undefined;
  onSpeakText?: ((text: string) => Promise<void>) | undefined;
  onStopSpeech?: (() => void) | undefined;
  onPrimeAudio?: (() => void) | undefined;
}

export function useVoiceConversation({
  enabled,
  busy,
  messages,
  onSubmit,
  onTranscribeAudio,
  onSpeakText,
  onStopSpeech,
  onPrimeAudio,
}: VoiceConversationOptions) {
  const { handle, level } = useMicRecorder();
  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [muted, setMuted] = useState(false);
  const turnClosingRef = useRef(false);
  const enabledRef = useRef(enabled);
  const mutedRef = useRef(muted);
  const busyRef = useRef(busy);
  const statusRef = useRef<ConversationStatus>('idle');
  /**
   * The turn just sent, and whether the chat went busy for it yet. The reply
   * is read from after the last user row, not matched by message id: a
   * history refresh replaces local ids with the gateway's, which made an old
   * reply look new and get read out again.
   */
  const pendingTurnRef = useRef<{ countBefore: number; sawBusy: boolean } | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const spokenRef = useRef(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const handleTurn = useCallback(
    async (forceTranscribe = false) => {
      if (turnClosingRef.current) return;
      turnClosingRef.current = true;
      setStatus('transcribing');
      try {
        const result = await handle.stop();
        if (!result || (!result.heardSpeech && !forceTranscribe) || !onTranscribeAudio) {
          setStatus('idle');
          return;
        }
        try {
          const transcript = (await onTranscribeAudio(result.audio)).trim();
          if (!transcript) {
            setStatus('idle');
            return;
          }
          pendingTurnRef.current = { countBefore: messagesRef.current.length, sawBusy: false };
          setError(undefined);
          onSubmit(transcript);
          setStatus('thinking');
        } catch (err) {
          setError(voiceErrorMessage(err, 'Could not turn that into text. Say it again.'));
          setStatus('idle');
        }
      } finally {
        turnClosingRef.current = false;
      }
    },
    [handle, onSubmit, onTranscribeAudio],
  );

  const startListening = useCallback(async () => {
    if (!enabledRef.current || mutedRef.current || busyRef.current) return;
    if (statusRef.current !== 'idle') return;
    if (!onTranscribeAudio) return;
    try {
      await handle.start({
        silenceLevel: 0.035,
        silenceMs: 1000,
        idleSilenceMs: 12000,
        onError: (err) => {
          setError(voiceErrorMessage(err, 'The microphone stopped.'));
          setStatus('idle');
        },
        onSilence: () => void handleTurn(),
      });
      if (!enabledRef.current || mutedRef.current || busyRef.current || statusRef.current !== 'idle') {
        handle.cancel();
        setStatus('idle');
        return;
      }
      setStatus('listening');
    } catch (err) {
      setError(voiceErrorMessage(err, 'The microphone could not start.'));
      // Not straight back to idle: idle would retry at once and loop on a
      // denied microphone. Muting stops the loop until the person unmutes.
      setMuted(true);
      setStatus('idle');
    }
  }, [handle, handleTurn, onTranscribeAudio]);

  const end = useCallback(() => {
    pendingTurnRef.current = null;
    handle.cancel();
    onStopSpeech?.();
    turnClosingRef.current = false;
    spokenRef.current = false;
    setMuted(false);
    setError(undefined);
    setStatus('idle');
  }, [handle, onStopSpeech]);

  const start = useCallback(() => {
    if (!onTranscribeAudio) {
      end();
      return;
    }
    onPrimeAudio?.();
    setMuted(false);
    spokenRef.current = false;
    setStatus('idle');
    void startListening();
  }, [end, onPrimeAudio, onTranscribeAudio, startListening]);

  const toggle = useCallback(() => {
    if (enabled) {
      end();
    } else {
      start();
    }
  }, [enabled, end, start]);

  const toggleMute = useCallback(() => {
    setError(undefined);
    setMuted((value) => {
      const next = !value;
      if (next) {
        handle.cancel();
        onStopSpeech?.();
        setStatus('idle');
      }
      return next;
    });
  }, [handle, onStopSpeech]);

  const stopTurn = useCallback(() => {
    if (statusRef.current === 'listening') {
      void handleTurn(true);
    }
  }, [handleTurn]);

  useEffect(() => {
    if (!enabled) {
      end();
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (statusRef.current !== 'listening') return;
      event.preventDefault();
      stopTurn();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [enabled, end, stopTurn]);

  // The chat went busy for the turn just sent: remember it, so the end of
  // the turn can be told from the moment before it started.
  useEffect(() => {
    if (busy && pendingTurnRef.current) pendingTurnRef.current.sawBusy = true;
  }, [busy]);

  // A turn that never starts (a dropped send) must not leave the loop on
  // "Thinking" forever.
  useEffect(() => {
    if (status !== 'thinking') return undefined;
    const timer = window.setTimeout(() => {
      const pending = pendingTurnRef.current;
      const started = pending
        ? pending.sawBusy || messagesRef.current.slice(pending.countBefore).some((message) => message.role === 'user')
        : false;
      if (statusRef.current === 'thinking' && pending && !started && !busyRef.current) {
        pendingTurnRef.current = null;
        setStatus('idle');
      }
    }, TURN_START_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!enabled || muted) return;
    if (status !== 'thinking' || busy) return;

    const pending = pendingTurnRef.current;
    if (!pending) {
      setStatus('idle');
      return;
    }
    // Started once the chat went busy for it or its user row showed up.
    const started = pending.sawBusy || messages.slice(pending.countBefore).some((message) => message.role === 'user');
    if (!started) return;

    // The reply to this turn: the assistant text after the turn's own user
    // row. A turn that ended without any (a tool-only run, an error) goes
    // back to listening instead of waiting forever.
    let userIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) {
      pendingTurnRef.current = null;
      setStatus('idle');
      return;
    }
    const reply = messages
      .slice(userIndex + 1)
      .filter((message) => message.role === 'assistant' && message.text.trim())
      .map((message) => message.text.trim())
      .join('\n\n');
    const text = reply.trim();
    if (!text) {
      pendingTurnRef.current = null;
      setStatus('idle');
      return;
    }

    pendingTurnRef.current = null;
    spokenRef.current = false;
    setStatus('speaking');
    void (async () => {
      try {
        spokenRef.current = true;
        if (onSpeakText) {
          await onSpeakText(text);
        }
      } finally {
        spokenRef.current = false;
        setStatus('idle');
      }
    })();
  }, [enabled, muted, status, busy, messages, onSpeakText]);

  useEffect(() => {
    if (!enabled || muted || busy || status !== 'idle') return;
    void startListening();
  }, [enabled, muted, busy, status, startListening]);

  return { active: enabled, toggle, status, muted, toggleMute, level, stopTurn, error, clearError: () => setError(undefined) };
}
