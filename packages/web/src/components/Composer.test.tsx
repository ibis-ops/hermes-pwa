import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RpcClient } from '@hermes-pwa/core';
import { Composer } from './Composer';
import {
  MAX_ATTACHMENTS_PER_SELECTION,
  MAX_ATTACHMENT_BYTES,
  attachmentTooLargeMessage,
  unsupportedAttachmentTypeMessage,
} from './attachmentLimits';

function makeRpc(result: unknown): RpcClient {
  return {
    request: vi.fn().mockResolvedValue(result),
    onFrame: vi.fn(),
    events: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    },
    disconnect: vi.fn(),
    lastSeq: () => 0,
    replayEvent: vi.fn(),
    replayEpoch: () => undefined,
    onServerRequest: () => () => undefined,
    respond: vi.fn(),
    respondError: vi.fn(),
    replayServerRequests: vi.fn(),
  };
}

function makeSizedFile(name: string, size: number): File {
  const file = new File(['x'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

describe('Composer', () => {
  it('renders input and send button', () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} />);
    expect(screen.getByPlaceholderText(/Message Hermes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send/i })).toBeInTheDocument();
  });

  it('calls onSend with trimmed text', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onStop={vi.fn()} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText(/Message Hermes/i), { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('does not send when input is empty', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onStop={vi.fn()} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows stop button when busy', () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} busy={true} />);
    expect(screen.getByRole('button', { name: /Stop/i })).toBeInTheDocument();
  });

  it('calls onStop when stop clicked', () => {
    const onStop = vi.fn();
    render(<Composer onSend={vi.fn()} onStop={onStop} busy={true} />);
    fireEvent.click(screen.getByRole('button', { name: /Stop/i }));
    expect(onStop).toHaveBeenCalled();
  });

  it('submits on enter via form', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onStop={vi.fn()} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText(/Message Hermes/i), { target: { value: 'test' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message Hermes/i).closest('form')!);
    expect(onSend).toHaveBeenCalledWith('test');
  });

  it('shows slash command catalog when typing / and inserts a selected command', async () => {
    const rpc = makeRpc({
      categories: [
        { name: 'Session', pairs: [['/new', 'Start a fresh session']] },
        { name: 'Info', pairs: [['/status', 'Show session status'], ['/whoami', 'Show access']] },
      ],
    });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onStop={vi.fn()} busy={false} slashCommandsRpc={rpc} />);

    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: '/' } });

    expect(await screen.findByRole('listbox', { name: /slash commands/i })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /\/new/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /\/whoami/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /\/status/i }));

    const input = screen.getByLabelText('Message input');
    expect(input).toHaveValue('/status ');
    expect(screen.queryByRole('listbox', { name: /slash commands/i })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('/status');
    expect(rpc.request).toHaveBeenCalledWith('commands.catalog');
  });

  it('filters slash completions and lets keyboard selection populate the composer', async () => {
    const rpc = makeRpc({
      items: [
        { text: '/model', display: '/model', meta: 'Show or change model', group: 'Commands' },
        { text: '/whoami', display: '/whoami', meta: 'Show access', group: 'Commands' },
        { text: '/memory', display: '/memory', meta: 'Memory status', group: 'Commands' },
      ],
    });
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} slashCommandsRpc={rpc} />);

    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: '/m' } });
    await waitFor(() => expect(rpc.request).toHaveBeenCalledWith('complete.slash', { text: '/m' }));
    await screen.findByRole('option', { name: /\/model/i });
    expect(screen.queryByRole('option', { name: /\/whoami/i })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input).toHaveValue('/memory ');
  });

  it('primes backend voice audio when voice mode is turned on from the plus menu', () => {
    const onPrimeVoiceAudio = vi.fn();
    const onStopVoiceAudio = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        onStop={vi.fn()}
        busy={false}
        onTranscribeAudio={vi.fn(async () => '')}
        onPrimeVoiceAudio={onPrimeVoiceAudio}
        onStopVoiceAudio={onStopVoiceAudio}
      />,
    );
    onPrimeVoiceAudio.mockClear();
    onStopVoiceAudio.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Turn on voice mode/i }));
    expect(onPrimeVoiceAudio).toHaveBeenCalledTimes(1);
    expect(onStopVoiceAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Turn off voice mode/i }));
    expect(onStopVoiceAudio).toHaveBeenCalled();
  });

  it('shows the mic while empty and the send arrow once there is text', () => {
    render(<Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} onTranscribeAudio={vi.fn(async () => '')} />);
    expect(screen.getByRole('button', { name: /Record voice/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send message/i })).toBeNull();
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: /Send message/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record voice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /voice mode/i })).toBeNull();
  });

  it('keeps the draft for the bot across a remount and clears it on send', () => {
    localStorage.clear();
    const onSend = vi.fn();
    const { unmount } = render(<Composer onSend={onSend} onStop={vi.fn()} busy={false} draftKey="research" />);
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'half typed' } });
    fireEvent(window, new Event('pagehide'));
    unmount();

    render(<Composer onSend={onSend} onStop={vi.fn()} busy={false} draftKey="research" />);
    const input = screen.getByLabelText('Message input');
    expect(input).toHaveValue('half typed');
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }));
    expect(onSend).toHaveBeenCalledWith('half typed');
    expect(localStorage.getItem('hermes-pwa.draft.v1:research')).toBeNull();
  });

  it('lets Return insert a line break on a touch keyboard', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const onSend = vi.fn();
      render(<Composer onSend={onSend} onStop={vi.fn()} busy={false} />);
      const input = screen.getByLabelText('Message input');
      expect(input).toHaveAttribute('enterkeyhint', 'enter');
      fireEvent.change(input, { target: { value: 'line one' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /Send message/i }));
      expect(onSend).toHaveBeenCalledWith('line one');
    } finally {
      window.matchMedia = original;
    }
  });

  it('shows only the native file picker action in the attachment menu', () => {
    const { container } = render(
      <Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} onUploadFile={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));

    expect(screen.getByRole('menuitem', { name: /File/i })).toBeInTheDocument();
    expect(screen.queryByText(/Take photo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Photo or video/i)).not.toBeInTheDocument();

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('multiple');
    expect(input).not.toHaveAttribute('accept');
    expect(input).not.toHaveAttribute('capture');
  });

  it('uploads a selected file and submits the returned file reference', async () => {
    const onSend = vi.fn();
    const onUploadFile = vi.fn(async () => ({ path: '.hermes/desktop-attachments/note.txt' }));
    const { container } = render(
      <Composer onSend={onSend} onStop={vi.fn()} busy={false} onUploadFile={onUploadFile} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onUploadFile).toHaveBeenCalledWith(file));
    await waitFor(() => expect(screen.getByText('note.txt')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    expect(onSend).toHaveBeenCalledWith('@file:.hermes/desktop-attachments/note.txt');
  });

  it('rejects oversized files before upload', async () => {
    const onUploadFile = vi.fn(async () => ({ path: '.hermes/desktop-attachments/huge.csv' }));
    const { container } = render(
      <Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} onUploadFile={onUploadFile} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    const input = container.querySelector('input[type="file"]')!;
    const file = makeSizedFile('huge.csv', MAX_ATTACHMENT_BYTES + 1);
    fireEvent.change(input, { target: { files: [file] } });

    expect(onUploadFile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(attachmentTooLargeMessage('huge.csv'))).toBeInTheDocument());
  });

  it('rejects unsupported MIME types before upload', async () => {
    const onUploadFile = vi.fn(async () => ({ path: '.hermes/desktop-attachments/malware.exe' }));
    const { container } = render(
      <Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} onUploadFile={onUploadFile} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(['MZ'], 'malware.exe', { type: 'application/x-msdownload' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onUploadFile).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByLabelText(unsupportedAttachmentTypeMessage('malware.exe', 'application/x-msdownload'))).toBeInTheDocument(),
    );
  });

  it('limits each file selection to five uploads', async () => {
    const onUploadFile = vi.fn(async (file: File) => ({ path: `.hermes/desktop-attachments/${file.name}` }));
    const { container } = render(
      <Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} onUploadFile={onUploadFile} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    const input = container.querySelector('input[type="file"]')!;
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_SELECTION + 1 }, (_, index) =>
      makeSizedFile(`note-${index + 1}.txt`, 1),
    );
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(MAX_ATTACHMENTS_PER_SELECTION));
    expect(onUploadFile.mock.calls.map(([file]) => (file as File).name)).toEqual([
      'note-1.txt',
      'note-2.txt',
      'note-3.txt',
      'note-4.txt',
      'note-5.txt',
    ]);
    expect(screen.getByLabelText(`Only ${MAX_ATTACHMENTS_PER_SELECTION} files can be attached at once.`)).toBeInTheDocument();
  });

  it('reports composer layout changes only when textarea height changes', async () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.value.length > 20 ? 54 : 36;
      },
    });
    const onLayoutChange = vi.fn();
    const { unmount } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} busy={false} onLayoutChange={onLayoutChange} />);
    try {
      await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
      const input = screen.getByLabelText('Message input');

      fireEvent.change(input, { target: { value: 'short text' } });
      expect(input).toHaveStyle({ height: '36px' });
      expect(onLayoutChange).toHaveBeenCalledTimes(1);

      fireEvent.change(input, { target: { value: 'this text is long enough to wrap' } });
      await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(2));
      expect(input).toHaveStyle({ height: '54px' });
    } finally {
      unmount();
      if (originalScrollHeight) {
        Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', originalScrollHeight);
      } else {
        delete (HTMLTextAreaElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
      }
    }
  });
});
