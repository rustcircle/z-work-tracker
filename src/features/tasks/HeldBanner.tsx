import { useAppState } from '../../app/store';
import { IconWarn } from '../../components/icons';
import { useEditStore } from './editStore';
import { heldAwayNotice } from './TaskEditor';

/**
 * Values held back with no editor on screen to say so. It lasts as long as that does: a successful action elsewhere
 * clears the app's error banner, and the words would then wait in memory with nothing saying they exist.
 */
export function HeldBanner() {
  const { snapshot } = useAppState();
  const { heldAway } = useEditStore();
  return (
    <>
      {[...heldAway].map(([id, fields]) => {
        const task = snapshot.tasks.find((t) => t.id === id);
        return task ? (
          <div key={id} className="banner banner-warning" role="alert" data-testid="held-banner">
            <IconWarn />
            <span>{heldAwayNotice(task.name, fields)}</span>
          </div>
        ) : null;
      })}
    </>
  );
}
