import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRestClient } from './rest';
import { HermesHttpError } from './http';
import type { Http } from './http';

describe('makeRestClient', () => {
  let httpMock: ReturnType<typeof vi.fn<Parameters<Http>, ReturnType<Http>>> & Pick<Http, 'setProfile'>;
  let client: ReturnType<typeof makeRestClient>;

  function queryForCall(callIndex: number): URLSearchParams {
    const [path] = httpMock.mock.calls[callIndex] ?? [];
    return new URL(String(path), 'https://hermes.test').searchParams;
  }

  beforeEach(() => {
    const fn = vi.fn<Parameters<Http>, ReturnType<Http>>() as typeof httpMock;
    fn.setProfile = vi.fn();
    httpMock = fn;
    client = makeRestClient(httpMock as unknown as Http);
  });

  it('status maps raw response to GatewayStatus', async () => {
    httpMock.mockResolvedValue({
      auth_required: true,
      auth_providers: ['basic'],
      gateway_state: 'running',
      version: '0.1.0',
      release_date: '2024-01-01',
      gateway_running: true,
      active_sessions: 5,
    });
    const status = await client.status();
    expect(status.authRequired).toBe(true);
    expect(status.authProviders).toEqual(['basic']);
    expect(status.gatewayState).toBe('running');
    expect(status.version).toBe('0.1.0');
    expect(status.activeSessions).toBe(5);
  });

  it('status defaults authRequired to false and authProviders to empty', async () => {
    httpMock.mockResolvedValue({});
    const status = await client.status();
    expect(status.authRequired).toBe(false);
    expect(status.authProviders).toEqual([]);
    expect(status.gatewayState).toBeUndefined();
  });

  it('providers maps raw response to AuthProvider array', async () => {
    httpMock.mockResolvedValue({
      providers: [
        { name: 'basic', display_name: 'Basic Auth', supports_password: true },
        { name: 'oauth', display_name: 'OAuth' },
      ],
    });
    const providers = await client.providers();
    expect(providers).toHaveLength(2);
    expect(providers[0]).toEqual({ name: 'basic', displayName: 'Basic Auth', supportsPassword: true });
    expect(providers[1]).toEqual({ name: 'oauth', displayName: 'OAuth', supportsPassword: false });
  });

  it('providers returns empty array when no providers field', async () => {
    httpMock.mockResolvedValue({});
    const providers = await client.providers();
    expect(providers).toEqual([]);
  });

  it('passwordLogin POSTs body and returns result', async () => {
    httpMock.mockResolvedValue({ ok: true, next: '/' });
    const result = await client.passwordLogin({ provider: 'basic', username: 'u', password: 'p' });
    expect(result.ok).toBe(true);
    expect(httpMock).toHaveBeenCalledWith('/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ provider: 'basic', username: 'u', password: 'p' }),
    });
  });

  it('sessionMessages asks for the folded (compacted) turns and scopes to the profile', async () => {
    httpMock.mockResolvedValue({ messages: [] });
    await client.sessionMessages('stored 1', 'dev');
    const [path] = httpMock.mock.calls[0] ?? [];
    expect(String(path)).toMatch(/^\/api\/sessions\/stored%201\/messages\?/u);
    expect(queryForCall(0).get('include_compacted')).toBe('true');
    expect(queryForCall(0).get('profile')).toBe('dev');
    await client.sessionMessages('stored-2');
    expect(queryForCall(1).get('profile')).toBeNull();
    expect(queryForCall(1).get('include_compacted')).toBe('true');
  });

  it('me maps raw user with all fields', async () => {
    httpMock.mockResolvedValue({
      user_id: 'u-1',
      email: 'a@b.com',
      display_name: 'Alice',
      org_id: 'o-1',
      provider: 'basic',
      expires_at: 1234567890,
    });
    const user = await client.me();
    expect(user.userId).toBe('u-1');
    expect(user.email).toBe('a@b.com');
    expect(user.displayName).toBe('Alice');
    expect(user.orgId).toBe('o-1');
  });

  it('me provides defaults for missing fields', async () => {
    httpMock.mockResolvedValue({});
    const user = await client.me();
    expect(user.userId).toBe('unknown');
    expect(user.displayName).toBe('Hermes user');
    expect(user.provider).toBe('unknown');
    expect(user.expiresAt).toBe(0);
  });

  it('wsTicket maps raw ticket', async () => {
    httpMock.mockResolvedValue({ ticket: 'abc-123', ttl_seconds: 30 });
    const ticket = await client.wsTicket();
    expect(ticket.ticket).toBe('abc-123');
    expect(ticket.ttlSeconds).toBe(30);
  });

  it('wsTicket defaults ttlSeconds to 30 when missing', async () => {
    httpMock.mockResolvedValue({ ticket: 'xyz' });
    const ticket = await client.wsTicket();
    expect(ticket.ticket).toBe('xyz');
    expect(ticket.ttlSeconds).toBe(30);
  });

  it('profileSessions fetches only the release-scope local session slice', async () => {
    httpMock.mockResolvedValueOnce({
      sessions: [
        {
          id: 'local-chat',
          title: 'Local work',
          source: 'tui',
          last_active: 200,
          message_count: 12,
        },
      ],
    });

    const sessions = await client.profileSessions();

    expect(httpMock).toHaveBeenCalledTimes(1);
    expect(queryForCall(0).get('profile')).toBe('default');
    expect(queryForCall(0).get('exclude_sources')).toContain('telegram');
    expect(queryForCall(0).get('exclude_sources')).toContain('discord');
    expect(queryForCall(0).get('exclude_sources')).toContain('cron');
    expect(queryForCall(0).get('exclude_sources')).toContain('curator');
    expect(sessions.map((s) => s.id)).toEqual(['local-chat']);
  });

  it('latestSession asks one bot for its single newest local chat', async () => {
    httpMock.mockResolvedValueOnce({ sessions: [{ id: 'mgr-1', title: 'Clarify what happened', source: 'tui', last_active: 300 }] });

    const latest = await client.latestSession('manager');

    expect(queryForCall(0).get('profile')).toBe('manager');
    expect(queryForCall(0).get('limit')).toBe('1');
    expect(queryForCall(0).get('order')).toBe('recent');
    expect(httpMock.mock.calls[0]?.[1]).toEqual({ skipProfile: true });
    expect(latest?.title).toBe('Clarify what happened');

    httpMock.mockResolvedValueOnce({ sessions: [] });
    await expect(client.latestSession('quiet-bot')).resolves.toBeUndefined();
  });

  it('profileSessions scopes the local slice to the active profile', async () => {
    client.setActiveProfile('dev');
    httpMock.mockResolvedValueOnce({ sessions: [{ id: 'dev-local', title: 'Dev local', source: 'tui', last_active: 1 }] });

    const sessions = await client.profileSessions();

    expect(httpMock.setProfile).toHaveBeenCalledWith('dev');
    expect(httpMock).toHaveBeenCalledTimes(1);
    expect(queryForCall(0).get('profile')).toBe('dev');
    expect(sessions.map((s) => s.id)).toEqual(['dev-local']);
  });

  it('browseOnlySessions lists Signal and scheduled rows from every profile and adds delegated runs from the plugin history', async () => {
    httpMock.mockImplementation(async (path) => {
      const url = new URL(String(path), 'https://hermes.test');
      if (url.pathname === '/api/profiles/sessions') {
        return {
          sessions: [
            { id: 'cron-1', title: 'Nightly review', source: 'cron', profile: 'default', last_active: 1_792_860_000, message_count: 4 },
            { id: 'sig-1', title: 'Weekly workout log', source: 'signal', profile: 'signal-connector', last_active: 1_792_850_000, message_count: 25 },
          ],
        };
      }
      if (url.pathname === '/api/plugins/hermes-pwa/agents/history') {
        return {
          runs: [
            {
              id: 'sub-1',
              bot: 'google-calander',
              owner_profile: 'default',
              goal: 'Check the calendar',
              status: 'completed',
              started_at: 1_792_855_000,
              ended_at: 1_792_855_400,
              message_count: 13,
              parent: { id: 'p-1', title: 'Morning chat', source: 'signal', profile: 'default' },
            },
          ],
        };
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    const sessions = await client.browseOnlySessions();

    const listing = queryForCall(0);
    expect(listing.get('profile')).toBe('all');
    expect(listing.get('sources')).toContain('signal');
    expect(listing.get('sources')).toContain('cron');
    // Hermes hides sub-agent rows from a source-scoped listing; they come from the plugin.
    expect(listing.get('sources')?.split(',')).not.toContain('subagent');
    expect(httpMock.mock.calls.map(([path]) => new URL(String(path), 'https://hermes.test').pathname)).toContain(
      '/api/plugins/hermes-pwa/agents/history',
    );
    expect(sessions.map((s) => s.id)).toEqual(['cron-1', 'sub-1', 'sig-1']);
    expect(sessions[1]).toMatchObject({ source: 'subagent', profile: 'default', profileName: 'google-calander', parentSessionId: 'p-1', messageCount: 13 });
  });

  it('browseOnlySessions keeps the listed rows when the plugin history is unavailable', async () => {
    httpMock.mockImplementation(async (path) => {
      const url = new URL(String(path), 'https://hermes.test');
      if (url.pathname === '/api/profiles/sessions') {
        return { sessions: [{ id: 'sig-1', title: 'Weekly workout log', source: 'signal', profile: 'default', last_active: 1 }] };
      }
      throw new HermesHttpError(404, 'Not Found', '');
    });

    const sessions = await client.browseOnlySessions();

    expect(sessions.map((s) => s.id)).toEqual(['sig-1']);
  });

  it('browseOnlySessions fails when the session listing itself fails', async () => {
    httpMock.mockImplementation(async (path) => {
      const url = new URL(String(path), 'https://hermes.test');
      if (url.pathname === '/api/profiles/sessions') throw new HermesHttpError(503, 'Service Unavailable', '');
      return { runs: [] };
    });

    await expect(client.browseOnlySessions()).rejects.toBeInstanceOf(HermesHttpError);
  });

  it('profileSessions does not call the PWA messaging binding shim in the TUI/CLI release scope', async () => {
    httpMock.mockResolvedValueOnce({ sessions: [{ id: 'core-only', title: 'Core', source: 'tui', last_active: 1 }] });

    const sessions = await client.profileSessions();

    expect(sessions.map((s) => s.id)).toEqual(['core-only']);
    expect(httpMock.mock.calls.map(([path]) => String(path))).not.toContain(
      '/api/plugins/hermes-pwa/sessions/messaging-bindings?profile=default',
    );
  });

  it('archives sessions through the backend patch endpoint with target profile', async () => {
    httpMock.mockResolvedValue({ ok: true });
    await client.sessionUpdate('sess-1', { archived: true, profile: 'dev' });
    expect(httpMock).toHaveBeenCalledWith('/api/sessions/sess-1', {
      method: 'PATCH',
      body: JSON.stringify({ archived: true, profile: 'dev' }),
    });
  });

  it('deletes a session with an optional profile query', async () => {
    httpMock.mockResolvedValue({ ok: true });
    await client.sessionDelete('sess-1', 'dev');
    expect(httpMock).toHaveBeenCalledWith('/api/sessions/sess-1?profile=dev', { method: 'DELETE' });
  });

  it('deletes profiles through the backend endpoint', async () => {
    httpMock.mockResolvedValue({ ok: true });
    await client.profileDelete('research');
    expect(httpMock).toHaveBeenCalledWith('/api/profiles/research', { method: 'DELETE' });
  });

  it('renames profiles through the backend endpoint', async () => {
    httpMock.mockResolvedValue({ ok: true });
    await client.profileRename('research', 'research-v2');
    expect(httpMock).toHaveBeenCalledWith('/api/profiles/research', {
      method: 'PATCH',
      body: JSON.stringify({ new_name: 'research-v2' }),
    });
  });

  it('sets model for a specific profile through the backend endpoint without active-profile query scoping', async () => {
    httpMock.mockResolvedValue({ ok: true, provider: 'anthropic', model: 'claude-sonnet-4' });
    const result = await client.profileUpdateModel('research', { provider: 'anthropic', model: 'claude-sonnet-4' });
    expect(httpMock).toHaveBeenCalledWith('/api/profiles/research/model', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4' }),
      skipProfile: true,
    });
    expect(result).toEqual({ ok: true, provider: 'anthropic', model: 'claude-sonnet-4' });
  });

  it('fetches pending plugin actions for the active profile', async () => {
    client.setActiveProfile('dev');
    httpMock.mockResolvedValue({
      items: [
        {
          id: 'approval-1',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          session_id: 'telegram:123',
          summary: 'rm -rf /tmp/example',
          high_impact: true,
          created_at: 123,
        },
      ],
    });

    const items = await client.pendingActions();

    expect(httpMock).toHaveBeenCalledWith('/api/plugins/hermes-pwa/actions/pending?profile=dev');
    expect(items[0]).toMatchObject({
      id: 'approval-1',
      kind: 'approval',
      sessionId: 'telegram:123',
      summary: 'rm -rf /tmp/example',
    });
  });

  it('maps push status without exposing private key fields', async () => {
    httpMock.mockResolvedValue({
      available: false,
      enabled: false,
      reason: 'missing vapid',
      vapid_public_key: 'public-key',
      vapid_private_key: 'should-not-map',
      subscriptions: [
        {
          id: 'sha256:abc',
          profile: 'default',
          label: 'iPhone',
          user_agent_hint: 'Mobile Safari',
          enabled: true,
          created_at: 1,
          updated_at: 2,
          last_success_at: null,
          last_error: null,
        },
      ],
    });

    const status = await client.pushStatus('default');

    expect(httpMock).toHaveBeenCalledWith('/api/plugins/hermes-pwa/push/status?profile=default');
    expect(status.available).toBe(false);
    expect(status.reason).toBe('missing vapid');
    expect(status.vapidPublicKey).toBe('public-key');
    expect(status.subscriptions[0]).toEqual({
      id: 'sha256:abc',
      profile: 'default',
      label: 'iPhone',
      userAgentHint: 'Mobile Safari',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      lastSuccessAt: null,
      lastError: null,
    });
    expect(JSON.stringify(status)).not.toContain('should-not-map');
  });

  it('pushSubscribe posts body to the active profile by default', async () => {
    client.setActiveProfile('dev');
    httpMock.mockResolvedValue({ subscription: { id: 'sha256:sub', enabled: true, profile: 'dev' } });
    const body = { subscription: { endpoint: 'https://push.example/sub', keys: { p256dh: 'p', auth: 'a' } }, label: 'Android' };

    const result = await client.pushSubscribe(body);

    expect(httpMock).toHaveBeenCalledWith('/api/plugins/hermes-pwa/push/subscribe?profile=dev', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(result).toEqual({ id: 'sha256:sub', enabled: true, profile: 'dev' });
  });

  it('pushUnsubscribe and pushTest post profile-scoped narrow bodies', async () => {
    client.setActiveProfile('dev');
    httpMock.mockResolvedValue({ ok: true });
    await client.pushUnsubscribe({ id: 'sha256:sub' });
    await client.pushTest('sha256:sub');

    expect(httpMock).toHaveBeenNthCalledWith(1, '/api/plugins/hermes-pwa/push/unsubscribe?profile=dev', {
      method: 'POST',
      body: JSON.stringify({ id: 'sha256:sub' }),
    });
    expect(httpMock).toHaveBeenNthCalledWith(2, '/api/plugins/hermes-pwa/push/test?profile=dev', {
      method: 'POST',
      body: JSON.stringify({ id: 'sha256:sub' }),
    });
  });

  it('loads PWA update check status', async () => {
    httpMock.mockResolvedValue({
      ok: true,
      current: '0.1.0',
      latest: '0.1.1',
      source: 'npm',
      update_available: true,
      can_apply: false,
      manual_required: true,
      install_method: 'unknown',
      instructions: [
        {
          id: 'npx-force-reinstall',
          label: 'npm / npx',
          command: 'npx -y hermes-pwa@latest install --force',
          steps: ['Run command'],
        },
      ],
    });

    const result = await client.updateCheck();

    expect(httpMock).toHaveBeenCalledWith('/api/plugins/hermes-pwa/update/check', { skipProfile: true });
    expect(result.updateAvailable).toBe(true);
    expect(result.canApply).toBe(false);
    expect(result.instructions[0]?.command).toBe('npx -y hermes-pwa@latest install --force');
  });

  it('asks about the whole Mac without the selected bot, so another bot\'s older plugin copy never answers', async () => {
    httpMock.mockResolvedValue({});
    await client.obsidianActivity(60);
    await client.obsidianNote('Vault', 'Notes/a.md');
    await client.agentHistory(30);
    await client.opsBackups();
    await client.updateCheck();
    const calls = httpMock.mock.calls.map(([path, init]) => [new URL(String(path), 'https://hermes.test').pathname, init]);
    expect(calls).toEqual([
      ['/api/plugins/hermes-pwa/obsidian/activity', { skipProfile: true }],
      ['/api/plugins/hermes-pwa/obsidian/note', { skipProfile: true }],
      ['/api/plugins/hermes-pwa/agents/history', { skipProfile: true }],
      ['/api/plugins/hermes-pwa/backups', { skipProfile: true }],
      ['/api/plugins/hermes-pwa/update/check', { skipProfile: true }],
    ]);
  });

  it('names the bot to copy when cloning from the default one, and keeps the older field', async () => {
    httpMock.mockResolvedValue({ ok: true, name: 'router' });
    await client.profileCreate({ name: 'router', clone_from_default: true, description: 'Front door' });
    await client.profileCreate({ name: 'blank' });
    const sent = httpMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(sent[0]).toEqual({ name: 'router', clone_from: 'default', clone_from_default: true, description: 'Front door' });
    expect(sent[1]).toEqual({ name: 'blank' });
  });

  it('tries a message on the router without the selected bot', async () => {
    httpMock.mockResolvedValue({ route: 'answer', source: 'jev', confidence: 0.99 });
    const result = await client.routerTry('What is 2+2?');
    expect(httpMock).toHaveBeenCalledWith('/api/plugins/hermes-pwa/router/try', {
      method: 'POST',
      body: JSON.stringify({ message: 'What is 2+2?' }),
      skipProfile: true,
    });
    expect([result.route, result.source]).toEqual(['answer', 'jev']);
  });

  it("reads and saves the router bot's delegation routes through Hermes's own API, for that bot", async () => {
    httpMock.mockResolvedValueOnce({
      configured: 'profile_routes',
      profile_routes: { profiles: [{ name: 'default', description: 'General work.' }], default: 'default' },
    });
    const routes = await client.profileRoutes('router');
    expect(httpMock).toHaveBeenLastCalledWith('/api/delegation/routing?profile=router');
    httpMock.mockResolvedValueOnce({
      ok: true,
      profile_routes: { profiles: [{ name: 'default', description: 'General work.' }, { name: 'claude-cowork-driver', description: 'Drives Claude Cowork.' }], default: 'default' },
    });
    const saved = await client.saveProfileRoutes('router', {
      ...routes,
      profiles: [...routes.profiles, { name: 'claude-cowork-driver', description: 'Drives Claude Cowork.' }, { name: 'manager', description: '' }],
    });
    const [path, init] = httpMock.mock.calls.at(-1)!;
    expect(path).toBe('/api/delegation/backends/profile_routes?profile=router');
    expect(init).toMatchObject({ method: 'PUT' });
    // Hermes replaces the whole block: every route goes back, and an empty line is left out.
    expect(JSON.parse(String(init?.body))).toEqual({
      profiles: [
        { name: 'default', description: 'General work.' },
        { name: 'claude-cowork-driver', description: 'Drives Claude Cowork.' },
        { name: 'manager' },
      ],
      default: 'default',
    });
    expect(saved.profiles.map((route) => route.name)).toEqual(['default', 'claude-cowork-driver']);
    expect(saved.backend).toBe('profile_routes');
  });

  it('uses extended HTTP timeout for audio transcription and speech', async () => {
    httpMock.mockResolvedValueOnce({ text: 'transcript' });
    await client.audioTranscribe('data:audio/webm;base64,AAAA', 'audio/webm');
    expect(httpMock).toHaveBeenNthCalledWith(1, '/api/audio/transcribe', {
      method: 'POST',
      body: JSON.stringify({ data_url: 'data:audio/webm;base64,AAAA', mime_type: 'audio/webm' }),
      timeoutMs: 120_000,
    });

    httpMock.mockResolvedValueOnce({ data_url: 'data:audio/mpeg;base64,BBBB', mime_type: 'audio/mpeg' });
    await client.audioSpeak('hello');
    expect(httpMock).toHaveBeenNthCalledWith(2, '/api/audio/speak', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
      timeoutMs: 120_000,
    });
  });

  it('reads the Mac voices for read-aloud, dropping malformed entries', async () => {
    httpMock.mockResolvedValueOnce({
      available: true,
      default: 'Ava (Premium)',
      voices: [
        { id: 'Ava (Premium)', name: 'Ava', lang: 'en-US', quality: 'premium' },
        { id: 'Samantha', name: 'Samantha', lang: 'en-US', quality: 'odd' },
        { name: 'no id' },
        null,
      ],
    });
    const result = await client.speechVoices();
    expect(httpMock).toHaveBeenCalledWith('/api/plugins/hermes-pwa/speech/voices', { skipProfile: true });
    expect(result).toEqual({
      available: true,
      defaultVoice: 'Ava (Premium)',
      voices: [
        { id: 'Ava (Premium)', name: 'Ava', lang: 'en-US', quality: 'premium' },
        { id: 'Samantha', name: 'Samantha', lang: 'en-US', quality: 'standard' },
      ],
    });
  });

  it('asks the Mac to read one piece of a reply', async () => {
    httpMock.mockResolvedValueOnce({ audio: 'QUFD', mimeType: 'audio/mp4', voice: 'Samantha' });
    const result = await client.speechAudio('Read this.', { voice: 'Samantha', rate: 1.2 });
    expect(httpMock).toHaveBeenCalledWith('/api/plugins/hermes-pwa/speech', {
      method: 'POST',
      body: JSON.stringify({ text: 'Read this.', voice: 'Samantha', rate: 1.2 }),
      timeoutMs: 120_000,
      skipProfile: true,
    });
    expect(result).toEqual({ audio: 'QUFD', mimeType: 'audio/mp4', voice: 'Samantha' });

    httpMock.mockResolvedValueOnce({});
    await expect(client.speechAudio('x')).rejects.toThrow('Speech response did not include audio.');
  });

  it('propagates HermesHttpError', async () => {
    httpMock.mockRejectedValue(new HermesHttpError(500, 'Error', 'boom'));
    await expect(client.status()).rejects.toThrow(HermesHttpError);
  });
});
