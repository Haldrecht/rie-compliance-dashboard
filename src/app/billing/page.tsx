'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { authenticatedFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Status = { entitled: boolean; reason: string; subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null };

const REASON_TEXT: Record<string, string> = {
  no_subscription: 'Uw organisatie heeft nog geen abonnement.',
  payment_pending: 'Uw betaling wordt nog verwerkt of vraagt een extra bevestiging.',
  payment_failed: 'De laatste betaling is mislukt. Rond de betaling af om weer toegang te krijgen.',
  canceled: 'Het abonnement van uw organisatie is beëindigd.',
  paused: 'Het abonnement van uw organisatie is gepauzeerd.',
};

// Checkout for a signed-in organization without (or with a lapsed) subscription.
export default function BillingPage() {
  const { token, isAuthenticated, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [canceled, setCanceled] = useState(false);
  const autoStarted = useRef(false);

  const startCheckout = useCallback(async () => {
    setError('');
    setStarting(true);
    try {
      const res = await authenticatedFetch('/api/billing/checkout', { method: 'POST' }, token);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      if (data.code === 'already_subscribed') {
        router.push('/dashboard');
        return;
      }
      setError(data.error || 'Checkout kon niet worden gestart');
    } catch {
      setError('Checkout kon niet worden gestart');
    }
    setStarting(false);
  }, [token, router]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    const params = new URLSearchParams(window.location.search);
    setCanceled(params.get('canceled') === '1');
    authenticatedFetch('/api/billing/status', {}, token)
      .then((r) => r.json())
      .then((s: Status) => {
        setStatus(s);
        if (s.entitled) return;
        if (params.get('start') === '1' && !autoStarted.current) {
          autoStarted.current = true;
          void startCheckout();
        }
      })
      .catch(() => setError('Status kon niet worden opgehaald'));
  }, [authLoading, isAuthenticated, token, router, startCheckout]);

  return (
    <div className="min-h-screen gradient-brand flex items-center justify-center px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">Abonnement</CardTitle>
          <CardDescription className="text-center">RI&E Compliance Dashboard — jaarabonnement per organisatie</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canceled && (
            <div className="p-3 text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-md">
              De betaling is geannuleerd. Er is niets in rekening gebracht.
            </div>
          )}
          {error && <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">{error}</div>}
          {status?.entitled ? (
            <>
              <p className="text-center text-green-700">Uw organisatie heeft een actief abonnement.</p>
              {status.subscription?.cancelAtPeriodEnd && status.subscription.currentPeriodEnd && (
                <p className="text-center text-sm text-gray-600">
                  Opgezegd per {new Date(status.subscription.currentPeriodEnd).toLocaleDateString('nl-NL')}.
                </p>
              )}
              <Button className="w-full" onClick={() => router.push('/dashboard')}>Naar het dashboard</Button>
            </>
          ) : (
            <>
              <p className="text-center text-gray-700">{status ? REASON_TEXT[status.reason] ?? REASON_TEXT.no_subscription : 'Status ophalen...'}</p>
              <Button className="w-full" onClick={startCheckout} disabled={starting || !status}>
                {starting ? 'Doorsturen naar Stripe...' : 'Betalen via Stripe'}
              </Button>
              <button type="button" onClick={logout} className="w-full text-sm text-gray-500 hover:underline">Uitloggen</button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
