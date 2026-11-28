// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsMenu from '@/app/library/components/SettingsMenu';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@/hooks/useAppRouter', () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: {} }) }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'reader@example.test', user_metadata: {} } }),
}));
vi.mock('@/hooks/useQuotaStats', () => ({
  useQuotaStats: () => ({ userProfilePlan: 'free', quotas: [] }),
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ themeMode: 'auto', setThemeMode: vi.fn() }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: {}, setSettingsDialogOpen: vi.fn() }),
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: () => ({ isSyncing: false, setLibrary: vi.fn() }),
}));
vi.mock('@/store/appLockStore', () => ({ useAppLockStore: () => ({ openDialog: vi.fn() }) }));
vi.mock('@/hooks/useCloudSyncStatus', () => ({ useCloudSyncStatus: () => ({ providers: [] }) }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/hooks/useTransferQueue', () => ({
  useTransferQueue: () => ({
    stats: {},
    hasActiveTransfers: false,
    setIsTransferQueueOpen: vi.fn(),
  }),
}));
vi.mock('@/hooks/useUserActions', () => ({ useUserActions: () => ({ handleLogout: vi.fn() }) }));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
  isWebAppPlatform: () => false,
}));
vi.mock('@/services/biometric', () => ({
  getBiometricStatus: vi.fn(),
  getBiometryLabelKey: vi.fn(),
  isBiometricSupported: () => false,
}));
vi.mock('@/helpers/settings', () => ({ saveSysSettings: vi.fn() }));
vi.mock('@/utils/nav', () => ({ navigateToLogin: vi.fn(), navigateToProfile: vi.fn() }));
vi.mock('@/utils/window', () => ({
  canToggleFullScreen: () => false,
  tauriHandleSetAlwaysOnTop: vi.fn(),
  toggleFullScreen: vi.fn(),
}));
vi.mock('@/utils/permission', () => ({ requestStoragePermission: vi.fn() }));
vi.mock('@/utils/bridge', () => ({ selectDirectory: vi.fn() }));
vi.mock('@/components/stats/ReadingStatsDialog', () => ({ setReadingStatsDialogVisible: vi.fn() }));
vi.mock('@/components/vocabulary/VocabularyDialog', () => ({
  setVocabularyDialogVisible: vi.fn(),
}));
vi.mock('@/app/library/components/BackupWindow', () => ({ setBackupDialogVisible: vi.fn() }));
vi.mock('@/app/library/components/CacheManagerWindow', () => ({
  setCacheManagerDialogVisible: vi.fn(),
}));
vi.mock('@/app/library/components/MigrateDataWindow', () => ({
  setMigrateDataDirDialogVisible: vi.fn(),
}));
vi.mock('@/components/AboutWindow', () => ({ setAboutDialogVisible: vi.fn() }));
vi.mock('@/components/UserAvatar', () => ({ default: () => null }));
vi.mock('@/components/Quota', () => ({ default: () => null }));
vi.mock('@/components/Menu', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/MenuItem', () => ({
  default: ({ label, children }: { label: string; children?: ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('SettingsMenu upgrade item', () => {
  it('offers the premium upgrade to a signed-in free user', () => {
    render(<SettingsMenu onPullLibrary={vi.fn()} />);
    expect(screen.getByText('Upgrade to Readest Premium')).toBeTruthy();
  });

  it('hides the premium upgrade in a self-hosted build', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true');
    render(<SettingsMenu onPullLibrary={vi.fn()} />);
    expect(screen.queryByText('Upgrade to Readest Premium')).toBeNull();
  });
});
