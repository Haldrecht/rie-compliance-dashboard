'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Step 1 of the purchase: create the organization and its first account, then continue to checkout.
export default function RegisterPage() {
  const { register, isAuthenticated, loading: authLoading } = useAuth();
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [form, setForm] = useState({ companyName: '', kvkNumber: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [canceled, setCanceled] = useState(false);

  useEffect(() => {
    setCanceled(new URLSearchParams(window.location.search).get('canceled') === 'true');
    fetch('/api/auth/register')
      .then((r) => r.json())
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    if (!authLoading && isAuthenticated) router.push('/billing');
  }, [isAuthenticated, authLoading, router]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await register({
        companyName: form.companyName,
        name: form.name,
        email: form.email,
        password: form.password,
        ...(form.kvkNumber.trim() ? { kvkNumber: form.kvkNumber.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registratie mislukt');
      setSubmitting(false);
    }
  };

  if (enabled === false) {
    return (
      <div className="min-h-screen gradient-brand flex items-center justify-center px-6 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl text-center">Account aanmaken uitgeschakeld</CardTitle>
            <CardDescription className="text-center">
              Accounts worden door een beheerder aangemaakt en voorzien van een licentie.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center text-gray-700 space-y-4">
            <p>Neem contact op met uw beheerder om toegang te krijgen.</p>
            <p>
              Heeft u al een account? <Link href="/login" className="text-brand-gold hover:underline">Log hier in</Link>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen gradient-brand flex items-center justify-center px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">RI&E Dashboard afnemen</CardTitle>
          <CardDescription className="text-center">
            Maak een account voor uw organisatie. Daarna rondt u de betaling af via Stripe.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {canceled && (
              <div className="p-3 text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-md">
                De betaling is geannuleerd. U kunt het opnieuw proberen.
              </div>
            )}
            {error && <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">{error}</div>}
            <Field id="companyName" label="Organisatienaam" value={form.companyName} onChange={set('companyName')} required disabled={submitting} />
            <Field id="kvkNumber" label="KvK-nummer (optioneel)" value={form.kvkNumber} onChange={set('kvkNumber')} disabled={submitting} inputMode="numeric" pattern="\d{8}" />
            <Field id="name" label="Uw naam" value={form.name} onChange={set('name')} required disabled={submitting} autoComplete="name" />
            <Field id="email" label="Zakelijk e-mailadres" type="email" value={form.email} onChange={set('email')} required disabled={submitting} autoComplete="email" />
            <Field id="password" label="Wachtwoord (minimaal 8 tekens)" type="password" value={form.password} onChange={set('password')} required minLength={8} disabled={submitting} autoComplete="new-password" />
            <Button type="submit" className="w-full" disabled={submitting || enabled === null}>
              {submitting ? 'Account aanmaken...' : 'Doorgaan naar betalen'}
            </Button>
            <p className="text-center text-sm text-gray-600">
              Heeft u al een account? <Link href="/login" className="text-brand-gold hover:underline">Log in</Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ id, label, ...props }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">{label}</label>
      <Input id={id} {...props} />
    </div>
  );
}
