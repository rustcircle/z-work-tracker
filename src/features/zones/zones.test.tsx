import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../../app/store';
import { demoState } from '../../mocks/demoSeed';
import { clearMocks } from '@tauri-apps/api/mocks';
import { installMock, type MockState } from '../../mocks/ipcMock';
import { ActiveZoneBar, ZoneDataAttribution, ZonePickerDialog } from './index';

// The map needs canvas and layout, which jsdom lacks; its own behaviour is covered by the pure
// geometry tests and the browser tests in e2e/zones.spec.ts. The stub exposes the props the dialog passes.
vi.mock('./WorldMap', () => ({
  default: (p: { selected: string | null; preview: string | null; onPick: (z: string) => void; onHover: (z: string | null) => void }) => (
    <div data-testid="map-stub" data-selected={p.selected ?? ''} data-preview={p.preview ?? ''}>
      <button type="button" onClick={() => p.onPick('Asia/Tokyo')}>
        stub-click-tokyo
      </button>
      <button type="button" onClick={() => p.onHover('Pacific/Honolulu')}>
        stub-hover-honolulu
      </button>
    </div>
  ),
}));

let state: MockState;

function setup(mutate?: (s: MockState) => void) {
  state = demoState();
  mutate?.(state);
  installMock(state);
}

const settingCalls = () => state.calls.filter((c) => c.cmd === 'set_setting').map((c) => c.args);

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => clearMocks());

function renderBar() {
  return render(
    <AppProvider fallback={() => <p>loading</p>}>
      <ActiveZoneBar />
    </AppProvider>,
  );
}

