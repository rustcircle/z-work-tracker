import { useReadOnly } from '../../app/useReadOnly';
import './readOnly.css';

/**
 * Why the controls of a section are switched off, in the words of the backend's refusal. Nothing while this computer may
 * change data. The backend refuses a change either way; this only lets the page say so before the click.
 */
export function ReadOnlyNote() {
  const { readOnly, why } = useReadOnly();
  if (!readOnly || why === null) return null;
  return (
    <p className="field-hint" role="status" data-testid="read-only-note">
      {why}
    </p>
  );
}
