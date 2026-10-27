import { HermesHttpError } from '@hermes-pwa/core';
import { base64ToObjectUrl, silentAudioUrl } from './audioBlob';
import { readReadAloudSettings, type ReadAloudSettings } from './readAloudSettings';
import { speakableText, speechChunks } from './speechText';

/**
 * Reads a reply aloud, one reply at a time across the app.
 *
 * The voice comes from the Mac: the plugin runs macOS speech there and sends
 * back short pieces of audio, the next one made while the current one plays.
 * iPhone web apps only get Apple's compact voices, so the Mac's installed
 * voices (Premium ones included) sound far better, and the text stays on the
 * Mac. When the Mac cannot read (a plugin backend from before read-aloud, or
 * Hermes not on a Mac), the phone's own voice takes over.
 */

export type ReadAloudStatus = 'idle' | 'loading' | 'playing';

export interface ReadAloudSnapshot {
  /** The reply being read, or the one whose reading just failed. */
  messageId: string | undefined;
  status: ReadAloudStatus;
  error: string | undefined;
}

export interface ReadAloudSource {
  synthesize(
    text: string,
    options: { voice?: string | undefined; rate: number; signal: AbortSignal },
  ): Promise<{ audio: string; mimeType: string }>;
}

const IDLE: ReadAloudSnapshot = { messageId: undefined, status: 'idle', error: undefined };
const ERROR_SHOWN_MS = 4000;
const READ_FAILED = 'Could not read this aloud.';

// Sound effects, character voices and the robotic Eloquence set.
const NOVELTY_VOICES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged', 'good news', 'hysterical',
  'jester', 'organ', 'pipe organ', 'princess', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox', 'fred',
  'junior', 'kathy', 'ralph', 'eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley',
]);

function voiceBaseName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
}

function normalizeLang(lang: string): string {
  return lang.replace(/_/g, '-').toLowerCase();
}

/** The phone's own voice to fall back on: English, no novelty voices, the exact locale and the default first. */
export function pickDeviceVoice(voices: SpeechSynthesisVoice[], preferredLang = 'en-US'): SpeechSynthesisVoice | undefined {
  const wanted = preferredLang.toLowerCase();
  const base = wanted.split('-')[0];
  return voices
    .filter((voice) => !NOVELTY_VOICES.has(voiceBaseName(voice.name)) && normalizeLang(voice.lang).split('-')[0] === base)
    .map((voice) => ({
      voice,
      score:
        (normalizeLang(voice.lang) === wanted ? 0 : 10) +
        (/premium|enhanced|natural|neural/i.test(voice.name) ? 0 : 2) +
        (voice.default ? 0 : 1),
    }))
    .sort((a, b) => a.score - b.score || a.voice.name.localeCompare(b.voice.name))[0]?.voice;
}

function deviceSpeech(): SpeechSynthesis | undefined {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : undefined;
}

/** 404: a plugin backend from before read-aloud (dashboard not restarted). 501: no macOS speech on the host. */
function macCannotRead(err: unknown): boolean {
  return err instanceof HermesHttpError && (err.status === 404 || err.status === 501);
}

function unknownVoice(err: unknown): boolean {
  return err instanceof HermesHttpError && err.status === 400;
}

