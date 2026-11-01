import { useAppState } from '../../app/store';
import { IconWarn } from '../../components/icons';
import { useEditStore } from './editStore';
import { heldAwayNotice, unsentAwayNotice } from './TaskEditor';

/**
 * Values waiting with no editor on screen to say so: held back, or failing to save. Each lasts as long as that does:
 * a successful action elsewhere clears the app's error banner, and the words would then wait in memory with nothing
 * saying they exist.
 */
export function HeldBanner() {
  const { snapshot } = useAppState();
  const { heldAway, unsentAway } = useEditStore();
  const nameOf = (id: string) => snapshot.tasks.find((t) => t.id === id)?.name;
  const banner = (key: string, testId: string, text: string) => (
    <div key={key} className="banner banner-warning" role="alert" data-testid={testId}>
      <IconWarn />
      <span>{text}</span>
    </div>
  );
  return (
    <>
      {[...heldAway].map(([id, held]) => {
        const name = nameOf(id);
        return name === undefined ? null : banner(`held-${id}`, 'held-banner', heldAwayNotice(name, held.fields, held.stashFailed));
      })}
      {[...unsentAway].map(([id, unsent]) => {
        const name = nameOf(id);
        return name === undefined ? null : banner(`unsent-${id}`, 'unsent-banner', unsentAwayNotice(name, unsent.fields, unsent.refused));
      })}
    </>
  );
}
