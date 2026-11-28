// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAvailablePlans } from '@/hooks/useAvailablePlans';
import type { AvailablePlan } from '@/types/quota';

const mocks = vi.hoisted(() => ({
  fetchStripePlans: vi.fn(),
  isIAPAvailable: vi.fn(),
  fetchAndTransformIAPPlans: vi.fn(),
}));

vi.mock('@/libs/payment/stripe/client', () => ({ fetchStripePlans: mocks.fetchStripePlans }));
vi.mock('@/libs/payment/iap/client', () => ({
  isIAPAvailable: mocks.isIAPAvailable,
  fetchAndTransformIAPPlans: mocks.fetchAndTransformIAPPlans,
}));

const stripePlans = [{ productId: 'price_plus', plan: 'plus' }] as unknown as AvailablePlan[];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('useAvailablePlans', () => {
  it('makes no payment calls in a self-hosted build', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true');

    const { result } = renderHook(() => useAvailablePlans({ hasIAP: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.fetchStripePlans).not.toHaveBeenCalled();
    expect(mocks.isIAPAvailable).not.toHaveBeenCalled();
    expect(mocks.fetchAndTransformIAPPlans).not.toHaveBeenCalled();
    expect(result.current.availablePlans).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('loads the Stripe plans when IAP is not available', async () => {
    mocks.fetchStripePlans.mockResolvedValue(stripePlans);

    const { result } = renderHook(() => useAvailablePlans({ hasIAP: false }));

    await waitFor(() => expect(result.current.availablePlans).toEqual(stripePlans));
    expect(mocks.fetchStripePlans).toHaveBeenCalledTimes(1);
    expect(mocks.isIAPAvailable).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
