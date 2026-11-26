import { cleanup, render, screen } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: null }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, opts?: Record<string, string>) =>
    opts ? key.replace(/\{\{(\w+)\}\}/g, (_m, name) => opts[name] ?? _m) : key,
}));

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { alt, ...rest } = props;
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={String(alt ?? '')} {...(rest as React.ImgHTMLAttributes<HTMLImageElement>)} />;
  },
}));

vi.mock('@/app/auth/components/ReadestCloudOptIn', () => ({ default: () => null }));

import AuthPanel from '@/app/auth/components/AuthPanel';

const renderPanel = () =>
  render(
    <AuthPanel
      supabaseClient={{ auth: {} } as unknown as SupabaseClient}
      magicLink
      onProviderSignIn={vi.fn()}
    />,
  );

const otherWays = [
  'Sign in with Google',
  'Sign in with Apple',
  'Sign in with GitHub',
  'Sign in with Discord',
  'Sign in with a QR code',
  'Send a magic link email',
  'Forgot your password?',
  "Don't have an account? Sign up",
];

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('AuthPanel sign-in methods', () => {
  test('offers every sign-in method by default', () => {
    renderPanel();
    for (const name of otherWays) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByLabelText('Email address')).toBeTruthy();
  });

  test('offers only email and password in a self-hosted build', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true');
    renderPanel();
    for (const name of otherWays) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByText('or continue with email')).toBeNull();
    expect(screen.getByLabelText('Email address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
