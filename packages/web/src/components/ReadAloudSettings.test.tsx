import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestClient, SpeechVoices } from '@hermes-pwa/core';
import { HermesHttpError } from '@hermes-pwa/core';
import { ReadAloudSettings } from './ReadAloudSettings';
import { readAloud } from '../lib/readAloud';
import { readReadAloudSettings } from '../lib/readAloudSettings';

function restWith(voices: SpeechVoices | Error): RestClient {
  return {
    speechVoices: vi.fn(() => (voices instanceof Error ? Promise.reject(voices) : Promise.resolve(voices))),
  } as unknown as RestClient;
}

const STANDARD_ONLY: SpeechVoices = {
  available: true,
  defaultVoice: 'Samantha',
  voices: [
    { id: 'Samantha', name: 'Samantha', lang: 'en-US', quality: 'standard' },
    { id: 'Daniel', name: 'Daniel', lang: 'en-GB', quality: 'standard' },
  ],
};

describe('ReadAloudSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows the Mac voice it will use, and how to get a more natural one', async () => {
    render(<ReadAloudSettings rest={restWith(STANDARD_ONLY)} />);
    await waitFor(() => expect(screen.getByTestId('read-aloud-voice')).toHaveTextContent('Samantha'));
    expect(screen.getByTestId('premium-voice-hint')).toHaveTextContent('Read & Speak');
  });

  it('does not suggest a download when a Premium voice is installed', async () => {
    const voices: SpeechVoices = {
      ...STANDARD_ONLY,
      defaultVoice: 'Ava (Premium)',
      voices: [{ id: 'Ava (Premium)', name: 'Ava', lang: 'en-US', quality: 'premium' }, ...STANDARD_ONLY.voices],
    };
    render(<ReadAloudSettings rest={restWith(voices)} />);
    await waitFor(() => expect(screen.getByTestId('read-aloud-voice')).toHaveTextContent('Ava'));
    expect(screen.queryByTestId('premium-voice-hint')).toBeNull();
  });

  it('saves a picked voice and plays a sample in it', async () => {
    const start = vi.spyOn(readAloud, 'start').mockImplementation(() => undefined);
    render(<ReadAloudSettings rest={restWith(STANDARD_ONLY)} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read aloud voice' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud voice' }));
    const daniel = screen.getAllByTestId('voice-row').find((row) => row.textContent?.includes('Daniel'));
    fireEvent.click(daniel!);
    expect(readReadAloudSettings().voice).toBe('Daniel');
    expect(start).toHaveBeenCalledWith('read-aloud-sample', expect.stringContaining('this is Daniel'));
    expect(screen.getByTestId('read-aloud-voice')).toHaveTextContent('Daniel');
  });

  it('saves the reading speed', async () => {
    render(<ReadAloudSettings rest={restWith(STANDARD_ONLY)} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Faster' }));
    expect(readReadAloudSettings().rate).toBe(1.2);
    expect(screen.getByRole('radio', { name: 'Faster' })).toHaveAttribute('aria-checked', 'true');
  });

  it("falls back to the phone's voice when Hermes is not on a Mac", async () => {
    render(<ReadAloudSettings rest={restWith({ available: false, voices: [], defaultVoice: undefined })} />);
    await waitFor(() => expect(screen.getByTestId('read-aloud-voice')).toHaveTextContent('This phone'));
    expect(screen.getByRole('button', { name: 'Read aloud voice' })).toBeDisabled();
  });

  it('says the Mac voices wait on a dashboard restart when the route is missing', async () => {
    render(<ReadAloudSettings rest={restWith(new HermesHttpError(404, 'Not Found', 'no such route'))} />);
    await waitFor(() => expect(screen.getByTestId('read-aloud-voice')).toHaveTextContent('This phone'));
    expect(screen.getByRole('button', { name: 'Read aloud voice' })).toHaveTextContent('once the Hermes dashboard restarts');
  });

  it('says so when the Mac cannot be reached', async () => {
    render(<ReadAloudSettings rest={restWith(new Error('offline'))} />);
    await waitFor(() => expect(screen.getByTestId('read-aloud-voice')).toHaveTextContent('This phone'));
    expect(screen.getByRole('button', { name: 'Read aloud voice' })).toHaveTextContent('Could not reach your Mac');
  });
});
