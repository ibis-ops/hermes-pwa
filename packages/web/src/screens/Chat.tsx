import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useChatStore,
  useProfilesStore,
  useActivityStore,
  useConfigStore,
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
import { ConfirmSheet } from '../components/ActionSheet';
import { pendingApprovalsForMessage, selectPendingApprovals } from '../lib/pendingApprovals';
import { formatDividerTime, needsTimeDivider, toMillis } from '../lib/chatTime';
import { DEFAULT_SKILL_EVENT, applyDefaultSkill, readDefaultSkill } from '../lib/defaultSkill';

interface ChatProps {
  rpc: RpcClient;
  rest: RestClient;
}

type BusyInputMode = 'queue' | 'steer' | 'interrupt';

const SILENT_WAV_DATA_URL =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

function normalizeBusyInputMode(value: unknown): BusyInputMode {
  return value === 'queue' || value === 'interrupt' || value === 'steer' ? value : 'queue';
}

/** Epoch seconds of the user prompt a reply at `index` answers, when known. */
function promptTimeBefore(messages: import('@hermes-pwa/core').Message[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate) continue;
    if (candidate.role === 'user') return candidate.createdAt;
    if (candidate.role === 'assistant') return undefined;
  }
  return undefined;
}

export function Chat({ rpc, rest }: ChatProps) {
  // The live stream, the queue and the status line all live in the store (the
  // shell keeps them in step with the gateway, whichever screen is open); this
  // screen renders them and sends what the composer hands it. Narrow
  // subscriptions: a streaming delta re-renders this screen for the
  // transcript, nothing else needs to.
  const { messages, streaming, error, sessionId, storedSessionId, liveStatus, queuedPrompts, lastFailedText, stoppedSessionId } =
    useChatStore(
      useShallow((s) => ({
        messages: s.messages,
        streaming: s.streaming,
        error: s.error,
        sessionId: s.sessionId,
        storedSessionId: s.storedSessionId,
        liveStatus: s.liveStatus,
        queuedPrompts: s.queuedPrompts,
        lastFailedText: s.lastFailedText,
        stoppedSessionId: s.stoppedSessionId,
      })),
    );
  const submit = useChatStore((s) => s.submit);
  const steer = useChatStore((s) => s.steer);
  const interrupt = useChatStore((s) => s.interrupt);
  const ensureLiveSession = useChatStore((s) => s.ensureLiveSession);
  const enqueuePrompt = useChatStore((s) => s.enqueuePrompt);
  const cancelQueuedPrompt = useChatStore((s) => s.cancelQueuedPrompt);
  const pendingApprovals = useActivityStore(useShallow((s) => selectPendingApprovals(s.items)));
  const pendingApprovalCount = pendingApprovals.length;
  const config = useConfigStore((s) => s.config);
  const busyInputMode = normalizeBusyInputMode(config?.display?.busy_input_mode);
  const activeName = useProfilesStore((s) => s.activeName);
  const currentName = useProfilesStore((s) => s.currentName);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollFrameKindRef = useRef<'animation' | 'timeout'>('animation');
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceAudioSequenceRef = useRef(0);
  const [composerLayoutVersion, setComposerLayoutVersion] = useState(0);
  // Shown when the reply grows below the fold because the person scrolled up.
  const [newBelow, setNewBelow] = useState(false);
  // The gateway runs every profile and binds a session to the one named at
  // session.create, so the selected bot (activeName) is the one to talk to;
  // currentName is only the profile the gateway process was launched with.
  const profileForSubmit = activeName ?? currentName;
  const activeSessionIds = useMemo(
    () => [sessionId, storedSessionId].filter((value): value is string => Boolean(value)),
    [sessionId, storedSessionId],
  );

  const handleComposerLayoutChange = useCallback(() => {
    setComposerLayoutVersion((value) => value + 1);
  }, []);

  const markLocalInputShouldScroll = useCallback(() => {
    atBottomRef.current = true;
    forceScrollRef.current = true;
  }, []);

  // A prompt the gateway did not take (not a busy answer) goes back into the
  // composer, once; the store hands it over and forgets it.
  const returnedTextTaken = useCallback(() => {
    useChatStore.setState({ lastFailedText: undefined });
  }, []);

  const lastMessage = messages[messages.length - 1];
  // The steered message of the turn in progress gets an inline way out:
  // stop the turn and send that text as a fresh prompt.
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') return i;
    return -1;
  })();
  const steeredMessage = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  // Ending a running task cannot be undone, so the inline link asks first.
  const [confirmInterrupt, setConfirmInterrupt] = useState(false);
  const askInterruptSteer = useCallback(() => setConfirmInterrupt(true), []);
  const interruptSteer = useCallback(() => {
    // The turn may have ended while the question was open: the steer is then
    // already answered, and sending it again would run it twice.
    if (!steeredMessage || !useChatStore.getState().streaming) return;
    markLocalInputShouldScroll();
    enqueuePrompt(steeredMessage.text, { front: true });
    void interrupt(rpc, { keepStreaming: true });
  }, [steeredMessage, enqueuePrompt, interrupt, markLocalInputShouldScroll, rpc]);
  const interruptSteerIndex = streaming && steeredMessage?.displayKind === 'steer' ? lastUserIndex : -1;
  useEffect(() => {
    if (interruptSteerIndex < 0) setConfirmInterrupt(false);
  }, [interruptSteerIndex]);
  // The reply of a turn Hermes ended early says "Stopped" until the next turn.
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'assistant') return i;
    return -1;
  })();
  const stoppedIndex = !streaming && stoppedSessionId && stoppedSessionId === sessionId ? lastAssistantIndex : -1;
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
    queuedPrompts.length,
  ].join(':');

  useEffect(() => {
    const el = listRef.current;
    const shouldForce = forceScrollRef.current;
    if (!el) return;
    if (!atBottomRef.current && !shouldForce) {
      // Content changed while the person was reading further up: offer a way
      // back down instead of yanking the list.
      if (el.scrollHeight - el.clientHeight - el.scrollTop > 40) setNewBelow(true);
      return;
    }
    if (scrollFrameRef.current !== null) return;
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
  }, [scrollContentSignal, pendingApprovalCount, liveStatus, streaming, error, composerLayoutVersion]);

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
    if (atBottomRef.current) setNewBelow(false);
  }

  const scrollToLatest = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setNewBelow(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  const busySubmitLabel =
    busyInputMode === 'queue' ? 'Queue message' : busyInputMode === 'interrupt' ? 'Interrupt and send' : 'Steer agent';
  const busyPlaceholder =
    busyInputMode === 'queue'
      ? 'Send after this reply…'
      : busyInputMode === 'interrupt'
        ? 'Interrupt and send…'
        : 'Steer the reply…';

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
        if (accepted) {
          // Steered text joins the running turn: show it in the chat now, and
          // let the rest of the reply land in a fresh row after it.
          useChatStore.getState().addSteeredMessage(text);
        } else {
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

  // The profile's default skill opens every new chat: the first message goes
  // out as `/skill message` and Hermes expands it. Ongoing chats carry the skill
  // in their history already, so only an empty chat gets it.
  const [defaultSkill, setDefaultSkill] = useState<string | undefined>(() => readDefaultSkill(activeName));
  useEffect(() => {
    setDefaultSkill(readDefaultSkill(activeName));
    const onChange = () => setDefaultSkill(readDefaultSkill(activeName));
    window.addEventListener(DEFAULT_SKILL_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(DEFAULT_SKILL_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [activeName]);

  const handleSend = useCallback(
    (text: string) => {
      const isNewChat = useChatStore.getState().messages.length === 0;
      submitPrompt(applyDefaultSkill(text, defaultSkill, isNewChat));
    },
    [submitPrompt, defaultSkill],
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
        {messages.length === 0 ? (
          <div className="hm-empty-state hm-empty-state--chat">
            <img className="hm-empty-state__logo" src="./icons/icon-192.png" alt="" aria-hidden="true" />
            <h2>Start a conversation</h2>
            <p className="hm-muted">Type a message, attach a photo, or tap the mic to dictate. Earlier chats are in the menu.</p>
            {defaultSkill ? (
              <p className="hm-empty-state__skill" data-testid="default-skill-hint">
                <Icon name="bolt" size={13} />
                Starts with /{defaultSkill}
              </p>
            ) : null}
          </div>
        ) : (
          messages.map((m, index) => {
            const at = toMillis(m.createdAt);
            const previousAt = index > 0 ? toMillis(messages[index - 1]?.createdAt) : undefined;
            const divider = needsTimeDivider(previousAt, at) && at !== undefined ? formatDividerTime(at) : undefined;
            const promptAt = m.role === 'assistant' ? promptTimeBefore(messages, index) : undefined;
            return (
              <div key={m.id} className="hm-chat__entry">
                {divider ? (
                  <div className="hm-chat__time" role="separator" aria-label={divider} data-testid="time-divider">
                    {divider}
                  </div>
                ) : null}
                <MessageBubble
                  message={m}
                  rpc={rpc}
                  rest={rest}
                  isLast={index === messages.length - 1}
                  streaming={streaming}
                  liveStatus={index === messages.length - 1 && streaming ? liveStatus : ''}
                  pendingApprovals={pendingApprovalsForMessage(pendingApprovals, index, messages.length)}
                  activeSessionIds={activeSessionIds}
                  elapsedFrom={promptAt}
                  onInterruptSteer={index === interruptSteerIndex ? askInterruptSteer : undefined}
                  stopped={index === stoppedIndex}
                />
              </div>
            );
          })
        )}

        {queuedPrompts.map((text, index) => (
          <div key={`queued-${index}-${text.slice(0, 24)}`} className="hm-chat__entry">
            <div className="hm-message-group hm-message-group--user hm-message-group--queued" data-testid="queued-prompt">
              <div className="hm-message hm-message--user">
                <p>{text}</p>
              </div>
              <div className="hm-message__meta hm-message__meta--user hm-message__meta--queued">
                {busyInputMode === 'interrupt' ? 'Sends once the current task stops' : 'Queued, sends when Hermes finishes'}
                {' · '}
                <button type="button" className="hm-message__meta-action" onClick={() => cancelQueuedPrompt(index)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ))}

        {error ? <div className="hm-warning-banner hm-warning-banner--error" role="alert">{error}</div> : null}
        {newBelow ? (
          <button type="button" className="hm-chat__jump" onClick={scrollToLatest} data-testid="jump-to-latest">
            <Icon name="chevD" size={14} />
            <span>{streaming ? 'New reply' : 'Latest'}</span>
          </button>
        ) : null}
      </div>
      <Composer
        onSend={handleSend}
        slashCommandsRpc={rpc}
        onSteer={handleBusyInput}
        onStop={() => void interrupt(rpc)}
        busy={streaming}
        busySubmitLabel={busySubmitLabel}
        placeholder={streaming ? busyPlaceholder : 'Message'}
        messages={messages}
        onTranscribeAudio={handleTranscribeAudio}
        onSpeakVoiceText={speakVoiceText}
        onStopVoiceAudio={stopVoiceAudio}
        onPrimeVoiceAudio={primeVoiceAudio}
        onUploadFile={handleUploadFile}
        onLayoutChange={handleComposerLayoutChange}
        rest={rest}
        draftKey={activeName ?? 'default'}
        returnedText={lastFailedText}
        onReturnedTextTaken={returnedTextTaken}
      />
      {confirmInterrupt ? (
        <ConfirmSheet
          title="Stop the current task?"
          message="Hermes ends what it is doing now, then answers this message as a new request."
          confirmLabel="Stop and send now"
          destructive
          onConfirm={interruptSteer}
          onClose={() => setConfirmInterrupt(false)}
        />
      ) : null}
    </div>
  );
}
