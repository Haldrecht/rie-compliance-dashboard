'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sidebar } from '@/components/layout/Sidebar';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import { authenticatedFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Row = { id: string; title: string; status: string; startDate: string; createdAt: string; riskCount: number };

// The organization's RI&E assessments, each downloadable as PDF or Word.
export default function RieReportsPage() {
  return (
    <ProtectedRoute>
      <Reports />
    </ProtectedRoute>
  );
}

function Reports() {
  const { token } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    authenticatedFetch('/api/assessments', {}, token).then(async (res) => {
      if (res.status === 402) return router.push('/billing');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data.error || 'RI&E-overzicht kon niet worden geladen');
      setRows(data.assessments);
    }).catch(() => setError('RI&E-overzicht kon niet worden geladen'));
  }, [token, router]);

  const download = async (row: Row, format: 'pdf' | 'docx') => {
    setBusy(`${row.id}:${format}`);
    setError('');
    try {
      const res = await authenticatedFetch('/api/reports/rie', { method: 'POST', body: JSON.stringify({ assessmentId: row.id, format }) }, token);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Rapport kon niet worden gemaakt');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `RI&E_${row.title.replace(/[^A-Za-z0-9 _.-]/g, '')}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rapport kon niet worden gemaakt');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar />
      <div className="lg:pl-64">
        <main className="py-6">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">RI&E-rapporten</h1>
                <p className="mt-2 text-gray-600">Download het rapport van een afgeronde RI&E.</p>
              </div>
              <Link href="/rie/new"><Button>Nieuwe RI&E</Button></Link>
            </div>
            {error && <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">{error}</div>}
            {rows === null && !error && <p className="text-gray-600">Laden...</p>}
            {rows?.length === 0 && (
              <Card><CardContent className="py-8 text-center text-gray-600">Nog geen RI&E opgesteld. <Link href="/rie/new" className="text-brand-gold hover:underline">Start de wizard</Link>.</CardContent></Card>
            )}
            {rows?.map((row) => (
              <Card key={row.id}>
                <CardHeader><CardTitle className="text-lg">{row.title}</CardTitle></CardHeader>
                <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <p className="text-sm text-gray-600">
                    {new Date(row.createdAt).toLocaleDateString('nl-NL')} · {row.riskCount} risico&apos;s · {row.status}
                  </p>
                  <div className="flex gap-2">
                    <Button onClick={() => download(row, 'pdf')} disabled={!!busy}>{busy === `${row.id}:pdf` ? 'Bezig...' : 'PDF'}</Button>
                    <Button variant="outline" onClick={() => download(row, 'docx')} disabled={!!busy}>{busy === `${row.id}:docx` ? 'Bezig...' : 'Word'}</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
