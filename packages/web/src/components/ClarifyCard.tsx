import { useState } from 'react';
import type { Clarify, ClarifyQuestion } from '@hermes-pwa/core';

interface ClarifyCardProps {
  item: Clarify;
  /** Legacy single answer, or one answer per question id (`null` = skipped) for a batch. */
  onRespond(id: string, answer: string | Record<string, string | string[] | null>): void;
}

type Draft = { picked: string[]; text: string };

function answerFor(question: ClarifyQuestion, draft: Draft): string | string[] | null {
  const text = draft.text.trim();
  if (question.multiSelect) {
    const all = [...draft.picked, ...(text ? [text] : [])];
    return all.length ? all : null;
  }
  if (text) return text;
  return draft.picked[0] ?? null;
}

function QuestionBlock({
  question,
  draft,
  onChange,
}: {
  question: ClarifyQuestion;
  draft: Draft;
  onChange: (next: Draft) => void;
}) {
  const toggle = (choice: string) => {
    if (question.multiSelect) {
      const picked = draft.picked.includes(choice) ? draft.picked.filter((c) => c !== choice) : [...draft.picked, choice];
      onChange({ ...draft, picked });
    } else {
      onChange({ ...draft, picked: draft.picked[0] === choice ? [] : [choice] });
    }
  };
  return (
    <div className="hm-clarify-q" data-testid="clarify-question">
      <p className="hm-clarify-question">{question.question}</p>
      {question.choices.length > 0 ? (
        <div className="hm-clarify-choices" role="group" aria-label={question.question}>
          {question.choices.map((choice) => {
            const selected = draft.picked.includes(choice);
            return (
              <button
                key={choice}
                type="button"
                className={`hm-filter-chip${selected ? ' hm-filter-chip--active' : ''}`}
                aria-pressed={selected}
                onClick={() => toggle(choice)}
              >
                {choice}
              </button>
            );
          })}
        </div>
      ) : null}
      <input
        aria-label={question.choices.length ? `Other answer: ${question.question}` : `Your answer: ${question.question}`}
        placeholder={question.choices.length ? 'Or type your own…' : 'Type your answer…'}
        value={draft.text}
        onChange={(e) => onChange({ ...draft, text: e.target.value })}
        className="hm-input"
      />
    </div>
  );
}

export function ClarifyCard({ item, onRespond }: ClarifyCardProps) {
  const questions = item.questions ?? [];
  const batch = questions.length > 0;
  const [answer, setAnswer] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(questions.map((q) => [q.qid, { picked: [], text: '' }])),
  );

  const batchAnswers = Object.fromEntries(
    questions.map((q) => [q.qid, answerFor(q, drafts[q.qid] ?? { picked: [], text: '' })]),
  ) as Record<string, string | string[] | null>;
  const answeredCount = Object.values(batchAnswers).filter((value) => value !== null).length;

  return (
    <div className="hm-card" data-testid="clarify-card">
      <div className="hm-card__header">
        <span className="hm-badge hm-badge--info">Clarification</span>
      </div>
      <h3 className="hm-card__title">{item.title}</h3>
      {batch ? (
        <div className="hm-clarify-form hm-clarify-form--batch">
          {questions.map((q) => (
            <QuestionBlock
              key={q.qid}
              question={q}
              draft={drafts[q.qid] ?? { picked: [], text: '' }}
              onChange={(next) => setDrafts((current) => ({ ...current, [q.qid]: next }))}
            />
          ))}
          <button
            className="hm-primary"
            disabled={answeredCount === 0}
            onClick={() => onRespond(item.id, batchAnswers)}
            aria-label="Send answers"
          >
            {questions.length > 1 && answeredCount < questions.length ? `Send ${answeredCount} of ${questions.length}` : 'Send'}
          </button>
        </div>
      ) : (
        <>
          <p className="hm-clarify-question">{item.question}</p>
          <div className="hm-clarify-form">
            <input
              aria-label="Your answer"
              placeholder="Type your answer…"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              className="hm-input"
            />
            <button
              className="hm-primary"
              disabled={answer.trim().length === 0}
              onClick={() => onRespond(item.id, answer.trim())}
              aria-label="Send answer"
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
