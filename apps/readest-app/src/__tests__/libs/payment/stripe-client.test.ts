import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockLoadStripe } = vi.hoisted(() => ({
  mockLoadStripe: vi.fn(async () => null),
}));

vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: mockLoadStripe }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stripe client', () => {
  it('loads Stripe.js only when getStripe is first called', async () => {
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_BASE64', btoa('pk_test_key'));
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_DEV_BASE64', btoa('pk_test_key'));

    const { getStripe } = await import('@/libs/payment/stripe/client');
    expect(mockLoadStripe).not.toHaveBeenCalled();

    await getStripe();
    await getStripe();

    expect(mockLoadStripe).toHaveBeenCalledTimes(1);
    expect(mockLoadStripe).toHaveBeenCalledWith('pk_test_key');
  });
});
