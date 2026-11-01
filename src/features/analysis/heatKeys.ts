// Keyboard movement over the two heatmaps. The cells are one roving tab stop: arrows move, Home and End jump,
// Enter or Space drills down. These return the cell to move to, or null when the key does nothing here.

/** Weekday by hour grid: rows are weekdays, columns are hours 0 to 23. */
export function hourCellMove(key: string, ctrl: boolean, row: number, hour: number, rows: number): { row: number; hour: number } | null {
  const clamp = (n: number, max: number): number => Math.max(0, Math.min(max, n));
  switch (key) {
    case 'ArrowLeft':
      return hour > 0 ? { row, hour: hour - 1 } : null;
    case 'ArrowRight':
      return hour < 23 ? { row, hour: hour + 1 } : null;
    case 'ArrowUp':
      return row > 0 ? { row: row - 1, hour } : null;
    case 'ArrowDown':
      return row < rows - 1 ? { row: row + 1, hour } : null;
    case 'Home':
      return ctrl ? { row: 0, hour: 0 } : { row, hour: 0 };
    case 'End':
      return ctrl ? { row: rows - 1, hour: 23 } : { row, hour: 23 };
    case 'PageUp':
      return { row: 0, hour: clamp(hour, 23) };
    case 'PageDown':
      return { row: rows - 1, hour: clamp(hour, 23) };
    default:
      return null;
  }
}

/**
 * Calendar of days laid out in week columns: Up and Down are the previous and next day, Left and Right the same
 * weekday a week earlier or later, Home and End the first and the last day shown.
 */
export function dayCellMove(key: string, index: number, count: number): number | null {
  const to = (n: number): number | null => (n >= 0 && n < count ? n : null);
  switch (key) {
    case 'ArrowUp':
      return to(index - 1);
    case 'ArrowDown':
      return to(index + 1);
    case 'ArrowLeft':
      return to(index - 7);
    case 'ArrowRight':
      return to(index + 7);
    case 'Home':
      return count > 0 ? 0 : null;
    case 'End':
      return count > 0 ? count - 1 : null;
    default:
      return null;
  }
}

export const isActivateKey = (key: string): boolean => key === 'Enter' || key === ' ';
