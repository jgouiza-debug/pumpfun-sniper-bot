import { useEffect, useRef } from 'react';

/**
 * The buy-alert sound, shared by the sniper page and the copy page.
 *
 * Played through WebAudio rather than a plain <audio> so it can go past the
 * browser's 1.0 volume ceiling and take an optional bass lift — <audio> caps
 * at 100% and has no EQ. Browsers block audio until a user gesture, so the
 * context is unlocked (and the clip decoded) on the first click/keypress;
 * `testBuyAlert` does the same on demand because a button click IS a gesture.
 *
 * The hook only knows how to PLAY. Deciding WHEN — which feed line or which
 * new position counts as a buy — stays with each page, since the two pages
 * see different data shapes.
 */
export interface BuyAlertOptions {
  /** Clip URL relative to the page origin. Defaults to the shipped asset. */
  url?: string;
  /** Linear gain. 2.0 is "200%". */
  gain?: number;
  /**
   * Low-shelf lift under 200 Hz, in dB. Use 0 for a clip that is already
   * bass-boosted — stacking a second boost on top clips into distortion.
   */
  bassDb?: number;
}

export function useBuyAlert(opts: BuyAlertOptions = {}) {
  const url = opts.url ?? '/buy-alert.mp3';
  const gainValue = opts.gain ?? 2.0;
  const bassDb = opts.bassDb ?? 0;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<AudioBuffer | null>(null);
  const primedRef = useRef(false);

  const ensureContext = (): AudioContext | null => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return null;
      const ctx: AudioContext = audioCtxRef.current || new Ctx();
      audioCtxRef.current = ctx;
      return ctx;
    } catch {
      return null; // WebAudio unavailable
    }
  };

  const loadClip = async (ctx: AudioContext): Promise<void> => {
    if (bufRef.current) return;
    const b = await fetch(`${location.origin}${url}`).then(r => r.arrayBuffer());
    bufRef.current = await ctx.decodeAudioData(b);
  };

  useEffect(() => {
    const prime = () => {
      if (primedRef.current) return;
      primedRef.current = true;
      const ctx = ensureContext();
      if (!ctx) return;
      void ctx.resume();
      loadClip(ctx).catch(() => { /* no alert asset — stay silent */ });
    };
    window.addEventListener('pointerdown', prime);
    window.addEventListener('keydown', prime);
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const playBuyAlert = () => {
    const ctx = audioCtxRef.current;
    const buf = bufRef.current;
    if (!ctx || !buf) return;
    void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    let tail: AudioNode = src;
    if (bassDb !== 0) {
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 200;
      bass.gain.value = bassDb;
      src.connect(bass);
      tail = bass;
    }
    tail.connect(gain);
    gain.connect(ctx.destination);
    try { src.start(); } catch { /* start can throw if ctx suspended */ }
  };

  const testBuyAlert = async () => {
    try {
      const ctx = ensureContext();
      if (!ctx) return;
      await ctx.resume();
      await loadClip(ctx);
      playBuyAlert();
    } catch { /* no asset / WebAudio unavailable */ }
  };

  return { playBuyAlert, testBuyAlert };
}
