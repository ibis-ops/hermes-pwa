import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Clarify } from '@hermes-pwa/core';
import { ClarifyCard } from './ClarifyCard';

describe('ClarifyCard (batch)', () => {
  const item: Clarify = {
    id: 'srq-3',
    kind: 'clarify',
    status: 'needs_you',
    title: '2 questions',
    question: 'Which vault?',
    createdAt: Date.now(),
    serverRequestId: 'srq-3',
    questions: [
      { qid: 'q1', question: 'Which vault?', choices: ['General', 'Work'], multiSelect: false },
      { qid: 'q2', question: 'Tags?', choices: ['client', 'ops'], multiSelect: true },
    ],
  };

  it('collects a choice per question, multi-select where allowed, plus typed answers', () => {
    const onRespond = vi.fn();
    render(<ClarifyCard item={item} onRespond={onRespond} />);
    expect(screen.getAllByTestId('clarify-question')).toHaveLength(2);
    const send = screen.getByRole('button', { name: 'Send answers' });
    expect(send).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(send).toHaveTextContent('Send 1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'client' }));
    fireEvent.click(screen.getByRole('button', { name: 'ops' }));
    fireEvent.change(screen.getByLabelText('Other answer: Tags?'), { target: { value: 'molecular' } });
    expect(send).toHaveTextContent('Send');
    fireEvent.click(send);
    expect(onRespond).toHaveBeenCalledWith('srq-3', { q1: 'General', q2: ['client', 'ops', 'molecular'] });
  });

  it('keeps the single-answer form for legacy clarify events', () => {
    const onRespond = vi.fn();
    const { questions: _questions, serverRequestId: _serverRequestId, ...legacy } = item;
    void _questions;
    void _serverRequestId;
    render(<ClarifyCard item={legacy} onRespond={onRespond} />);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'General' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onRespond).toHaveBeenCalledWith('srq-3', 'General');
  });
});