export class ReadAloudController {
  private snapshot: ReadAloudSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private audio: HTMLAudioElement | undefined;
  private source: ReadAloudSource | undefined;
  private macUnavailable = false;
  private macConfirmed = false;
  private deviceUnlocked = false;
  private abort: AbortController | undefined;
  private cancelPlayback: (() => void) | undefined;
  private readonly urls = new Set<string>();
  // Safari drops a SpeechSynthesisUtterance nobody holds, and its end event with it.
  private utterance: SpeechSynthesisUtterance | undefined;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.stop());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReadAloudSnapshot => this.snapshot;

  setSource(source: ReadAloudSource | undefined): void {
    this.source = source;
    this.macUnavailable = false;
    this.macConfirmed = false;
  }

  /** Read a reply aloud, or stop it when it is the one reading. Call it from the tap itself. */
  toggle(messageId: string, markdown: string): void {
    if (this.snapshot.messageId === messageId && this.snapshot.status !== 'idle') {
      this.stop();
      return;
    }
    this.start(messageId, markdown);
  }

  /**
   * Start reading. iOS only lets audio and speech begin inside a user
   * gesture, so both are unlocked here, synchronously, before the first
   * piece of audio is even requested.
   */
  start(messageId: string, markdown: string): void {
    this.stop();
    const chunks = speechChunks(speakableText(markdown));
    if (chunks.length === 0) return;
    const generation = this.generation;
    const settings = readReadAloudSettings();
    this.set({ messageId, status: 'loading', error: undefined });
    if (this.source && !this.macUnavailable) {
      const audio = this.unlockAudio();
      if (audio) {
        if (!this.macConfirmed) this.unlockDeviceSpeech();
        void this.playFromMac(generation, messageId, chunks, settings, audio, this.source);
        return;
      }
    }
    this.speakOnDevice(generation, messageId, chunks, settings);
  }

  stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    const cancel = this.cancelPlayback;
    this.cancelPlayback = undefined;
    cancel?.();
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch {
        // Not every environment implements media loading; the element is idle either way.
      }
    }
    const synth = deviceSpeech();
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    this.utterance = undefined;
    this.releaseAll();
    if (this.errorTimer !== undefined) {
      clearTimeout(this.errorTimer);
      this.errorTimer = undefined;
    }
    this.updateMediaSession(false);
    if (this.snapshot !== IDLE) this.set(IDLE);
  }

  private set(next: ReadAloudSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  private unlockAudio(): HTMLAudioElement | undefined {
    if (typeof Audio === 'undefined') return undefined;
    const audio = this.audio ?? new Audio();
    audio.setAttribute('playsinline', '');
    audio.preload = 'auto';
    this.audio = audio;
    try {
      audio.src = silentAudioUrl();
      const played = audio.play();
      if (played && typeof played.catch === 'function') played.catch(() => undefined);
    } catch {
      // Best effort: real playback reports its own failure.
    }
    return audio;
  }

  /** A silent, empty utterance inside the tap, so the phone's voice can take over later. */
  private unlockDeviceSpeech(): void {
    const synth = deviceSpeech();
    if (!synth || this.deviceUnlocked || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      const primer = new SpeechSynthesisUtterance(' ');
      primer.volume = 0;
      synth.speak(primer);
      this.deviceUnlocked = true;
    } catch {
      // Best effort.
    }
  }

  private async playFromMac(
    generation: number,
    messageId: string,
    chunks: string[],
    settings: ReadAloudSettings,
    audio: HTMLAudioElement,
    source: ReadAloudSource,
  ): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    let voice = settings.voice;
    const requests = new Map<number, Promise<{ audio: string; mimeType: string }>>();
    const request = (index: number): Promise<{ audio: string; mimeType: string }> => {
      let pending = requests.get(index);
      if (!pending) {
        pending = source.synthesize(chunks[index] ?? '', { voice, rate: settings.rate, signal: controller.signal });
        // A prefetched piece nobody awaits yet must not surface as an unhandled rejection.
        pending.catch(() => undefined);
        requests.set(index, pending);
      }
      return pending;
    };
    let index = 0;
    try {
      for (; index < chunks.length; index += 1) {
        let piece: { audio: string; mimeType: string };
        try {
          piece = await request(index);
        } catch (err) {
          // The chosen voice was removed from the Mac: the best installed one reads instead.
          if (!voice || !unknownVoice(err) || generation !== this.generation) throw err;
          voice = undefined;
          requests.clear();
          piece = await request(index);
        }
        if (generation !== this.generation) return;
        this.macConfirmed = true;
        if (index + 1 < chunks.length) void request(index + 1);
        const url = base64ToObjectUrl(piece.audio, piece.mimeType);
        this.urls.add(url);
        this.set({ messageId, status: 'playing', error: undefined });
        this.updateMediaSession(true);
        await this.play(audio, url, generation);
        this.release(url);
        requests.delete(index);
        if (generation !== this.generation) return;
      }
      this.finish(generation);
    } catch (err) {
      if (generation !== this.generation) return;
      if (index === 0 && macCannotRead(err)) {
        this.macUnavailable = true;
        this.speakOnDevice(generation, messageId, chunks, settings);
        return;
      }
      this.fail(generation, messageId);
    }
  }

  private play(audio: HTMLAudioElement, url: string, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        if (this.cancelPlayback === cancel) this.cancelPlayback = undefined;
      };
      const onEnded = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('Playback failed.'));
      };
      const cancel = (): void => {
        cleanup();
        resolve();
      };
      this.cancelPlayback = cancel;
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      audio.src = url;
      const played = audio.play();
      if (played && typeof played.catch === 'function') {
        played.catch((err: unknown) => {
          if (generation !== this.generation) return;
          cleanup();
          reject(err instanceof Error ? err : new Error('Playback was blocked.'));
        });
      }
    });
  }

  private speakOnDevice(generation: number, messageId: string, chunks: string[], settings: ReadAloudSettings): void {
    const synth = deviceSpeech();
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      this.fail(generation, messageId, "This phone can't read aloud.");
      return;
    }
    const voice = pickDeviceVoice(synth.getVoices());
    let index = 0;
    this.set({ messageId, status: 'playing', error: undefined });
    const next = (): void => {
      if (generation !== this.generation) return;
      if (index >= chunks.length) {
        this.finish(generation);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      index += 1;
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = 'en-US';
      }
      utterance.rate = settings.rate;
      utterance.onend = () => next();
      utterance.onerror = (event) => {
        if (generation !== this.generation) return;
        if (event.error === 'interrupted' || event.error === 'canceled') return;
        this.fail(generation, messageId);
      };
      this.utterance = utterance;
      synth.speak(utterance);
    };
    next();
  }

  private release(url: string): void {
    if (!this.urls.delete(url)) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Already gone.
    }
  }

  private releaseAll(): void {
    for (const url of [...this.urls]) this.release(url);
  }

  private finish(generation: number): void {
    if (generation !== this.generation) return;
    this.abort = undefined;
    this.releaseAll();
    this.updateMediaSession(false);
    this.set(IDLE);
  }

  private fail(generation: number, messageId: string, message = READ_FAILED): void {
    if (generation !== this.generation) return;
    this.stop();
    this.set({ messageId, status: 'idle', error: message });
    this.errorTimer = setTimeout(() => {
      this.errorTimer = undefined;
      if (this.snapshot.messageId === messageId && this.snapshot.error === message) this.set(IDLE);
    }, ERROR_SHOWN_MS);
  }

  /** Lock screen and headphone controls stop the reading. */
  private updateMediaSession(playing: boolean): void {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!session) return;
    try {
      if (playing) {
        if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title: 'Hermes reply', artist: 'Read aloud' });
        session.setActionHandler('pause', () => this.stop());
        session.setActionHandler('stop', () => this.stop());
      } else {
        session.setActionHandler('pause', null);
        session.setActionHandler('stop', null);
        session.metadata = null;
      }
    } catch {
      // Some actions are not supported everywhere.
    }
  }
}

/** The one reader the app shares. */
export const readAloud = new ReadAloudController();
