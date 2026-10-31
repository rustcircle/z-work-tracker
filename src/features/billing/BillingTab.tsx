// The Billing tab: summaries for the user's own guidance, and the quote helper.
import { QuoteHelper } from './QuoteHelper';
import { SummariesCard } from './SummariesCard';
import { UnbilledCard } from './UnbilledCard';
import { GuidanceLabel } from './parts';

export function BillingTab() {
  return (
    <div className="page billing" role="region" aria-label="Billing">
      <div className="page-head">
        <h2>Billing</h2>
      </div>
      <GuidanceLabel />
      <UnbilledCard />
      <SummariesCard />
      <QuoteHelper />
    </div>
  );
}
