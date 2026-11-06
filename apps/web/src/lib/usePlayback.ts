/**
 * Visual playback queue for the Agent Workspace.
 *
 * Tools run in milliseconds, far faster than a person can follow. The workspace
 * therefore replays the REAL events, strictly in `seq` order, with a short
 * dwell per event so the cursor, menus and values are watchable. It never adds,
 * drops, reorders or alters events. When a large backlog exists (opening the
 * workspace late, or after a reconnect) it catches up quickly instead of making
 * the viewer wait; an explicit replay plays everything at normal speed.
 */
import { useCallback, useEffect, useState } from 'react';
import type { OperatorEvent } from '@inklink/shared-schemas';

const DWELL: Partial<Record<OperatorEvent['type'], number>> = {
  tool_started: 1150,
  configuration_updated: 650,
  tool_succeeded: 450,
  tool_failed: 1100,
  agent_thinking: 500,
  agent_started: 450,
};
const DEFAULT_DWELL = 220;
const CATCH_UP_BACKLOG = 24;
const CATCH_UP_DWELL = 40;

export function usePlayback(events: OperatorEvent[], animate = true) {
  const [played, setPlayed] = useState(0);
  const [replaying, setReplaying] = useState(false);

  // A new job (events reset) restarts playback.
  useEffect(() => {
    if (events.length < played) setPlayed(0);
  }, [events.length, played]);

  useEffect(() => {
    if (played >= events.length) {
      if (replaying) setReplaying(false);
      return;
    }
    if (!animate) {
      setPlayed(events.length);
      return;
    }
    const backlog = events.length - played;
    const last = events[played - 1];
    const catchUp = !replaying && backlog > CATCH_UP_BACKLOG;
    const dwell = played === 0 ? 0 : catchUp ? CATCH_UP_DWELL : (DWELL[last.type] ?? DEFAULT_DWELL);
    const t = setTimeout(() => setPlayed((p) => p + 1), dwell);
    return () => clearTimeout(t);
  }, [events, played, animate, replaying]);

  /** Replay the same recorded events from the beginning (demo / review). */
  const restart = useCallback(() => {
    setReplaying(true);
    setPlayed(0);
  }, []);

  return {
    restart,
    replaying,
    played,
    playedEvents: events.slice(0, played),
    current: played > 0 ? events[played - 1] : null,
    backlog: events.length - played,
  };
}
