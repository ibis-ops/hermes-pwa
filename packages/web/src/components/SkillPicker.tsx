import { useEffect, useMemo, useState } from 'react';
import { skillCommandSlug, type RestClient, type Skill } from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { SkeletonRows } from './Skeleton';

interface SkillPickerProps {
  rest: RestClient;
  title?: string;
  /** Slug of the skill shown as selected, if any. */
  selected?: string | undefined;
  /** Offer a "None" row (for clearing a default). */
  allowNone?: boolean;
  /**
   * `popover` floats above the composer like the "/" list and dims nothing,
   * so the chat stays in view; `sheet` (the default) is a tall sheet for
   * settings.
   */
  presentation?: 'sheet' | 'popover';
  onPick: (skill: Skill | undefined) => void;
  onClose: () => void;
}

function categoryLabel(category: string | undefined): string {
  if (!category) return 'Other';
  return category
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * The Hermes skills as a grouped, searchable list. Picking one hands back the
 * skill; callers turn it into a `/slug` command.
 */
export function SkillPicker({
  rest,
  title = 'Skills',
  selected,
  allowNone = false,
  presentation = 'sheet',
  onPick,
  onClose,
}: SkillPickerProps) {
  const [skills, setSkills] = useState<Skill[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    rest
      .skillsList()
      .then((list) => {
        if (cancelled) return;
        setSkills(list.filter((skill) => skill.enabled).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error && err.message ? err.message : 'Could not load the skills.');
      });
    return () => {
      cancelled = true;
    };
  }, [rest]);

  // The popover has no sheet around it to take Escape.
  useEffect(() => {
    if (presentation !== 'popover') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [presentation, onClose]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = (skills ?? []).filter(
      (skill) =>
        !needle ||
        skill.name.toLowerCase().includes(needle) ||
        (skill.description ?? '').toLowerCase().includes(needle) ||
        (skill.category ?? '').toLowerCase().includes(needle),
    );
    const byCategory = new Map<string, Skill[]>();
    for (const skill of matching) {
      const label = categoryLabel(skill.category);
      const bucket = byCategory.get(label);
      if (bucket) bucket.push(skill);
      else byCategory.set(label, [skill]);
    }
    return [...byCategory.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  }, [skills, query]);

  const search = (
    <div className="hm-skill-picker__search">
      <Icon name="search" size={16} />
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search skills"
        aria-label="Search skills"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
      />
    </div>
  );

  const results = (
    <>
      {error ? <div className="hm-warning-banner hm-warning-banner--error">{error}</div> : null}
      {skills === undefined && !error ? <SkeletonRows rows={5} label="Loading skills" /> : null}
      {allowNone && !query ? (
        <div className="hm-skill-picker__group">
          <button
            type="button"
            className={`hm-skill-picker__row ${selected ? '' : 'hm-skill-picker__row--selected'}`}
            onClick={() => onPick(undefined)}
            aria-pressed={!selected}
          >
            <span className="hm-skill-picker__body">
              <span className="hm-skill-picker__name">None</span>
              <span className="hm-skill-picker__desc hm-muted">New chats start without a skill.</span>
            </span>
            {!selected ? <Icon name="check" size={16} /> : null}
          </button>
        </div>
      ) : null}
      {skills !== undefined && groups.length === 0 ? <p className="hm-muted hm-skill-picker__empty">No skill matches.</p> : null}
      {groups.map(([label, items]) => (
        <div key={label} className="hm-skill-picker__group">
          <h3 className="hm-skill-picker__heading">{label}</h3>
          {items.map((skill) => {
            const slug = skillCommandSlug(skill.name);
            const isSelected = selected !== undefined && selected === slug;
            return (
              <button
                key={skill.id || skill.name}
                type="button"
                className={`hm-skill-picker__row ${isSelected ? 'hm-skill-picker__row--selected' : ''}`}
                onClick={() => onPick(skill)}
                aria-pressed={isSelected}
                data-testid="skill-row"
              >
                <span className="hm-skill-picker__body">
                  <span className="hm-skill-picker__name">/{slug}</span>
                  {skill.description ? <span className="hm-skill-picker__desc hm-muted">{skill.description}</span> : null}
                </span>
                {isSelected ? <Icon name="check" size={16} /> : null}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );

  if (presentation === 'popover') {
    return (
      <>
        {/* Catches a tap outside to close; clear, so nothing goes dark. */}
        <button type="button" className="hm-skill-popover__catcher" aria-label="Close skills" tabIndex={-1} onClick={onClose} />
        <div className="hm-skill-popover hm-skill-picker" role="dialog" aria-label={title} data-testid="skill-popover">
          <div className="hm-skill-popover__head">
            <span className="hm-skill-popover__title">{title}</span>
            <button type="button" className="hm-skill-popover__done" onClick={onClose}>
              Done
            </button>
          </div>
          <div className="hm-skill-popover__search">{search}</div>
          <div className="hm-skill-popover__list">{results}</div>
        </div>
      </>
    );
  }

  return (
    <BottomSheet title={title} onClose={onClose} className="hm-sheet--skills" contentClassName="hm-skill-picker">
      {search}
      {results}
    </BottomSheet>
  );
}
