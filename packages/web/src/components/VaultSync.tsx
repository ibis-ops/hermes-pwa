import { useState } from 'react';
import { HermesHttpError, type RestClient } from '@hermes-pwa/core';
import { Icon } from './Icon';

interface VaultSyncProps {
  rest: RestClient;
  /** The vault name "Open Obsidian here" opens on this phone. */
  linkVault: string | undefined;
  /** Reload the list on screen once the Mac has answered. */
  onSynced: () => Promise<void>;
}

interface SyncNote {
  tone: 'ok' | 'error';
  text: string;
  /** Offer to open Obsidian on this phone, which pulls the latest down. */
  openPhone?: boolean;
}

/**
 * Sync vault: Obsidian Sync carries the vault between the Mac and this phone,
 * but only while Obsidian is open on the Mac, so this opens it there when it
 * is closed and says what happened.
 */
export function VaultSync({ rest, linkVault, onSynced }: VaultSyncProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<SyncNote | undefined>(undefined);

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    setSyncNote(undefined);
    try {
      const result = await rest.obsidianSync();
      await onSynced();
      if (!result.available) {
        setSyncNote({
          tone: 'error',
          text: 'Obsidian is not installed on your Mac, so there is nothing to sync from there.',
        });
      } else if (!result.running) {
        setSyncNote({
          tone: 'error',
          text: 'Obsidian did not open on your Mac. Open it there once, then try again.',
        });
      } else if (result.started) {
        setSyncNote({
          tone: 'ok',
          text: 'Opened Obsidian on your Mac so Sync can catch up.',
          openPhone: true,
        });
      } else {
        setSyncNote({
          tone: 'ok',
          text: 'Obsidian is open on your Mac and syncing.',
          openPhone: true,
        });
      }
    } catch (err) {
      if (err instanceof HermesHttpError && err.status === 404) {
        await onSynced();
        setSyncNote({
          tone: 'ok',
          text: 'List refreshed. Restart the Hermes dashboard on your Mac to let Sync open Obsidian there.',
        });
      } else {
        setSyncNote({
          tone: 'error',
          text: err instanceof Error && err.message ? err.message : 'Could not reach your Mac.',
        });
      }
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="hm-obsidian__sync">
      <button
        type="button"
        className="hm-obsidian__sync-btn"
        onClick={() => void sync()}
        disabled={syncing}
        data-testid="obsidian-sync"
      >
        <span
          className="hm-obsidian__sync-icon"
          data-spinning={syncing ? 'true' : 'false'}
          aria-hidden="true"
        >
          <Icon name="refresh" size={16} />
        </span>
        <span>{syncing ? 'Syncing…' : 'Sync vault'}</span>
      </button>
      {syncNote ? (
        <p
          className={`hm-obsidian__sync-note${syncNote.tone === 'error' ? ' hm-obsidian__sync-note--error' : ''}`}
          role="status"
        >
          {syncNote.text}
          {syncNote.openPhone ? (
            <>
              {' '}
              <a
                className="hm-obsidian__sync-open"
                href={`obsidian://open${linkVault ? `?vault=${encodeURIComponent(linkVault)}` : ''}`}
              >
                Open Obsidian here
              </a>{' '}
              to pull the latest.
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
