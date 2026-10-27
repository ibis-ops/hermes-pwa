import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { Profiles } from './Profiles';
import { useChatStore, useModelStore, useProfilesStore } from '@hermes-pwa/core';

const HOUR = 60 * 60 * 1000;

const makeRest = (overrides = {}) =>
  ({
    profileList: vi.fn().mockResolvedValue([
      { name: 'default', displayName: 'Default', provider: 'anthropic', model: 'claude-opus-4-8', isActive: true },
      { name: 'research', displayName: 'Research', provider: 'openai-codex', model: 'gpt-4o', reasoningEffort: 'high', isActive: false },
    ]),
    profileActive: vi.fn().mockResolvedValue({ active: 'default', current: 'default' }),
    profileActivate: vi.fn().mockResolvedValue(undefined),
    profileCreate: vi.fn().mockResolvedValue({ ok: true, name: 'new-profile' }),
    profileRename: vi.fn().mockResolvedValue(undefined),
    profileDelete: vi.fn().mockResolvedValue(undefined),
    profileUpdateModel: vi.fn().mockResolvedValue({ ok: true, provider: 'kimi-coding', model: 'kimi-k2.6' }),
    modelOptions: vi.fn().mockResolvedValue({
      provider: 'openai-codex',
      model: 'gpt-4o',
      providers: [
        { name: 'OpenAI Codex', slug: 'openai-codex', models: ['gpt-4o', 'gpt-5.5'], authenticated: true },
        { name: 'Kimi / Kimi Coding Plan', slug: 'kimi-coding', models: ['kimi-k2.6', 'kimi-k2-turbo-preview'], authenticated: true },
      ],
    }),
    latestSession: vi.fn(async (bot: string) =>
      bot === 'research'
        ? { id: 'r-1', title: 'Market scan', updatedAt: (Date.now() - HOUR) / 1000, messageCount: 4, profile: 'research' }
        : { id: 'd-1', title: 'Old chat', updatedAt: (Date.now() - 72 * HOUR) / 1000, messageCount: 2, profile: 'default' },
    ),
    botGraph: vi.fn().mockResolvedValue(undefined),
    saveBotGraph: vi.fn(async (map: { nodes: unknown }) => ({ ...map, version: 1 })),
    ...overrides,
  }) as unknown as import('@hermes-pwa/core').RestClient;

