import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Profiles } from './Profiles';
import { useChatStore, useModelStore, useProfilesStore } from '@hermes-pwa/core';

const makeRest = (overrides = {}) =>
  ({
    profileList: vi.fn().mockResolvedValue([
      { name: 'default', displayName: 'Default', provider: 'anthropic', model: 'claude-opus-4-8', isActive: true },
      { name: 'research', displayName: 'Research', provider: 'openai-codex', model: 'gpt-4o', isActive: false },
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
    ...overrides,
  }) as unknown as import('@hermes-pwa/core').RestClient;

describe('Profiles', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProfilesStore.setState({ profiles: [], activeName: undefined, currentName: undefined, loading: false, error: undefined });
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined, cacheProfile: undefined });
    useModelStore.setState({ options: undefined, info: undefined, auxiliary: undefined, loading: false, setting: false, error: undefined });
  });

  it('renders profiles and marks active', async () => {
    render(<Profiles rest={makeRest()} />);
    await waitFor(() => expect(screen.getByText('Default', { selector: '.hm-agent-card__name' })).toBeInTheDocument());
    expect(screen.getByText('Research', { selector: '.hm-agent-card__name' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('keeps the new profile action above the profile list', async () => {
    const { container } = render(<Profiles rest={makeRest()} />);
    await waitFor(() => expect(screen.getByText('Default', { selector: '.hm-agent-card__name' })).toBeInTheDocument());
    const newProfile = screen.getByRole('button', { name: /New bot/i });
    const firstCard = container.querySelector('[data-testid="agent-card"]');
    expect(firstCard).toBeTruthy();
    expect(Boolean(newProfile.compareDocumentPosition(firstCard!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('activates a profile', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    await waitFor(() => expect(screen.getByText('Research')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Activate research/i }));
    await waitFor(() => expect(useProfilesStore.getState().activeName).toBe('research'));
    expect(rest.profileActivate).not.toHaveBeenCalled();
  });

  it('starts a fresh chat draft when activating a different profile', async () => {
    const rest = makeRest();
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

    render(<Profiles rest={rest} />);
    await waitFor(() => expect(screen.getByText('Research')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Activate research/i }));

    await waitFor(() => expect(useProfilesStore.getState().activeName).toBe('research'));
    expect(useChatStore.getState()).toMatchObject({
      sessionId: undefined,
      storedSessionId: undefined,
      messages: [],
      streaming: false,
      error: undefined,
      cacheProfile: 'research',
    });
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:research')).toBeNull();
  });

  it('creates a profile', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    await waitFor(() => expect(screen.getByText('New bot')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /New bot/i }));
    await waitFor(() => expect(screen.getByText('Create bot')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('e.g. research'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByText('Create bot'));
    await waitFor(() =>
      expect(rest.profileCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ops', clone_from_default: true }),
      ),
    );
  });

  it('renames a non-active profile after prompt validation', async () => {
    const rest = makeRest();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('research-v2');
    render(<Profiles rest={rest} />);
    await waitFor(() => expect(screen.getByText('Research')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Rename profile research/i }));

    await waitFor(() => expect(rest.profileRename).toHaveBeenCalledWith('research', 'research-v2'));
    prompt.mockRestore();
  });

  it('deletes a non-active profile after confirmation and protects default', async () => {
    const rest = makeRest();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Profiles rest={rest} />);
    await waitFor(() => expect(screen.getByText('Research')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /Delete profile default/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Delete profile research/i }));

    await waitFor(() => expect(rest.profileDelete).toHaveBeenCalledWith('research'));
    confirm.mockRestore();
  });

  it('opens a profile model picker and saves the selected provider/model for that profile', async () => {
    const rest = makeRest();
    render(<Profiles rest={rest} />);
    await waitFor(() => expect(screen.getByText('Research')).toBeInTheDocument());
    await waitFor(() => expect(rest.modelOptions).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Change model for profile research/i }));
    await waitFor(() => expect(screen.getByText('Model for Research')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'kimi-coding' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'kimi-k2.6' } });
    fireEvent.click(screen.getByRole('button', { name: /Save model/i }));

    await waitFor(() => expect(rest.profileUpdateModel).toHaveBeenCalledWith('research', {
      provider: 'kimi-coding',
      model: 'kimi-k2.6',
      reasoning_effort: 'high',
      show_reasoning: false,
    }));
  });

  it('shows empty message', async () => {
    const rest = makeRest({ profileList: vi.fn().mockResolvedValue([]) });
    render(<Profiles rest={rest} />);
    await waitFor(() => expect(screen.getByText(/Reload profiles/i)).toBeInTheDocument());
  });
});
