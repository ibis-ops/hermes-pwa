import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HermesHttpError, makeHttp } from './http';

describe('HermesHttpError', () => {
  it('constructs with status, statusText, and body', () => {
    const err = new HermesHttpError(404, 'Not Found', 'missing');
    expect(err.status).toBe(404);
    expect(err.body).toBe('missing');
    expect(err.message).toBe('missing');
    expect(err.name).toBe('HermesHttpError');
  });

  it('falls back to statusText when body is empty', () => {
    const err = new HermesHttpError(500, 'Internal Server Error', '');
    expect(err.message).toBe('Internal Server Error');
  });

  it('falls back to HTTP <status> when both body and statusText are empty', () => {
    const err = new HermesHttpError(503, '', '');
    expect(err.message).toBe('HTTP 503');
  });

  it('reads the words out of a FastAPI error body and keeps the body as sent', () => {
    const err = new HermesHttpError(404, 'Not Found', '{"detail":"Not Found"}');
    expect(err.message).toBe('Not Found');
    expect(err.body).toBe('{"detail":"Not Found"}');
    expect(new HermesHttpError(400, 'Bad Request', ' {"error": "that voice is not installed"} ').message).toBe('that voice is not installed');
    // Validation errors carry a list, not words: the body stays.
    const list = '{"detail":[{"loc":["body","name"],"msg":"field required"}]}';
    expect(new HermesHttpError(422, 'Unprocessable Entity', list).message).toBe(list);
    expect(new HermesHttpError(500, 'Internal Server Error', '{oops').message).toBe('{oops');
  });
});

describe('makeHttp', () => {
  const fetchSpy = vi.spyOn(globalThis as { fetch: typeof fetch }, 'fetch');

  beforeEach(() => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('calls fetch with the correct URL and default options', async () => {
    const http = makeHttp('https://api.example.com');
    await http('/test');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.any(Headers),
      })
    );
  });

  it('sets content-type header for JSON body', async () => {
    const http = makeHttp('');
    await http('/test', { method: 'POST', body: JSON.stringify({ foo: 'bar' }) });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('can skip the automatically appended active profile query parameter', async () => {
    const http = makeHttp('https://api.example.com', 'kimi-profile');
    await http('/api/profiles/kimi-profile/model', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'kimi-coding', model: 'kimi-k2-turbo-preview' }),
      skipProfile: true,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/api/profiles/kimi-profile/model',
      expect.objectContaining({ method: 'PUT' }),
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect('skipProfile' in init).toBe(false);
  });

  it('appends the active profile only when the request has no explicit profile query', async () => {
    const http = makeHttp('https://api.example.com', 'research');

    await http('/api/model/info');
    await http('/api/profiles/sessions?profile=all&limit=100');
    await http('/api/cron/jobs?profile=dev');

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://api.example.com/api/model/info?profile=research',
      expect.any(Object),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.example.com/api/profiles/sessions?profile=all&limit=100',
      expect.any(Object),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      'https://api.example.com/api/cron/jobs?profile=dev',
      expect.any(Object),
    );
  });

  it('preserves existing content-type header', async () => {
    const http = makeHttp('');
    await http('/test', {
      method: 'POST',
      body: 'plain text',
      headers: { 'content-type': 'text/plain' },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('content-type')).toBe('text/plain');
  });

  it('returns parsed JSON on 200', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: 42 }), { status: 200 })
    );
    const http = makeHttp('http://localhost');
    const result = await http<{ data: number }>('/test');
    expect(result).toEqual({ data: 42 });
  });

  it('returns undefined on 204', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const http = makeHttp('http://localhost');
    const result = await http('/test');
    expect(result).toBeUndefined();
  });

  it('throws HermesHttpError on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('bad request', { status: 400, statusText: 'Bad Request' })
    );
    const http = makeHttp('http://localhost');
    await expect(http('/test')).rejects.toThrow(HermesHttpError);
  });

  it('throws with correct message on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('not found', { status: 404, statusText: 'Not Found' })
    );
    const http = makeHttp('http://localhost');
    await expect(http('/test')).rejects.toThrow('not found');
  });

  it('includes status and body in thrown error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('server error', { status: 500, statusText: 'Server Error' })
    );
    const http = makeHttp('http://localhost');
    try {
      await http('/test');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HermesHttpError);
      expect((err as HermesHttpError).status).toBe(500);
      expect((err as HermesHttpError).body).toBe('server error');
    }
  });

  it('times out a body that never finishes after the headers arrived', async () => {
    // A proxy can deliver the headers and then hold the stream; the timeout
    // used to stop at the headers, so this request hung forever.
    vi.useFakeTimers();
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => new Promise(() => undefined),
        text: () => new Promise(() => undefined),
      } as unknown as Response),
    );

    const http = makeHttp('http://localhost');
    const request = http('/hung-body', { timeoutMs: 20 });
    const rejection = expect(request).rejects.toThrow('HTTP request timed out');
    await vi.advanceTimersByTimeAsync(20);

    await rejection;
  });

  it('times out an error body that never finishes', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: () => new Promise(() => undefined),
        text: () => new Promise(() => undefined),
      } as unknown as Response),
    );

    const http = makeHttp('http://localhost');
    const request = http('/hung-error-body', { timeoutMs: 20 });
    const rejection = expect(request).rejects.toThrow('HTTP request timed out');
    await vi.advanceTimersByTimeAsync(20);

    await rejection;
  });

  it('still returns a body that completes within the timeout', async () => {
    const http = makeHttp('http://localhost');
    await expect(http<{ ok: boolean }>('/quick', { timeoutMs: 1_000 })).resolves.toEqual({ ok: true });
  });

  it('aborts fetch when the request timeout elapses', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      const signal = (init as RequestInit).signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => reject(signal.reason));
    }));

    const http = makeHttp('http://localhost');
    const request = http('/slow', { timeoutMs: 15 });
    const rejection = expect(request).rejects.toThrow('HTTP request timed out');
    await vi.advanceTimersByTimeAsync(15);

    await rejection;
  });
});
