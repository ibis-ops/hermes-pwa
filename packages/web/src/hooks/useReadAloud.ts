import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { RestClient } from '@hermes-pwa/core';
import { macCannotRead, readAloud, type ReadAloudSnapshot } from '../lib/readAloud';

/** Which reply is being read aloud, and how far along. */
export function useReadAloud(): ReadAloudSnapshot {
  return useSyncExternalStore(readAloud.subscribe, readAloud.getSnapshot, readAloud.getSnapshot);
}

/**
 * Read-aloud gets its audio from the Mac through this client. Mounted once by
 * the app shell, so a reply keeps playing while another tab is open; picking
 * another bot stops it, since the reply belongs to the chat left behind.
 */
export function useReadAloudSource(rest: RestClient, activeBot: string | undefined): void {
  useEffect(() => {
    readAloud.setSource({
      synthesize: (text, options) => rest.speechAudio(text, options),
      check: () =>
        rest.speechVoices().then(
          (voices) => voices.available,
          (err: unknown) => {
            if (macCannotRead(err)) return false;
            throw err;
          },
        ),
    });
    return () => {
      readAloud.stop();
      readAloud.setSource(undefined);
    };
  }, [rest]);

  const botRef = useRef(activeBot);
  useEffect(() => {
    if (botRef.current === activeBot) return;
    botRef.current = activeBot;
    readAloud.stop();
  }, [activeBot]);
}