async function openDetails(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${name} details` }));
  return screen.findByRole('dialog', { name: name });
}

describe('Profiles (Bots)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    useProfilesStore.setState({ profiles: [], activeName: undefined, currentName: undefined, loading: false, error: undefined });
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined, cacheProfile: undefined });
    useModelStore.setState({ options: undefined, info: undefined, auxiliary: undefined, loading: false, setting: false, error: undefined });
  });

  it('lists bots like Messages: newest chat first, with the current bot marked', async () => {
    render(<Profiles rest={makeRest()} />);
    await waitFor(() => expect(screen.getAllByTestId('bot-row')[0]).toHaveTextContent('Market scan'));
    const [first, second] = screen.getAllByTestId('bot-row');
    expect(first).toHaveTextContent('Research');
    expect(first).toHaveTextContent('gpt-4o · High');
    expect(second).toHaveTextContent('Default');
    expect(second).toHaveTextContent('Current');
    expect(second).toHaveTextContent('Old chat');
  });

  it('tapping a bot makes it the current one and opens its chat', async () => {
    const rest = makeRest();
    const onActivated = vi.fn();
    render(<Profiles rest={rest} onActivated={onActivated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat with Research' }));
    await waitFor(() => expect(onActivated).toHaveBeenCalledTimes(1));
    expect(useProfilesStore.getState().activeName).toBe('research');
  });

  it('tapping the current bot opens its chat without switching', async () => {
    const onActivated = vi.fn();
    render(<Profiles rest={makeRest()} onActivated={onActivated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat with Default, current bot' }));
    await waitFor(() => expect(onActivated).toHaveBeenCalledTimes(1));
    expect(useProfilesStore.getState().activeName).toBe('default');
  });

  it("brings up the other bot's own cached chat at once when opening it", async () => {
    useChatStore.setState({
      sessionId: 'live-default',
      storedSessionId: 'stored-default',
      messages: [{ id: 'm-1', role: 'user', text: 'default profile draft', createdAt: undefined }],
      streaming: true,
      error: undefined,
      cacheProfile: 'default',
    });
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:research',
      JSON.stringify({
        profile: 'research',
        sessionId: 'live-research',
        storedSessionId: 'stored-research',
        messages: [{ id: 'm-2', role: 'user', text: 'old research chat' }],
        streaming: false,
      }),
    );

    render(<Profiles rest={makeRest()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat with Research' }));

    await waitFor(() => expect(useProfilesStore.getState().activeName).toBe('research'));
    expect(useChatStore.getState()).toMatchObject({
      sessionId: 'live-research',
      storedSessionId: 'stored-research',
      streaming: false,
      cacheProfile: 'research',
    });
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['old research chat']);
  });

  it('creates a bot', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New bot' }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. research'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByText('Create bot'));
    await waitFor(() => expect(rest.profileCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'ops', clone_from_default: true })));
  });

  it('renames a bot from its card', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    const card = await openDetails('Research');
    fireEvent.change(within(card).getByLabelText('Bot name'), { target: { value: 'research-v2' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(rest.profileRename).toHaveBeenCalledWith('research', 'research-v2'));
  });

  it('refuses a name that is taken or malformed', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    const card = await openDetails('Research');
    fireEvent.change(within(card).getByLabelText('Bot name'), { target: { value: 'default' } });
    expect(within(card).getByText('Another bot already has that name.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Rename' })).toBeDisabled();
    fireEvent.change(within(card).getByLabelText('Bot name'), { target: { value: 'Bad Name' } });
    expect(within(card).getByText('Use lowercase letters, numbers, - and _ only.')).toBeInTheDocument();
  });

  it('keeps the default bot and the current one from being renamed or deleted', async () => {
    render(<Profiles rest={makeRest()} />);
    const card = await openDetails('Default');
    expect(within(card).getByText('The default bot cannot be renamed or deleted.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Delete bot' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Rename' })).toBeNull();
  });

  it('deletes a bot only after a second question', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    const card = await openDetails('Research');
    fireEvent.click(within(card).getByRole('button', { name: 'Delete bot' }));
    expect(within(card).getByTestId('bot-delete-confirm')).toBeInTheDocument();
    expect(rest.profileDelete).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Delete bot' }));
    await waitFor(() => expect(rest.profileDelete).toHaveBeenCalledWith('research'));
  });

  it('saves model settings from the card', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    const card = await openDetails('Research');
    await waitFor(() => expect(within(card).getByRole('combobox', { name: 'Provider' })).not.toBeDisabled());
    fireEvent.change(within(card).getByRole('combobox', { name: 'Provider' }), { target: { value: 'kimi-coding' } });
    fireEvent.change(within(card).getByRole('combobox', { name: 'Model' }), { target: { value: 'kimi-k2.6' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save model' }));
    await waitFor(() =>
      expect(rest.profileUpdateModel).toHaveBeenCalledWith('research', {
        provider: 'kimi-coding',
        model: 'kimi-k2.6',
        reasoning_effort: 'high',
        show_reasoning: false,
      }),
    );
  });

  it('opens the chat from the card with Message', async () => {
    const onActivated = vi.fn();
    render(<Profiles rest={makeRest()} onActivated={onActivated} />);
    const card = await openDetails('Research');
    fireEvent.click(within(card).getByRole('button', { name: 'Message' }));
    await waitFor(() => expect(onActivated).toHaveBeenCalledTimes(1));
    expect(useProfilesStore.getState().activeName).toBe('research');
  });

  it('shows the team map in the Team view, starting with the manager-on-top map', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    await screen.findAllByTestId('bot-row');
    fireEvent.click(screen.getByRole('radio', { name: 'Team' }));
    expect(await screen.findByTestId('team-starting')).toHaveTextContent('Default on top');
    fireEvent.click(screen.getByRole('button', { name: 'Use this map' }));
    await waitFor(() =>
      expect(rest.saveBotGraph).toHaveBeenCalledWith({
        nodes: {
          default: { reportsTo: null, canMessage: ['research'], role: '' },
          research: { reportsTo: 'default', canMessage: ['default'], role: '' },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('team-starting')).toBeNull());
  });

  it('offers a retry when no bots come back', async () => {
    render(<Profiles rest={makeRest({ profileList: vi.fn().mockResolvedValue([]) })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument());
  });
});
