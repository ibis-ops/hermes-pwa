import { useCallback, useEffect, useRef, useState } from 'react';

export interface MicRecording {
  audio: Blob;
  durationMs: number;
  heardSpeech: boolean;
}

export interface MicRecorderOptions {
  onLevel?: (level: number) => void;
  onError?: (error: Error) => void;
  onSilence?: () => void;
  silenceLevel?: number;
  silenceMs?: number;
  idleSilenceMs?: number;
}

export interface MicRecorderHandle {
  start: (options?: MicRecorderOptions) => Promise<void>;
  stop: () => Promise<MicRecording | null>;
  cancel: () => void;
}

function micError(error: unknown): Error {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return new Error('Microphone permission denied.');
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return new Error('No microphone found.');
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return new Error('Microphone is already in use.');
    }
    if (error.name === 'OverconstrainedError') {
      return new Error('Microphone constraints are unsupported.');
    }
  }
  if (error instanceof Error) return error;
  return new Error('Could not start microphone.');
}

export function useMicRecorder(): { handle: MicRecorderHandle; level: number; recording: boolean } {
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const heardSpeechRef = useRef(false);
  const silenceTriggeredRef = useRef(false);
  const silenceStartedAtRef = useRef<number | null>(null);
  const stopResolverRef = useRef<((recording: MicRecording | null) => void) | null>(null);
  const stopTimeoutRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  // The meter only needs a few steps a few times a second; every animation
  // frame re-rendered the whole composer.
  const shownLevelRef = useRef(0);
  const shownLevelAtRef = useRef(0);

  const clearStopTimeout = useCallback(() => {
    if (stopTimeoutRef.current) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearStopTimeout();
    if (animationRef.current) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setLevel(0);
    shownLevelRef.current = 0;
    setRecording(false);
    silenceTriggeredRef.current = false;
  }, [clearStopTimeout]);

  useEffect(() => () => cleanup(), [cleanup]);

  const startMeter = (stream: MediaStream, options: MicRecorderOptions) => {
    const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
    const AudioContextCtor = window.AudioContext || audioWindow.webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const audioContext = new AudioContextCtor();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.fftSize);
      source.connect(analyser);
      audioContextRef.current = audioContext;
      if (audioContext.state === 'suspended') {
        void audioContext.resume().catch(() => undefined);
      }

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const centered = value - 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const normalized = Math.min(1, rms / 42);
        const now = Date.now();

        const stepped = Math.round(normalized * 10) / 10;
        if (stepped !== shownLevelRef.current && now - shownLevelAtRef.current >= 80) {
          shownLevelRef.current = stepped;
          shownLevelAtRef.current = now;
          setLevel(stepped);
        }
        options.onLevel?.(normalized);

        const speechThreshold = options.silenceLevel ?? 0;
        const silenceMs = options.silenceMs ?? 0;
        const idleSilenceMs = options.idleSilenceMs ?? 0;

        if (speechThreshold > 0 && options.onSilence && !silenceTriggeredRef.current) {
          if (normalized >= speechThreshold) {
            heardSpeechRef.current = true;
            silenceStartedAtRef.current = null;
          } else if (heardSpeechRef.current && silenceMs > 0) {
            silenceStartedAtRef.current ??= now;
            if (now - silenceStartedAtRef.current >= silenceMs) {
              silenceTriggeredRef.current = true;
              options.onSilence();
              return;
            }
          } else if (!heardSpeechRef.current && idleSilenceMs > 0 && now - startedAtRef.current >= idleSilenceMs) {
            silenceTriggeredRef.current = true;
            options.onSilence();
            return;
          }
        }

        animationRef.current = window.requestAnimationFrame(tick);
      };

      tick();
    } catch {
      setLevel(0);
    }
  };

  const start: MicRecorderHandle['start'] = async (options = {}) => {
    if (recorderRef.current) return;
    const generation = ++generationRef.current;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Audio recording is not supported in this browser.');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      throw micError(error);
    }
    if (generation !== generationRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Audio recording was cancelled.');
    }

    const mimeType =
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/wav'].find(
        (type) => MediaRecorder.isTypeSupported(type),
      ) ?? '';

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw micError(error);
    }
    if (generation !== generationRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Audio recording was cancelled.');
    }

    chunksRef.current = [];
    streamRef.current = stream;
    recorderRef.current = recorder;
    heardSpeechRef.current = false;
    silenceTriggeredRef.current = false;
    silenceStartedAtRef.current = null;
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      clearStopTimeout();
      const chunks = chunksRef.current;
      const recordingType = recorder.mimeType || mimeType || 'audio/webm';
      const durationMs = Date.now() - startedAtRef.current;
      const heardSpeech = heardSpeechRef.current;
      chunksRef.current = [];
      cleanup();
      const resolver = stopResolverRef.current;
      stopResolverRef.current = null;
      if (!chunks.length) {
        resolver?.(null);
        return;
      }
      resolver?.({
        audio: new Blob(chunks, { type: recordingType }),
        durationMs,
        heardSpeech,
      });
    };

    recorder.onerror = (event) => {
      clearStopTimeout();
      const error = micError((event as Event & { error?: unknown }).error);
      const resolver = stopResolverRef.current;
      stopResolverRef.current = null;
      cleanup();
      options.onError?.(error);
      resolver?.(null);
    };

    if (generation !== generationRef.current) {
      cleanup();
      throw new Error('Audio recording was cancelled.');
    }
    try {
      recorder.start();
    } catch (error) {
      cleanup();
      throw micError(error);
    }
    setRecording(true);
    startMeter(stream, options);
  };

  const stop: MicRecorderHandle['stop'] = () =>
    new Promise<MicRecording | null>((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        cleanup();
        resolve(null);
        return;
      }
      stopResolverRef.current = resolve;
      stopTimeoutRef.current = window.setTimeout(() => {
        if (stopResolverRef.current !== resolve) return;
        stopResolverRef.current = null;
        cleanup();
        resolve(null);
      }, 1500);
      try {
        recorder.stop();
      } catch {
        clearStopTimeout();
        stopResolverRef.current = null;
        cleanup();
        resolve(null);
      }
    });

  const cancel: MicRecorderHandle['cancel'] = () => {
    generationRef.current += 1;
    clearStopTimeout();
    const recorder = recorderRef.current;
    const resolver = stopResolverRef.current;
    stopResolverRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // Already stopped by the browser; cleanup below still closes the stream.
      }
    }
    cleanup();
    resolver?.(null);
  };

  // The handle keeps one identity for the life of the hook (the functions
  // above close over fresh state every render); consumers can depend on it
  // without their effects re-running on every render.
  const latestRef = useRef<MicRecorderHandle>({ start, stop, cancel });
  latestRef.current = { start, stop, cancel };
  const handleRef = useRef<MicRecorderHandle | null>(null);
  if (handleRef.current === null) {
    handleRef.current = {
      start: (options) => latestRef.current.start(options),
      stop: () => latestRef.current.stop(),
      cancel: () => latestRef.current.cancel(),
    };
  }

  return { handle: handleRef.current, level, recording };
}
