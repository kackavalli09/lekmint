import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { AlertTriangle } from 'lucide-react';
import { getReadinessCheckUrl } from '@workspace/api-client-react';

type ServiceState = 'unknown' | 'ready' | 'unavailable' | 'maintenance' | 'standby';

const POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

export function ServiceStatusBanner() {
  const [state, setState] = useState<ServiceState>('unknown');

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    async function poll() {
      if (disposed || document.hidden) return;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
      let next: ServiceState = 'unavailable';
      try {
        // Use the generated route but inspect HTTP status ourselves: the
        // generated readiness helper hides it and accepts any successful 2xx.
        // A 201 or cached SPA HTML must never count as transaction readiness.
        const response = await fetch(getReadinessCheckUrl(), {
          signal: request.signal,
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && 'status' in body && 'mode' in body) {
          if (response.status === 200 && body.status === 'ready' && body.mode === 'active') {
            next = 'ready';
          } else if (body.mode === 'maintenance' || body.mode === 'standby') {
            next = body.mode;
          }
        }
      } catch {
        // Availability is explicitly surfaced, not silently treated as ready.
        // This request is read-only; never retry/replay a transaction here.
      } finally {
        clearTimeout(timeout);
        if (controller === request) {
          controller = undefined;
          if (!disposed && !document.hidden) {
            setState(next);
            timer = setTimeout(poll, POLL_INTERVAL_MS);
          }
        }
      }
    }

    function onVisibilityChange() {
      clearTimeout(timer);
      const previous = controller;
      controller = undefined;
      previous?.abort();
      if (!document.hidden) void poll();
    }

    void poll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  if (state === 'unknown' || state === 'ready') return null;

  const heading = state === 'maintenance'
    ? 'Mint maintenance'
    : state === 'standby' ? 'Mint is on standby' : 'Mint temporarily unavailable';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="status-service-outage"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-3xl items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          <strong>{heading} — transactions paused.</strong>{' '}
          Wait before minting, sending, receiving, melting or updating tokens.
          Your browser tokens have not been changed.{' '}
          <Link href="/recover" className="underline underline-offset-2" data-testid="link-outage-recovery">
            Recovery and export remain available
          </Link>
          {' '}(online recovery needs the mint). We check again automatically; no transaction is retried.
        </p>
      </div>
    </div>
  );
}