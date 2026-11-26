// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from '@/app/user/page';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('@/hooks/useAppRouter', () => ({ useAppRouter: () => router }));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: { getState: () => ({ viewStates: {} }) },
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { hasIAP: false } }),
}));
const auth = vi.hoisted(() => ({
  token: 'test-token',
  user: { email: 'reader@example.test', user_metadata: {} },
  refresh: async () => true,
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: vi.fn() }));
vi.mock('@/store/themeStore', () => ({ useThemeStore: () => ({}) }));
vi.mock('@/hooks/useQuotaStats', () => ({
  useQuotaStats: () => ({ quotas: [], userProfilePlan: 'free', customizationPurchased: false }),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useUserActions', () => ({ useUserActions: () => ({}) }));
vi.mock('@/hooks/useAvailablePlans', () => ({
  useAvailablePlans: () => ({ availablePlans: [], iapAvailable: false }),
}));
vi.mock('@/utils/nav', () => ({ navigateBackFromProfile: vi.fn() }));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: vi.fn() } }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/libs/payment/iap/client', () => ({}));
vi.mock('@/libs/payment/stripe/client', () => ({}));
const gift = vi.hoisted(() => ({
  claimGiftCards: vi.fn(async () => 0),
  fetchGiftCards: vi.fn(async () => ({ giftPlan: 'free', giftActiveUntil: null, giftOnly: false })),
  fetchGiftPrices: vi.fn(async () => []),
}));
vi.mock('@/libs/payment/gift/client', () => gift);
vi.mock('@/components/LegalLinks', () => ({ default: () => null }));
vi.mock('@/components/Spinner', () => ({ default: () => null }));
vi.mock('@/components/Toast', () => ({ Toast: () => null }));
vi.mock('@/app/user/components/Header', () => ({ default: () => null }));
vi.mock('@/app/user/components/UserInfo', () => ({ default: () => null }));
vi.mock('@/app/user/components/UsageStats', () => ({ default: () => null }));
vi.mock('@/app/user/components/PlansComparison', () => ({
  default: () => <div>Plans Comparison</div>,
}));
vi.mock('@/app/user/components/AccountActions', () => ({
  default: ({ onRedeemGiftCard }: { onRedeemGiftCard?: () => void }) =>
    onRedeemGiftCard ? <div>Redeem Gift Card</div> : null,
}));
vi.mock('@/app/user/components/StorageManager', () => ({ default: () => null }));
vi.mock('@/app/user/components/SharedLinksSection', () => ({ default: () => null }));
vi.mock('@/app/user/components/SyncPassphraseSection', () => ({
  SyncPassphraseSection: () => null,
}));
vi.mock('@/app/user/components/SyncCategoriesSection', () => ({
  SyncCategoriesSection: () => null,
}));
vi.mock('@/app/user/components/Checkout', () => ({ default: () => null }));
vi.mock('@/app/user/components/gift/GiftCardsSection', () => ({
  default: () => <div>Gift Cards Section</div>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  nav.params = new URLSearchParams();
});

describe('profile page plans', () => {
  it('shows the plans comparison by default', () => {
    render(<ProfilePage />);
    expect(screen.getByText('Plans Comparison')).toBeTruthy();
  });

  it('hides the plans comparison in a self-hosted build', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true');
    render(<ProfilePage />);
    expect(screen.queryByText('Plans Comparison')).toBeNull();
  });
});

describe('profile page gift cards', () => {
  it('loads gift cards and offers redeeming by default', async () => {
    render(<ProfilePage />);
    expect(screen.getByText('Redeem Gift Card')).toBeTruthy();
    await waitFor(() => {
      expect(gift.claimGiftCards).toHaveBeenCalled();
      expect(gift.fetchGiftCards).toHaveBeenCalled();
      expect(gift.fetchGiftPrices).toHaveBeenCalled();
    });
  });

  it('neither loads gift cards nor offers redeeming in a self-hosted build', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true');
    render(<ProfilePage />);
    expect(screen.queryByText('Redeem Gift Card')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gift.claimGiftCards).not.toHaveBeenCalled();
    expect(gift.fetchGiftCards).not.toHaveBeenCalled();
    expect(gift.fetchGiftPrices).not.toHaveBeenCalled();
  });

  it.each([
    'gift=ABCD-EFGH',
    'section=redeem',
    'section=gifts',
  ])('opens the account view, not gift cards, for ?%s in a self-hosted build', (query) => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true');
    nav.params = new URLSearchParams(query);
    render(<ProfilePage />);
    expect(screen.queryByText('Gift Cards Section')).toBeNull();
  });

  it('takes a gift code out of the URL by default', () => {
    nav.params = new URLSearchParams('gift=ABCD-EFGH');
    render(<ProfilePage />);
    expect(router.replace).toHaveBeenCalledWith(expect.stringContaining('section=redeem'));
  });

  it('leaves a gift code alone in a self-hosted build', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true');
    nav.params = new URLSearchParams('gift=ABCD-EFGH');
    render(<ProfilePage />);
    expect(router.replace).not.toHaveBeenCalled();
  });
});
