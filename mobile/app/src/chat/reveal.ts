import { useEffect, useRef, useState } from 'react';

import { useStill } from '@/ui/motion';

/** How long the words still to be shown take to come out, however many arrived at once. */
const CATCH_UP_MS = 250;
/** The slowest the words come out, in characters a millisecond, so the last few don't crawl. */
const MIN_PACE = 0.06;
const STEP_MS = 32;
/** How far past the pace a step may run to finish the word it stopped in. */
const WORD_REACH = 16;

function wordEnd(text: string, at: number): number {
  if (at >= text.length) return text.length;
  for (let end = at; end < Math.min(text.length, at + WORD_REACH); end += 1) if (/\s/.test(text[end])) return end;
  return at;
}

/**
 * Streamed text as it should be drawn: words that arrive in a burst, after the network held them
 * back, come out over the next quarter second instead of landing all at once.
 */
export function useRevealed(id: string, text: string, live: boolean): string {
  const still = useStill();
  // Text already there when it is drawn shows whole; text still streaming comes out from its start.
  const start = live ? 0 : text.length;
  const [shown, setShown] = useState({ id, length: start });
  if (shown.id !== id) setShown({ id, length: start });
  const length = shown.id === id ? Math.min(shown.length, text.length) : text.length;
  const behind = !still && length < text.length;
  const last = useRef(0);
  useEffect(() => {
    if (!behind) {
      last.current = 0;
      return;
    }
    let frame = requestAnimationFrame(function step(now) {
      const since = last.current ? now - last.current : STEP_MS;
      if (since < STEP_MS) {
        frame = requestAnimationFrame(step);
        return;
      }
      last.current = now;
      const pace = Math.max(MIN_PACE * since, ((text.length - length) * since) / CATCH_UP_MS);
      setShown({ id, length: wordEnd(text, length + Math.ceil(pace)) });
    });
    return () => cancelAnimationFrame(frame);
  }, [behind, id, text, length]);
  return behind ? text.slice(0, length) : text;
}
