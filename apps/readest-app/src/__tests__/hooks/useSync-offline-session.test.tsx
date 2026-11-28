// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { SystemSettings } from '@/types/settings';

// Offline with an expired access token, the SDK has no token to give, so a
// pull fails with "Not authenticated" while the session is still good.

const h = vi.hoisted(() => {
  const baseSettings = (): SystemSettings =>
    ({
      version: 1,
      keepLogin: true,
      lastSyncedAtBooks: 0,
      lastSyncedAtConfigs: 0,
      lastSyncedAtNotes: 0,
      webdav: {
        enabled: false,
        serverUrl: '',
        username: '',
        password: '',
        rootPath: '/',
      },
    }) as unknown as SystemSettings;

  // The live store object. `settings` is reassigned (new ref) to model a
  // component calling setSettings with a fresh object, exactly like the
  // WebDAV connect handler does.
  const storeState = {
    settings: baseSettings(),
    setSettings: vi.fn((s: SystemSettings) => {
      storeState.settings = s;
    }),
    saveSettings: vi.fn(async (_env: unknown, _settings: SystemSettings) => {}),
  };

  return { baseSettings, storeState };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { id: 'env' } }),
}));

const syncClientMock = vi.hoisted(() => ({
  pullChanges: vi.fn(),
  pushChanges: vi.fn(async () => ({ books: null, configs: null, notes: null })),
}));

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: syncClientMock }),
}));

vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
}));

vi.mock('@/store/settingsStore', () => {
  const useSettingsStore = ((selector?: (s: typeof h.storeState) => unknown) =>
    selector ? selector(h.storeState) : h.storeState) as unknown as {
    (): typeof h.storeState;
    getState: () => typeof h.storeState;
  };
  useSettingsStore.getState = () => h.storeState;
  return { useSettingsStore };
});

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getConfig: () => null, setConfig: vi.fn() }),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setIsSyncing: vi.fn() }),
}));

const nav = vi.hoisted(() => ({ navigateToLogin: vi.fn() }));
vi.mock('@/utils/nav', () => nav);

vi.mock('@/utils/transform', () => ({
  transformBookFromDB: (x: unknown) => x,
  transformBookNoteFromDB: (x: unknown) => x,
  transformBookConfigFromDB: (x: unknown) => x,
}));

import { useSync } from '@/hooks/useSync';

const pullUnauthenticated = async (message = 'Not authenticated') => {
  syncClientMock.pullChanges.mockRejectedValue(new Error(message));
  const { result } = renderHook(() => useSync());
  await act(async () => {
    await result.current.pullChanges('books', 0, vi.fn(), vi.fn());
  });
};

beforeEach(() => {
  h.storeState.settings = h.baseSettings();
  h.storeState.setSettings.mockClear();
  syncClientMock.pullChanges.mockReset();
  nav.navigateToLogin.mockClear();
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useSync on a pull without an access token', () => {
  test('keeps a signed-in user in the app', async () => {
    localStorage.setItem('token', 'expired-access-token');
    await pullUnauthenticated();
    expect(nav.navigateToLogin).not.toHaveBeenCalled();
    expect(h.storeState.settings.keepLogin).toBe(true);
  });

  test('opens the login page once the session has ended', async () => {
    await pullUnauthenticated();
    expect(nav.navigateToLogin).toHaveBeenCalledTimes(1);
    expect(h.storeState.settings.keepLogin).toBe(false);
  });

  test('opens the login page when the server rejects the token', async () => {
    localStorage.setItem('token', 'revoked-access-token');
    await pullUnauthenticated('Failed to pull changes: Not authenticated');
    expect(nav.navigateToLogin).toHaveBeenCalledTimes(1);
  });
});
