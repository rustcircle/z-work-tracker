// A date field for the ends of a custom range. It keeps what is typed in the field and passes on only a day a
// range can be made of: a date input reports each partial year as it is typed (0002, 0020, 0202, 2026).
import { useState, type InputHTMLAttributes } from 'react';

import { isRangeDay } from './range';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'onBlur'> & {
  /** The end of the range as it stands. */
  value: string;
  /** Called with each complete day typed or picked. */
  onDay: (day: string) => void;
};

export function DayInput({ value, onDay, ...rest }: Props) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // The field shows what the range has. It follows when the range moves on its own (previous or next period), and
  // when a complete day typed here was passed on but the range reads another there (ends swapped, span cut short).
  if (seen !== value || (isRangeDay(draft) && draft !== value)) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      {...rest}
      type="date"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (isRangeDay(e.target.value)) onDay(e.target.value);
      }}
      // Left half typed, the field goes back to the day the range has.
      onBlur={() => setDraft(value)}
    />
  );
}
