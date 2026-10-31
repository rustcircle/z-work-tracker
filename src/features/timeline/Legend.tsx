// What the marks on the day axes mean. Every kind has a pattern and a word; colour is the project's.
import { KIND_WORD, MARK_WORD } from './Axis';
import type { SegKind } from './model';

const KINDS: readonly { kind: SegKind; word: string; text: string }[] = [
  { kind: 'work', word: 'Work', text: 'worked time, in Exact and Billable' },
  { kind: 'thinking', word: KIND_WORD.thinking, text: 'away time you marked as thinking, in Exact and Billable' },
  { kind: 'billablePause', word: KIND_WORD.billablePause, text: 'billed but not worked, in Billable only' },
  { kind: 'pending', word: KIND_WORD.pending, text: 'time away not counted until you confirm' },
  { kind: 'dropped', word: KIND_WORD.dropped, text: 'time away removed from your time' },
];

export function Legend() {
  return (
    <section className="legend" aria-label="Legend" data-testid="timeline-legend">
      <ul>
        {KINDS.map((k) => (
          <li key={k.kind}>
            <span className={`legend-swatch k-${k.kind}`} aria-hidden="true" />
            <span>
              <strong>{k.word}</strong>: {k.text}
            </span>
          </li>
        ))}
        <li>
          <span className="legend-flag" aria-hidden="true">✎</span>
          <span>
            <strong>{MARK_WORD.corrected}</strong>: the recorded time was changed; the raw time is shown beside it
          </span>
        </li>
        <li>
          <span className="legend-flag" aria-hidden="true">+</span>
          <span>
            <strong>{MARK_WORD.manual}</strong>: time entered by hand, with its reason
          </span>
        </li>
      </ul>
    </section>
  );
}
