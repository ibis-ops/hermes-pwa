/**
 * The words of an error body: FastAPI answers `{"detail": "..."}`, and showing that JSON as is
 * reads like a crash. A body that is not such JSON is kept whole.
 */
export function readableErrorBody(body: string): string {
  const text = body.trim();
  if (!text.startsWith('{')) return body;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['detail', 'error', 'message']) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
  } catch {
    // Not JSON after all: keep the body.
  }
  return body;
}

export class HermesHttpError extends Error {
  readonly status: number;
  /** The body exactly as the server sent it. */
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(readableErrorBody(body) || statusText || `HTTP ${status}`);
    this.name = 'HermesHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface HermesRequestInit extends RequestInit {
  /** Skip automatically appending the active PWA profile query parameter. */
  skipProfile?: boolean;
  /** Abort the request after this many milliseconds. Defaults to 15s. */
  timeoutMs?: number;
}

export interface Http {
  <T>(path: string, init?: HermesRequestInit): Promise<T>;
  setProfile(name: string | undefined): void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('HTTP request timed out');
}

/**
 * Settle a body read against the request's abort signal. The headers can
 * arrive and the body then hang (a proxy holding the stream); fetch does not
 * always reject the pending read when the signal fires, so race it.
 */
function readUntilAborted<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function makeHttp(baseUrl = '', profile?: string): Http {
  let currentProfile = profile;

  async function http<T>(path: string, init: HermesRequestInit = {}): Promise<T> {
    const { skipProfile, timeoutMs = 15_000, signal: upstreamSignal, ...fetchInit } = init;
    let origin = 'http://localhost';
    if (typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null') {
      origin = window.location.origin;
    }
    const url = new URL(`${baseUrl}${path}`, origin);
    if (currentProfile && !skipProfile && !url.searchParams.has('profile')) {
      url.searchParams.set('profile', currentProfile);
    }

    const headers = new Headers(fetchInit.headers);
    if (fetchInit.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const abortFromUpstream = (): void => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    }
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(new Error('HTTP request timed out')), timeoutMs);
    }

    // The timeout covers the whole exchange, body included: headers that
    // arrive in time with a body that never finishes are still a hung request.
    try {
      const response = await fetch(url.toString(), {
        ...fetchInit,
        credentials: 'include',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new HermesHttpError(response.status, response.statusText, await readUntilAborted(response.text(), controller.signal));
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await readUntilAborted(response.json(), controller.signal)) as T;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
  }

  http.setProfile = (name: string | undefined): void => {
    currentProfile = name;
  };

  return http;
}
