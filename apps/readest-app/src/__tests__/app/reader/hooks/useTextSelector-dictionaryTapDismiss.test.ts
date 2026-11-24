// @vitest-environment happy-dom
import { bookDataStoreHooks } from '@/__tests__/helpers/book-data-store-mock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

// With the dictionary popup up, a touch tap on the page only closes it. The
// instant dictionary drops the selection as it opens, so the popup is all that
// marks the tap; a lookup from the toolbar keeps the selection.

const h = vi.hoisted(() => ({
  view: { deselect: vi.fn(), getCFI: vi.fn(() => 'cfi'), renderer: { containerPosition: 0 } },
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { isAndroidApp: true, isMobile: true } }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => h.view,
    getViewSettings: () => ({ scrolled: false }),
    getProgress: () => null,
  }),
}));
vi.mock('@/store/bookDataStore', () => ({
  ...bookDataStoreHooks(() => ({ getBookData: () => ({ isFixedLayout: false }) })),
}));
vi.mock('@/utils/event', () => ({
  eventDispatcher: { onSync: vi.fn(), offSync: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('@/utils/misc', async (importActual) => {
  const actual = await importActual<typeof import('@/utils/misc')>();
  return { ...actual, getOSPlatform: () => 'android' };
});

import { useTextSelector } from '@/app/reader/hooks/useTextSelector';
import { eventDispatcher } from '@/utils/event';

type Hook = { current: ReturnType<typeof useTextSelector> };

const setup = () => {
  const hook: { current?: ReturnType<typeof useTextSelector> } = {};
  // The Annotator closes the popup, which reports back through handleShowPopup.
  const handleDismissPopup = vi.fn(() => hook.current?.handleShowPopup(false));
  const noop = vi.fn();
  const { result } = renderHook(() =>
    useTextSelector(
      'book-1',
      { top: 0, right: 0, bottom: 0, left: 0 },
      noop,
      noop,
      noop,
      vi.fn(async () => ''),
      handleDismissPopup,
    ),
  );
  hook.current = result.current;
  const singleClick = vi
    .mocked(eventDispatcher.onSync)
    .mock.calls.filter(([type]) => type === 'iframe-single-click')
    .at(-1)?.[1] as () => boolean;
  return { result, handleDismissPopup, singleClick };
};

const showDictionary = (result: Hook, keepSelection: boolean) => {
  if (keepSelection) {
    const node = document.createTextNode('Hello world');
    document.body.appendChild(node);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    Object.assign(range, { getClientRects: () => [{ left: 40, right: 60, top: 45, bottom: 55 }] });
    document.getSelection()!.addRange(range);
  }
  result.current.isTextSelected.current = keepSelection;
  result.current.handleShowPopup(true);
};

// A touch tap at a page edge, (5, 500), through its single click. The webview
// clears a kept selection with the tap. Returns whether the click was consumed
// (true) or left to turn the page (false).
const tap = async (result: Hook, singleClick: () => boolean) => {
  const ev = { pointerType: 'touch', button: 0, clientX: 5, clientY: 500 } as PointerEvent;
  result.current.handlePointerDown(document, 0, ev);
  result.current.handleTouchStart();
  await result.current.handlePointerUp(document, 0, ev);
  result.current.handleTouchEnd(document, 0);
  if (document.getSelection()!.rangeCount) {
    document.getSelection()!.removeAllRanges();
    result.current.handleSelectionchange(document, 0);
  }
  return singleClick();
};

beforeEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.mocked(eventDispatcher.onSync).mockClear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe.each([
  ['the instant dictionary', false],
  ['a lookup that keeps the selection', true],
] as const)('a touch tap outside %s', (_, keepSelection) => {
  test('closes the popup without turning the page', async () => {
    const { result, handleDismissPopup, singleClick } = setup();
    showDictionary(result, keepSelection);

    expect(await tap(result, singleClick)).toBe(true);
    expect(handleDismissPopup).toHaveBeenCalled();
  });

  test('leaves the next tap to turn the page', async () => {
    const { result, singleClick } = setup();
    showDictionary(result, keepSelection);
    await tap(result, singleClick);

    expect(await tap(result, singleClick)).toBe(false);
  });
});
