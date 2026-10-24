/**
 * WebSocket lifecycle — plain wrapper, no reconnect logic.
 * Reconnect lives in the connection store (single source of truth).
 */

export type WsMessageHandler = (line: string) => void;
export type WsOpenHandler = () => void;
export type WsCloseHandler = (event: CloseEvent) => void;

export interface WsConnection {
  connect(ticket: string, onOpen: WsOpenHandler, onMessage: WsMessageHandler, onClose: WsCloseHandler): void;
  send(data: string): void;
  close(): void;
}

const WS_TICKET_PROTOCOL = 'hermes.ws-ticket';

export function makeWsConnection(baseWsUrl: string): WsConnection {
  let ws: WebSocket | null = null;
  let onCloseRef: WsCloseHandler | null = null;

  function connect(ticket: string, onOpen: WsOpenHandler, onMessage: WsMessageHandler, onClose: WsCloseHandler): void {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }

    let opened = false;
    let legacyFallbackTried = false;
    onCloseRef = onClose;

    const openSocket = (legacyQueryTicket: boolean): void => {
      const url = legacyQueryTicket
        ? `${baseWsUrl}/api/ws?ticket=${encodeURIComponent(ticket)}`
        : `${baseWsUrl}/api/ws`;
      const socket = legacyQueryTicket ? new WebSocket(url) : new WebSocket(url, [WS_TICKET_PROTOCOL, ticket]);
      ws = socket;

      socket.onopen = () => {
        if (ws !== socket) return;
        opened = true;
        onOpen();
      };

      socket.onmessage = (event) => {
        if (ws !== socket) return;
        const lines = String(event.data).split('\n').filter(Boolean);
        for (const line of lines) {
          onMessage(line);
        }
      };

      socket.onclose = (event) => {
        if (ws !== socket) return;

        // Only a handshake the server refused (abnormal or protocol close before
        // open) justifies retrying with the ticket in the query string, where
        // proxies and access logs can see it.
        const refusedHandshake = event.code === 1006 || event.code === 1002 || event.code === 1015;
        if (!opened && !legacyQueryTicket && !legacyFallbackTried && refusedHandshake) {
          legacyFallbackTried = true;
          socket.onclose = null;
          ws = null;
          openSocket(true);
          return;
        }

        ws = null;
        onCloseRef?.(event);
      };

      socket.onerror = () => {
        // Let onclose handle cleanup and the pre-open legacy fallback.
      };
    };

    openSocket(false);
  }

  function send(data: string): void {
    const openState = typeof WebSocket.OPEN === 'number' ? WebSocket.OPEN : 1;
    if (!ws || ws.readyState !== openState) {
      throw new Error('WebSocket is not open');
    }
    ws.send(data);
  }

  function close(): void {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    onCloseRef = null;
  }

  return { connect, send, close };
}
