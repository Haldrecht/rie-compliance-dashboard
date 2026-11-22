'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { authenticatedFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Stripe Checkout return. Access is confirmed from the server (webhook, or reconciliation of this
// session with Stripe), never assumed from reaching this page.
const MAX_ATTEMPTS = 10;

export default function PaymentSuccessPage() {
  const { token, isAuthenticated, loading: authLoading, user } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<'checking' | 'active' | 'pending' | 'login'>('checking');

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setState('login');
      return;
    }
    const sessionId = new URLSearchParams(window.location.search).get('session_id') ?? '';
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      attempt += 1;
      try {
        const res = await authenticatedFetch(`/api/billing/status?session_id=${encodeURIComponent(sessionId)}`, {}, token);
        const data = await res.json();
        if (data.entitled) {
          setState('active');
          return;
        }
      } catch {
        // retry below
      }
      if (attempt >= MAX_ATTEMPTS) setState('pending');
      else timer = setTimeout(check, Math.min(1000 * attempt, 5000));
    };
    void check();
    return () => clearTimeout(timer);
  }, [authLoading, isAuthenticated, token]);

  const next = user?.onboardingCompleted ? '/dashboard' : '/rie/new';

  return (
    <div className="min-h-screen gradient-brand flex items-center justify-center px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">
            {state === 'active' ? 'Betaling ontvangen' : state === 'pending' ? 'Betaling wordt verwerkt' : state === 'login' ? 'Log in om verder te gaan' : 'Betaling controleren...'}
          </CardTitle>
          <CardDescription className="text-center">
            {state === 'active' && 'Uw abonnement is actief. U kunt nu uw RI&E opstellen.'}
            {state === 'pending' && 'Dit duurt langer dan verwacht. U ontvangt toegang zodra Stripe de betaling bevestigt.'}
            {state === 'login' && 'Uw betaling is ontvangen door Stripe. Log in om uw organisatie te openen.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {state === 'checking' && <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-gold mx-auto" />}
          {state === 'active' && <Button className="w-full" onClick={() => router.push(next)}>{next === '/rie/new' ? 'RI&E starten' : 'Naar het dashboard'}</Button>}
          {state === 'pending' && <Button variant="outline" className="w-full" onClick={() => window.location.reload()}>Opnieuw controleren</Button>}
          {state === 'login' && <Button className="w-full" onClick={() => router.push('/login')}>Inloggen</Button>}
        </CardContent>
      </Card>
    </div>
  );
}
