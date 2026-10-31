import { AppProvider } from './app/store';
import { AnalysisTab } from './features/analysis/AnalysisTab';
import { ActiveZoneBar } from './features/zones';

// Placeholder shell, replaced by the shell feature.
export default function App() {
  return (
    <AppProvider fallback={(e) => <p>{e ?? 'Loading'}</p>}>
      <ActiveZoneBar />
      <AnalysisTab />
    </AppProvider>
  );
}
