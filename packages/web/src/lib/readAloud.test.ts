import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesHttpError } from '@hermes-pwa/core';
import { ReadAloudController, pickDeviceVoice, type ReadAloudSource } from './readAloud';
import { writeReadAloudSettings } from './readAloudSettings';

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = '';
  preload = '';
  played: string[] = [];
  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
  setAttribute(): void {}
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  load(): void {}
  pause(): void {}
  play(): Promise<void> {
    this.played.push(this.src);
    return Promise.resolve();
  }
  end(): void {
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeUtterance {
  text: string;
  voice: unknown = null;
  lang = '';
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

const spoken: FakeUtterance[] = [];
const speechSynthesisMock = {
  speaking: false,
  pending: false,
  speak: vi.fn((utterance: FakeUtterance) => {
    spoken.push(utterance);
  }),
  cancel: vi.fn(),
  getVoices: vi.fn(() => [
    { name: 'Albert', lang: 'en-US', default: false },
    { name: 'Samantha', lang: 'en-US', default: true },
    { name: 'Thomas', lang: 'fr-FR', default: false },
  ]),
};

function audioElement(): FakeAudio {
  const audio = FakeAudio.instances.at(-1);
  if (!audio) throw new Error('no audio element');
  return audio;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const LONG_REPLY = `${'First part of the reply has a few words. '.repeat(6)}${'Second part keeps going for a while longer. '.repeat(14)}`.trim();

describe('ReadAloudController', () => {
  let objectUrls = 0;

  beforeEach(() => {
    window.localStorage.clear();
    FakeAudio.instances = [];
    spoken.length = 0;
    speechSynthesisMock.speak.mockClear();
    speechSynthesisMock.cancel.mockClear();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speechSynthesisMock });
    objectUrls = 0;
    URL.createObjectURL = vi.fn(() => `blob:audio-${(objectUrls += 1)}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('plays the Mac audio piece by piece, fetching the next while one plays', async () => {
    writeReadAloudSettings({ voice: 'Samantha', rate: 1.2 });
    const synthesize = vi.fn<Parameters<ReadAloudSource['synthesize']>, ReturnType<ReadAloudSource['synthesize']>>(
      async () => ({ audio: 'QUFD', mimeType: 'audio/mp4' }),
    );
    const controller = new ReadAloudController();
    controller.setSource({ synthesize });

    controller.start('m-1', LONG_REPLY);
    expect(controller.getSnapshot()).toEqual({ messageId: 'm-1', status: 'loading', error: undefined });
    expect(synthesize.mock.calls[0]![1]).toMatchObject({ voice: 'Samantha', rate: 1.2 });

    await flush();
    expect(controller.getSnapshot().status).toBe('playing');
    // The second piece is requested while the first plays.
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(audioElement().played.at(-1)).toMatch(/^blob:audio-/);

    // Three pieces: a short first one, then two long ones.
    audioElement().end();
    await flush();
    audioElement().end();
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().status).toBe('playing');

    audioElement().end();
    await flush();
    // The silent unlock in the tap, then each piece once.
    expect(audioElement().played).toHaveLength(4);
    expect(controller.getSnapshot()).toEqual({ messageId: undefined, status: 'idle', error: undefined });
  });

  it('stops when the same reply is tapped again, and drops the pending request', async () => {
    let aborted = false;
    const controller = new ReadAloudController();
    controller.setSource({
      synthesize: (_text, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });

    controller.toggle('m-1', 'Read me please.');
    expect(controller.getSnapshot().status).toBe('loading');
    controller.toggle('m-1', 'Read me please.');
    await flush();

    expect(aborted).toBe(true);
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it("falls back to the phone's voice when the Mac cannot read", async () => {
    const synthesize = vi.fn(async () => {
      throw new HermesHttpError(404, 'Not Found', 'no such route');
    });
    const controller = new ReadAloudController();
    controller.setSource({ synthesize });

    controller.start('m-1', 'One sentence here. Another one there.');
    await flush();

    expect(controller.getSnapshot().status).toBe('playing');
    const utterances = spoken.filter((u) => u.text.trim());
    expect(utterances).toHaveLength(1);
    expect((utterances[0]!.voice as { name: string }).name).toBe('Samantha');
    utterances[0]!.onend?.();
    expect(controller.getSnapshot().status).toBe('idle');

    // Known now: the next reply goes straight to the phone's voice.
    controller.start('m-2', 'Short.');
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('asks the Mac ahead of time and, when it cannot read, speaks on the phone within the tap', async () => {
    const synthesize = vi.fn(async () => ({ audio: 'QUFD', mimeType: 'audio/mp4' }));
    const check = vi.fn(async () => false);
    const controller = new ReadAloudController();
    controller.setSource({ synthesize, check });
    await flush();
    expect(check).toHaveBeenCalledTimes(1);

    controller.start('m-1', 'Read this on the phone.');
    // Spoken synchronously, inside the tap: iPhone ignores speech started later.
    expect(spoken.filter((u) => u.text.trim()).map((u) => u.text)).toEqual(['Read this on the phone.']);
    expect(synthesize).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('still tries the Mac when asking ahead failed, since that only means unknown', async () => {
    const synthesize = vi.fn(async () => ({ audio: 'QUFD', mimeType: 'audio/mp4' }));
    const controller = new ReadAloudController();
    controller.setSource({ synthesize, check: async () => Promise.reject(new Error('offline')) });
    await flush();
    controller.start('m-1', 'Hello there.');
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("says so when the phone's voice never starts, and the next tap speaks at once", async () => {
    vi.useFakeTimers();
    const synthesize = vi.fn(async () => {
      throw new HermesHttpError(404, 'Not Found', 'no such route');
    });
    const controller = new ReadAloudController();
    controller.setSource({ synthesize });

    controller.start('m-1', 'Hello there.');
    await flush();
    expect(controller.getSnapshot().status).toBe('playing');
    vi.advanceTimersByTime(3000);
    expect(controller.getSnapshot()).toEqual({ messageId: 'm-1', status: 'idle', error: 'Tap Listen again to hear it on this phone.' });

    spoken.length = 0;
    controller.start('m-1', 'Hello there.');
    expect(spoken.filter((u) => u.text.trim())).toHaveLength(1);
    spoken.at(-1)!.onstart?.();
    vi.advanceTimersByTime(5000);
    expect(controller.getSnapshot()).toEqual({ messageId: 'm-1', status: 'playing', error: undefined });
  });

  it('asks the Mac again after a while, so a dashboard restart turns its voice back on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const synthesize = vi.fn(async () => ({ audio: 'QUFD', mimeType: 'audio/mp4' }));
    const check = vi.fn<[], Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
    const controller = new ReadAloudController();
    controller.setSource({ synthesize, check });
    await flush();

    controller.start('m-1', 'Phone voice.');
    expect(synthesize).not.toHaveBeenCalled();
    spoken.at(-1)!.onend?.();

    vi.setSystemTime(Date.now() + 61_000);
    controller.start('m-2', 'Still the phone for this tap.');
    expect(check).toHaveBeenCalledTimes(2);
    await flush();
    spoken.at(-1)!.onend?.();

    controller.start('m-3', 'Now the Mac reads.');
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('reads with the best installed voice when the chosen one is gone', async () => {
    writeReadAloudSettings({ voice: 'Removed Voice', rate: 1 });
    const synthesize = vi.fn(async (_text: string, options: { voice?: string | undefined }) => {
      if (options.voice) throw new HermesHttpError(400, 'Bad Request', 'that voice is not installed on this Mac');
      return { audio: 'QUFD', mimeType: 'audio/mp4' };
    });
    const controller = new ReadAloudController();
    controller.setSource({ synthesize });

    controller.start('m-1', 'Hello there.');
    await flush();

    expect(synthesize.mock.calls.map(([, options]) => options.voice)).toEqual(['Removed Voice', undefined]);
    expect(controller.getSnapshot().status).toBe('playing');
  });

  it('shows an error for a moment when reading fails midway', async () => {
    vi.useFakeTimers();
    const synthesize = vi.fn(async () => {
      throw new HermesHttpError(502, 'Bad Gateway', 'speech failed');
    });
    const controller = new ReadAloudController();
    controller.setSource({ synthesize });

    controller.start('m-1', 'Hello there.');
    await flush();
    expect(controller.getSnapshot()).toEqual({ messageId: 'm-1', status: 'idle', error: 'Could not read this aloud.' });

    vi.advanceTimersByTime(4000);
    expect(controller.getSnapshot().error).toBeUndefined();
  });

  it('only one reply reads at a time', async () => {
    const synthesize = vi.fn(async () => ({ audio: 'QUFD', mimeType: 'audio/mp4' }));
    const controller = new ReadAloudController();
    controller.setSource({ synthesize });

    controller.start('m-1', 'First reply.');
    await flush();
    controller.start('m-2', 'Second reply.');
    expect(controller.getSnapshot().messageId).toBe('m-2');
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ messageId: 'm-2', status: 'playing' });
  });
});

describe('pickDeviceVoice', () => {
  it('prefers the default voice in the locale and skips novelty voices', () => {
    const voices = [
      { name: 'Bad News', lang: 'en-US', default: false },
      { name: 'Daniel', lang: 'en-GB', default: false },
      { name: 'Samantha', lang: 'en-US', default: true },
    ] as unknown as SpeechSynthesisVoice[];
    expect(pickDeviceVoice(voices)?.name).toBe('Samantha');
    expect(pickDeviceVoice(voices.slice(0, 2))?.name).toBe('Daniel');
    expect(pickDeviceVoice([{ name: 'Thomas', lang: 'fr-FR', default: true }] as unknown as SpeechSynthesisVoice[])).toBeUndefined();
  });
});
