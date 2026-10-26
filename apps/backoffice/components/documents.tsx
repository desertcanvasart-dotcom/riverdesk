'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { RequestDocumentInput } from '@vs/engine';
import { useErrorText } from '../lib/errors';
import { useTRPC } from '../lib/trpc';
import { Alert, Button } from './ui';

/** Starts the browser download of a ready document. */
export function download(documentId: string) {
  const link = document.createElement('a');
  link.href = `/api/documents/${documentId}`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * One button per document: request it, wait while the worker renders (polling), then download.
 * `input` leaves out the locale: the user picks the language next to the buttons.
 */
export function DocumentButtons({
  items,
}: {
  items: { key: string; label: string; input: DistributiveOmit<RequestDocumentInput, 'locale'> }[];
}) {
  const t = useTranslations('documents');
  const uiLocale = useLocale();
  const [locale, setLocale] = useState<'ar' | 'en' | 'both'>(uiLocale === 'en' ? 'en' : 'ar');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted">{t('language')}:</span>
        {(['ar', 'en', 'both'] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLocale(l)}
            className={`rounded-full px-3 py-1 ${locale === l ? 'bg-brand text-brand-ink' : 'border border-line'}`}
          >
            {l === 'ar' ? 'العربية' : l === 'en' ? 'English' : t('bothLanguages')}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <DocumentButton
            key={item.key}
            label={item.label}
            input={{ ...item.input, locale } as RequestDocumentInput}
          />
        ))}
      </div>
    </div>
  );
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function DocumentButton({ label, input }: { label: string; input: RequestDocumentInput }) {
  const trpc = useTRPC();
  const request = useMutation(trpc.documents.request.mutationOptions());
  return (
    <RequestDocumentButton
      label={label}
      pending={request.isPending}
      error={request.error}
      request={() => request.mutateAsync(input)}
    />
  );
}

/**
 * Requests a document, waits while the worker renders it, then downloads it, or hands the file
 * to `onReady` instead (sharing).
 */
export function RequestDocumentButton({
  label,
  request,
  pending = false,
  error,
  onReady,
  variant = 'secondary',
}: {
  label: string;
  request: () => Promise<{ documentId: string }>;
  pending?: boolean;
  error?: unknown;
  onReady?: (documentId: string) => void | Promise<void>;
  variant?: 'primary' | 'secondary';
}) {
  const t = useTranslations('documents');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const status = useQuery(
    trpc.documents.status.queryOptions(
      { documentId: documentId ?? '' },
      {
        enabled: documentId !== null,
        refetchInterval: (query) => (query.state.data?.status === 'pending' ? 1_000 : false),
      },
    ),
  );
  const state = status.data?.status;
  useEffect(() => {
    if (documentId && state === 'ready') {
      setDocumentId(null);
      void (onReady ? onReady(documentId) : download(documentId));
    }
  }, [documentId, state, onReady]);
  const busy = pending || (documentId !== null && state !== 'failed');
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant={variant}
        disabled={busy}
        onClick={() => {
          request()
            .then((r) => setDocumentId(r.documentId))
            .catch(() => undefined);
        }}
      >
        {busy ? t('preparing') : label}
      </Button>
      {Boolean(error) && <Alert tone="bad">{errorText(error)}</Alert>}
      {state === 'failed' && <Alert tone="bad">{t('failed')}</Alert>}
    </span>
  );
}