describe('ActiveZoneBar', () => {
  it('shows the active zone label and which choice is on', async () => {
    setup();
    renderBar();
    const label = await screen.findByTestId('active-zone-label');
    expect(label).toHaveTextContent('Showing Lisbon, WET, UTC+0');
    expect(screen.getByRole('button', { name: 'My time' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Client time' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('switch', { name: 'Show both' })).toHaveAttribute('aria-checked', 'false');
  });

  it('switches to Client time and UTC through the settings API and back to My time with null', async () => {
    setup();
    const user = userEvent.setup();
    renderBar();
    await user.click(await screen.findByRole('button', { name: 'Client time' }));
    await waitFor(() => expect(screen.getByTestId('active-zone-label')).toHaveTextContent('New York, EDT, UTC-4'));
    expect(settingCalls().at(-1)).toEqual({ key: 'activeZone', value: 'America/New_York' });
    expect(screen.getByRole('button', { name: 'Client time' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'UTC' }));
    await waitFor(() => expect(screen.getByTestId('active-zone-label')).toHaveTextContent(/Showing UTC$/));
    expect(settingCalls().at(-1)).toEqual({ key: 'activeZone', value: 'UTC' });

    await user.click(screen.getByRole('button', { name: 'My time' }));
    await waitFor(() => expect(screen.getByTestId('active-zone-label')).toHaveTextContent('Lisbon, WET'));
    expect(settingCalls().at(-1)).toEqual({ key: 'activeZone', value: null });
  });

  it('toggles Show both, and offers it only when a client zone exists', async () => {
    setup();
    const user = userEvent.setup();
    const first = renderBar();
    await user.click(await screen.findByRole('switch', { name: 'Show both' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Show both' })).toHaveAttribute('aria-checked', 'true'));
    expect(settingCalls().at(-1)).toEqual({ key: 'showBoth', value: true });
    first.unmount();
    clearMocks();

    setup((s) => {
      s.settings.clientZone = null;
    });
    renderBar();
    await screen.findByTestId('active-zone-label');
    expect(screen.queryByRole('switch', { name: 'Show both' })).toBeNull();
    const client = screen.getByRole('button', { name: 'Client time' });
    expect(client).toBeDisabled();
    expect(client).toHaveAttribute('title', expect.stringContaining('client zone'));
  });

  it('opens the picker from Other and stores the zone picked there', async () => {
    setup();
    const user = userEvent.setup();
    renderBar();
    await user.click(await screen.findByRole('button', { name: 'Other…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Show times in another zone' });
    await user.click(await within(dialog).findByRole('button', { name: 'stub-click-tokyo' }));
    await waitFor(() => expect(screen.getByTestId('active-zone-label')).toHaveTextContent('Tokyo, JST, UTC+9'));
    expect(settingCalls().at(-1)).toEqual({ key: 'activeZone', value: 'Asia/Tokyo' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Other: Tokyo' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('ZonePickerDialog', () => {
  function renderPicker(value: string | null = 'Europe/Lisbon') {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <AppProvider fallback={() => <p>loading</p>}>
        <ZonePickerDialog open title="Client zone" value={value} onPick={onPick} onClose={onClose} />
      </AppProvider>,
    );
    return { onPick, onClose };
  }

  it('renders nothing while closed', async () => {
    setup();
    render(
      <AppProvider fallback={() => <p>loading</p>}>
        <ZonePickerDialog open={false} title="Client zone" value={null} onPick={() => undefined} onClose={() => undefined} />
        <p>marker</p>
      </AppProvider>,
    );
    await screen.findByText('marker');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists zones with the search focused, the current value chosen, and My and Client tagged', async () => {
    setup();
    renderPicker();
    const dialog = await screen.findByRole('dialog', { name: 'Client zone' });
    const search = within(dialog).getByRole('combobox');
    expect(search).toHaveFocus();
    const options = within(dialog).getAllByRole('option');
    expect(options.length).toBeGreaterThan(380);
    expect(within(dialog).getByRole('option', { selected: true })).toHaveAttribute('data-zone', 'Europe/Lisbon');
    expect(within(dialog).getByRole('option', { name: /Lisbon.*My zone/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /New York.*Client zone/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: /Calcutta/ })).toBeNull();
    expect(await within(dialog).findByTestId('map-stub')).toHaveAttribute('data-selected', 'Europe/Lisbon');
  });

  it('filters by city, zone name and offset as you type', async () => {
    setup();
    const user = userEvent.setup();
    renderPicker();
    const dialog = await screen.findByRole('dialog');
    const search = within(dialog).getByRole('combobox');
    await user.type(search, 'chicago');
    expect(within(dialog).getAllByRole('option').map((o) => o.getAttribute('data-zone'))).toEqual(['America/Chicago']);
    expect(within(dialog).getByText('1 zone match')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'utc+5:45');
    expect(within(dialog).getAllByRole('option').map((o) => o.getAttribute('data-zone'))).toEqual(['Asia/Kathmandu']);
    await user.clear(search);
    await user.type(search, 'qqqqzz');
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0);
    expect(within(dialog).getByText(/No zone matches/)).toBeInTheDocument();
  });

  it('picks with the keyboard alone: type, arrow, enter', async () => {
    setup();
    const user = userEvent.setup();
    const { onPick, onClose } = renderPicker(null);
    const dialog = await screen.findByRole('dialog');
    const search = within(dialog).getByRole('combobox');
    await user.type(search, 'america/n');
    const zonesNow = () => within(dialog).getAllByRole('option').map((o) => o.getAttribute('data-zone'));
    const shown = zonesNow();
    expect(shown.length).toBeGreaterThan(2);
    const activeZone = () => document.getElementById(search.getAttribute('aria-activedescendant') ?? '')?.getAttribute('data-zone');
    expect(activeZone()).toBe(shown[0]);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(activeZone()).toBe(shown[2]);
    await user.keyboard('{ArrowUp}');
    expect(activeZone()).toBe(shown[1]);
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(shown[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picks by clicking an option, and closes from the button and the escape key', async () => {
    setup();
    const user = userEvent.setup();
    const { onPick, onClose } = renderPicker();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('option', { name: /Kathmandu/ }));
    expect(onPick).toHaveBeenCalledWith('Asia/Kathmandu');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('picks what the map reports', async () => {
    setup();
    const user = userEvent.setup();
    const { onPick, onClose } = renderPicker();
    await user.click(await screen.findByRole('button', { name: 'stub-click-tokyo' }));
    expect(onPick).toHaveBeenCalledWith('Asia/Tokyo');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('previews the highlighted list row on the map and keeps the clock-change notice in step', async () => {
    setup();
    const user = userEvent.setup();
    renderPicker();
    const dialog = await screen.findByRole('dialog');
    const stub = await within(dialog).findByTestId('map-stub');
    await user.type(within(dialog).getByRole('combobox'), 'phoenix');
    await waitFor(() => expect(stub).toHaveAttribute('data-preview', 'America/Phoenix'));
    const notices = within(dialog).getByTestId('zone-notices');
    expect(notices).toHaveTextContent('Highlighted · Phoenix');
    expect(notices).toHaveTextContent(/Phoenix, MST, UTC-7/);
    expect(notices).toHaveTextContent('No clock change is scheduled.');
    expect(notices).toHaveTextContent('Lisbon clocks');
  });

  it('shows the gap-change notice for Lisbon and New York, and none for zones without daylight saving', async () => {
    setup();
    const user = userEvent.setup();
    renderPicker('America/New_York');
    const dialog = await screen.findByRole('dialog');
    const notices = within(dialog).getByTestId('zone-notices');
    expect(notices).toHaveTextContent('Now: New York is 4h behind Lisbon');
    expect(notices).toHaveTextContent('different dates');
    expect(notices).toHaveTextContent('New York is 5h behind Lisbon from 29 Mar');

    await user.click(within(dialog).getByRole('button', { name: 'stub-hover-honolulu' }));
    await waitFor(() => expect(notices).toHaveTextContent('Honolulu'));
    // Honolulu never changes clocks, but Lisbon does, so the gap still moves and says so.
    expect(notices).toHaveTextContent('Now: Honolulu is 10h behind Lisbon');
  });
});

describe('ZonePickerDialog without daylight saving on either side', () => {
  it('says the difference stays the same, and raises no clock-change notice for either zone', async () => {
    setup((s) => {
      s.settings.myZone = 'America/Phoenix';
      s.settings.clientZone = null;
      s.settings.activeZone = null;
    });
    render(
      <AppProvider fallback={() => <p>loading</p>}>
        <ZonePickerDialog open title="Client zone" value="Pacific/Honolulu" onPick={() => undefined} onClose={() => undefined} />
      </AppProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    const notices = within(dialog).getByTestId('zone-notices');
    expect(notices).toHaveTextContent('Now: Honolulu is 3h behind Phoenix. It stays the same for the next 12 months.');
    expect(notices).not.toHaveTextContent('different dates');
    expect(within(notices).getAllByText('No clock change is scheduled.')).toHaveLength(2);
  });
});

describe('ZoneDataAttribution', () => {
  it('names the data sources and their stated licences', () => {
    render(<ZoneDataAttribution />);
    const box = screen.getByTestId('zone-data-attribution');
    expect(box).toHaveTextContent('timezone-boundary-builder');
    expect(box).toHaveTextContent('@photostructure/tz-lookup');
    expect(box).toHaveTextContent('CC0 1.0');
    expect(box).toHaveTextContent('Natural Earth');
    expect(box).toHaveTextContent('world-atlas');
    expect(box).toHaveTextContent('ISC');
    expect(box).toHaveTextContent('no network requests');
    expect(box).toHaveTextContent('take no position on borders');
  });
});
