/**
 * Placeholder rows shown while a list or screen loads: the shape of what is
 * coming, instead of the word "Loading". They shimmer unless the person
 * prefers reduced motion (the stylesheet handles that).
 */
export function SkeletonRows({ rows = 4, label = 'Loading', kind = 'list' }: { rows?: number; label?: string; kind?: 'list' | 'chat' | 'cards' }) {
  return (
    <div className={`hm-skeleton hm-skeleton--${kind}`} role="status" aria-live="polite" aria-label={label} data-testid="skeleton">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="hm-skeleton__row" aria-hidden="true">
          {kind === 'list' ? (
            <>
              <span className="hm-skeleton__dot" />
              <span className="hm-skeleton__lines">
                <span className="hm-skeleton__line" style={{ width: `${62 - (index % 3) * 9}%` }} />
                <span className="hm-skeleton__line hm-skeleton__line--short" style={{ width: `${34 + (index % 2) * 12}%` }} />
              </span>
            </>
          ) : kind === 'chat' ? (
            <span className={`hm-skeleton__bubble${index % 2 ? ' hm-skeleton__bubble--user' : ''}`} style={{ width: `${48 + (index % 3) * 14}%` }} />
          ) : (
            <span className="hm-skeleton__card" />
          )}
        </div>
      ))}
    </div>
  );
}
