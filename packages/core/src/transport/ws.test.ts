import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeWsConnection } from './ws';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  protocols: string | string[] | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
    MockWebSocket.instances = MockWebSocket.instances.filter((i) => i !== this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('makeWsConnection', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket as unknown as typeof WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    MockWebSocket.instances = [];
  });

  it('constructs the primary WebSocket without leaking the ticket in the URL', () => {
    const conn = makeWsConnection('wss://example.com');
    conn.connect('ticket-123', vi.fn(), vi.fn(), vi.fn());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.url).toBe('wss://example.com/api/ws');
    expect(MockWebSocket.instances[0]!.url).not.toContain('ticket-123');
    expect(MockWebSocket.instances[0]!.protocols).toEqual(['hermes.ws-ticket', 'ticket-123']);
  });

  it('falls back once to the upstream legacy query-ticket transport when the server refuses the subprotocol before open', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');

    conn.connect('ticket with spaces', onOpen, vi.fn(), onClose);
    const primary = MockWebSocket.instances[0]!;
    primary.simulateClose(1002);

    expect(onClose).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]!.url).toBe('wss://example.com/api/ws?ticket=ticket%20with%20spaces');
    expect(MockWebSocket.instances[1]!.protocols).toBeUndefined();

    MockWebSocket.instances[1]!.simulateOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('falls back on a TLS handshake failure (1015) before open', () => {
    const onClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');

    conn.connect('ticket-123', vi.fn(), vi.fn(), onClose);
    MockWebSocket.instances[0]!.simulateClose(1015);

    expect(onClose).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]!.url).toBe('wss://example.com/api/ws?ticket=ticket-123');
  });

  it('falls back once on 1006 before open, the only code a browser reports for a refused handshake', () => {
    const onClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');

    conn.connect('ticket-123', vi.fn(), vi.fn(), onClose);
    MockWebSocket.instances[0]!.simulateClose(1006);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]!.url).toBe('wss://example.com/api/ws?ticket=ticket-123');
    expect(onClose).not.toHaveBeenCalled();

    // The fallback failing too ends the attempt; no third socket.
    MockWebSocket.instances[1]!.simulateClose(1006);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not retry legacy fallback more than once for the same ticket', () => {
    const onClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');

    conn.connect('ticket-123', vi.fn(), vi.fn(), onClose);
    MockWebSocket.instances[0]!.simulateClose(1002);
    MockWebSocket.instances[1]!.simulateClose(1002);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to query-ticket after the primary socket has opened', () => {
    const onClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');

    conn.connect('ticket-123', vi.fn(), vi.fn(), onClose);
    MockWebSocket.instances[0]!.simulateOpen();
    MockWebSocket.instances[0]!.simulateClose(1002);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onOpen when ws opens', () => {
    const onOpen = vi.fn();
    const conn = makeWsConnection('wss://example.com');
    conn.connect('t', onOpen, vi.fn(), vi.fn());
    MockWebSocket.instances[0]!.simulateOpen();
    expect(onOpen).toHaveBeenCalled();
  });

  it('calls onMessage with split lines', () => {
    const onMessage = vi.fn();
    const conn = makeWsConnection('wss://example.com');
    conn.connect('t', vi.fn(), onMessage, vi.fn());
    MockWebSocket.instances[0]!.simulateMessage('line1\nline2\n');
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, 'line1');
    expect(onMessage).toHaveBeenNthCalledWith(2, 'line2');
  });

  it('calls onClose when an opened ws closes', () => {
    const onClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');
    conn.connect('t', vi.fn(), vi.fn(), onClose);
    MockWebSocket.instances[0]!.simulateOpen();
    MockWebSocket.instances[0]!.simulateClose();
    expect(onClose).toHaveBeenCalled();
  });

  it('close prevents onClose callback', () => {
    const onClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');
    conn.connect('t', vi.fn(), vi.fn(), onClose);
    const ws = MockWebSocket.instances[0]!;
    conn.close();
    ws.simulateClose();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('send delegates to ws after open', () => {
    const conn = makeWsConnection('wss://example.com');
    conn.connect('t', vi.fn(), vi.fn(), vi.fn());
    MockWebSocket.instances[0]!.simulateOpen();
    conn.send('hello');
    expect(MockWebSocket.instances[0]!.sent).toContain('hello');
  });

  it('send before open throws instead of silently dropping or queuing data', () => {
    const conn = makeWsConnection('wss://example.com');
    conn.connect('t', vi.fn(), vi.fn(), vi.fn());
    expect(() => conn.send('hello')).toThrow('WebSocket is not open');
  });

  it('connect closes the previous socket without firing stale onClose', () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');

    conn.connect('old', vi.fn(), vi.fn(), firstClose);
    const first = MockWebSocket.instances[0]!;
    conn.connect('new', vi.fn(), vi.fn(), secondClose);

    expect(first.readyState).toBe(3);
    expect(firstClose).not.toHaveBeenCalled();
    expect(MockWebSocket.instances[0]!.url).toBe('wss://example.com/api/ws');
    expect(MockWebSocket.instances[0]!.protocols).toEqual(['hermes.ws-ticket', 'new']);
  });

  it('old socket close does not clear the current socket or fire stale onClose', () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const conn = makeWsConnection('wss://example.com');

    conn.connect('old', vi.fn(), vi.fn(), firstClose);
    const first = MockWebSocket.instances[0]!;
    conn.connect('new', vi.fn(), vi.fn(), secondClose);
    const second = MockWebSocket.instances[0]!;

    first.onclose?.({ code: 1006 } as CloseEvent);
    second.simulateOpen();
    conn.send('current');

    expect(firstClose).not.toHaveBeenCalled();
    expect(second.sent).toContain('current');
  });
});
