/**
 * Subscribes to GET /api/v1/jobs/{jobId}/events (SSE).
 *
 * EventSource cannot send an Authorization header, so each connection uses a
 * single-use, 60-second ticket. Tickets cannot be reused, so on any drop we
 * close the stream, fetch a new ticket and reconnect with `after=<lastSeq>`;
 * the backend replays everything after that sequence number. Events are
 * de-duplicated by `seq`, so the consumer sees each fact exactly once, in order.
 */
import { useEffect, useRef, useState } from 'react';
import { OPERATOR_EVENT_TYPES, type OperatorEvent } from '@inklink/shared-schemas';
import { api, type AuthKind } from './api';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'closed';

export function useJobEvents(jobId: string | undefined, auth: AuthKind) {
  const [events, setEvents] = useState<OperatorEvent[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!jobId) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    lastSeq.current = 0;
    setEvents([]);

    const onMessage = (msg: MessageEvent<string>) => {
      let e: OperatorEvent;
      try {
        e = JSON.parse(msg.data) as OperatorEvent;
      } catch {
        return;
      }
      if (typeof e.seq !== 'number' || e.seq <= lastSeq.current) return;
      lastSeq.current = e.seq;
      attempt = 0;
      setEvents((prev) => [...prev, e]);
    };

    // The backend sends `heartbeat` every 15 s. If nothing arrives for 40 s the
    // connection is dead even if the browser still reports it open (proxies).
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        source?.close();
        source = null;
        retry();
      }, 40_000);
    };

    const connect = async () => {
      if (stopped) return;
      try {
        const { ticket } = await api.ticket(jobId, auth);
        if (stopped) return;
        source = new EventSource(
          `/api/v1/jobs/${encodeURIComponent(jobId)}/events?ticket=${encodeURIComponent(ticket)}&after=${lastSeq.current}`,
        );
        source.onopen = () => {
          setState('live');
          arm();
        };
        // The backend sends named events (`event: <type>`), so listen per type.
        for (const t of OPERATOR_EVENT_TYPES) {
          source.addEventListener(t, ((m: MessageEvent<string>) => {
            arm();
            onMessage(m);
          }) as EventListener);
        }
        source.addEventListener('heartbeat', arm);
        source.onmessage = onMessage;
        source.onerror = () => {
          // The browser would retry with the same (already redeemed) ticket; do it ourselves.
          clearTimeout(watchdog);
          source?.close();
          source = null;
          retry();
        };
      } catch {
        retry();
      }
    };

    const retry = () => {
      if (stopped) return;
      setState('reconnecting');
      attempt += 1;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
      timer = setTimeout(connect, delay);
    };

    setState('connecting');
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      source?.close();
      setState('closed');
    };
  }, [jobId, auth]);

  return { events, state };
}
