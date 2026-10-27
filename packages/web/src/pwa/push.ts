import type { PushSubscribeBody, PushSubscriptionSafe, RestClient } from '@hermes-pwa/core';

export interface PushCapability {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  reason?: string;
  iosStandaloneRequired: boolean;
  installedStandalone: boolean;
}

function isIosLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

export function getPushCapability(): PushCapability {
  const permission: NotificationPermission | 'unsupported' = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const installedStandalone = isStandaloneDisplay();
  const iosStandaloneRequired = isIosLike() && !installedStandalone;

  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, permission, reason: 'Browser APIs are unavailable.', iosStandaloneRequired, installedStandalone };
  }
  if (!('serviceWorker' in navigator)) {
    return { supported: false, permission, reason: 'This browser does not support service workers.', iosStandaloneRequired, installedStandalone };
  }
  if (typeof Notification === 'undefined') {
    return { supported: false, permission, reason: 'This browser does not support notifications.', iosStandaloneRequired, installedStandalone };
  }
  if (!('PushManager' in window)) {
    return { supported: false, permission, reason: 'This browser does not support Web Push.', iosStandaloneRequired, installedStandalone };
  }
  if (iosStandaloneRequired) {
    return {
      supported: false,
      permission,
      reason: 'On iPhone/iPad, install Hermes Mobile to Home Screen first; Safari tabs cannot receive Web Push.',
      iosStandaloneRequired,
      installedStandalone,
    };
  }
  return { supported: true, permission, iosStandaloneRequired, installedStandalone };
}

export function urlBase64ToUint8Array(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output.buffer;
}

async function currentBrowserSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/** Whether this browser holds a live push subscription with permission granted: the switch's state. */
export async function hasBrowserPushSubscription(): Promise<boolean> {
  if (!getPushCapability().supported) return false;
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return false;
  try {
    return (await currentBrowserSubscription()) !== null;
  } catch {
    return false;
  }
}

export async function enablePushNotifications(
  rest: RestClient,
  vapidPublicKey: string,
  profile: string,
  label = 'Hermes Mobile',
): Promise<PushSubscriptionSafe> {
  const capability = getPushCapability();
  if (!capability.supported) {
    throw new Error(capability.reason ?? 'Push notifications are not supported.');
  }
  if (!vapidPublicKey) {
    throw new Error('Push server is missing a VAPID public key.');
  }

  let permission = Notification.permission;
  if (permission === 'default') {
    // Must be called from a user gesture by the Settings button handler.
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const body: PushSubscribeBody = { subscription: subscription.toJSON(), label };
  return rest.pushSubscribe(body, profile);
}

export async function disablePushNotifications(rest: RestClient, id: string | undefined, profile: string): Promise<void> {
  const subscription = await currentBrowserSubscription().catch(() => null);
  if (subscription) {
    await subscription.unsubscribe().catch(() => false);
  }
  const body: { id?: string; endpoint?: string } = {};
  if (id) body.id = id;
  if (subscription?.endpoint) body.endpoint = subscription.endpoint;
  await rest.pushUnsubscribe(body, profile);
}

/**
 * Automatically re-register the browser push subscription with the server
 * if it has drifted (e.g. after PWA reinstall, SW update, or iOS endpoint rotation).
 *
 * This runs on app startup WITHOUT requiring a user gesture: if the browser
 * already has Notification.permission === 'granted' and an active PushSubscription,
 * we simply make sure the server knows about it. No permission prompts are shown.
 *
 * Returns true if a re-sync happened.
 */
export async function syncPushSubscription(
  rest: RestClient,
  vapidPublicKey: string,
  profile: string,
  label = 'Hermes Mobile',
): Promise<boolean> {
  const capability = getPushCapability();
  if (!capability.supported) return false;
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return false;
  if (!vapidPublicKey) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const browserSub = await registration.pushManager.getSubscription();
    if (!browserSub) return false;

    // Always re-register. The backend push/subscribe endpoint is idempotent:
    // it upserts by endpoint hash, so re-subscribing with the same endpoint
    // is a no-op. If the browser endpoint changed (after reinstall/SW update),
    // this creates a new server record and marks the old one stale.
    const body: PushSubscribeBody = { subscription: browserSub.toJSON(), label };
    await rest.pushSubscribe(body, profile);
    return true;
  } catch {
    // Best-effort sync; don't break app startup if push re-sync fails.
    return false;
  }
}

const TURN_TAG_PREFIX = 'hermes-turn:';

async function closeTurnNotifications(tag?: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (!registration || typeof registration.getNotifications !== 'function') return;
  const shown = await registration.getNotifications(tag ? { tag } : undefined).catch(() => [] as Notification[]);
  for (const notification of shown) {
    if (notification.tag.startsWith(TURN_TAG_PREFIX)) notification.close();
  }
}

/**
 * "Hermes replied" banners are for a phone in the pocket. While the app is on
 * screen the answer is already in view, so a banner that arrives then is
 * closed at once, and any that piled up while the app was away are cleared
 * when it comes back.
 */
export function installPushForegroundHandling(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; kind?: unknown; tag?: unknown } | null;
    if (!data || data.type !== 'hermes-push' || data.kind !== 'turn.complete') return;
    if (document.visibilityState !== 'visible') return;
    void closeTurnNotifications(typeof data.tag === 'string' ? data.tag : undefined);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void closeTurnNotifications();
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  document.addEventListener('visibilitychange', onVisible);
  onVisible();
  return () => {
    navigator.serviceWorker.removeEventListener('message', onMessage);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
