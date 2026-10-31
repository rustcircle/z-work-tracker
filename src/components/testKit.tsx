// Shared setup for component tests: DOM gaps in jsdom and an app booted on the IPC mock.
import { render } from '@testing-library/react';

import App from '../App';
import { installMock, type MockState } from '../mocks/ipcMock';

/** jsdom has no layout, which ProseMirror asks for when it scrolls the selection into view. */
export function polyfillDom(): void {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
}

export function boot(state: MockState) {
  installMock(state);
  return render(<App />);
}
