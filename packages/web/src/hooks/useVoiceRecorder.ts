import { useEffect, useRef, useState } from 'react';
import { useMicRecorder } from './useMicRecorder';

export type VoiceRecorderStatus = 'idle' | 'recording' | 'transcribing';

export interface VoiceRecorderState {
  status: VoiceRecorderStatus;
  elapsedSeconds: number;
  level: number;
}

interface VoiceRecorderOptions {
  maxRecordingSeconds?: number;
  onTranscribeAudio?: ((audio: Blob) => Promise<string>) | undefined;
  onTranscript?: ((text: string) => void) | undefined;
  onFocusInput?: (() => void) | undefined;
}

export function useVoiceRecorder({
  maxRecordingSeconds = 120,
  onTranscribeAudio,
  onTranscript,
  onFocusInput,
}: VoiceRecorderOptions) {
  const { handle, level, recording } = useMicRecorder();
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // What went wrong last, in words; cleared by the next try.
  const [error, setError] = useState<string | undefined>(undefined);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearTimers = () => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => () => clearTimers(), []);

  const stop = async () => {
    clearTimers();
    const result = await handle.stop();
    if (!result) {
      setStatus('idle');
      return;
    }
    if (!onTranscribeAudio) {
      setStatus('idle');
      return;
    }
    setStatus('transcribing');
    try {
      const transcript = (await onTranscribeAudio(result.audio)).trim();
      if (transcript) {
        onTranscript?.(transcript);
      } else {
        setError('Nothing was heard. Try again a little closer to the mic.');
      }
    } catch (err) {
      setError(voiceErrorMessage(err, 'Could not turn the recording into text.'));
    } finally {
      setStatus('idle');
      onFocusInput?.();
    }
  };

  const start = async () => {
    if (!onTranscribeAudio) return;
    setError(undefined);
    try {
      await handle.start({
        onError: (err) => {
          setStatus('idle');
          clearTimers();
          setError(voiceErrorMessage(err, 'The recording stopped unexpectedly.'));
        },
      });
      startedAtRef.current = Date.now();
      setElapsedSeconds(0);
      setStatus('recording');
      intervalRef.current = window.setInterval(
        () => setElapsedSeconds((Date.now() - startedAtRef.current) / 1000),
        250,
      );
      const cap = Math.max(1, Math.min(Math.trunc(maxRecordingSeconds), 600));
      timeoutRef.current = window.setTimeout(() => void stop(), cap * 1000);
    } catch (err) {
      setStatus('idle');
      setError(voiceErrorMessage(err, 'The microphone could not start.'));
    }
  };

  const dictate = () => {
    if (recording) {
      void stop();
    } else if (status === 'idle') {
      void start();
    }
  };

  return { dictate, status, elapsedSeconds, level, error, clearError: () => setError(undefined) };
}

/** A message for the person: the browser's own wording when it has one worth showing. */
export function voiceErrorMessage(err: unknown, fallback: string): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is off for Hermes. Allow it in Settings, then try again.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  const message = err instanceof Error ? err.message.trim() : '';
  return message && message.length < 140 ? message : fallback;
}
