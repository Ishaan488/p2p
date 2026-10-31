// High-performance synthesized Web Audio API chime & haptics.
// Zero external audio files required! Works 100% offline on Desktop & Mobile.

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Warm up AudioContext on first user interaction to comply with browser autoplay policies
if (typeof window !== 'undefined') {
  const warmUp = () => {
    getAudioContext();
    window.removeEventListener('click', warmUp);
    window.removeEventListener('keydown', warmUp);
    window.removeEventListener('touchstart', warmUp);
  };
  window.addEventListener('click', warmUp, { once: true, passive: true });
  window.addEventListener('keydown', warmUp, { once: true, passive: true });
  window.addEventListener('touchstart', warmUp, { once: true, passive: true });
}

/**
 * Plays a pleasant, two-tone crystal chime on successful transfer completion.
 * Frequency chord: D5 (587.33 Hz) gliding into A5 (880 Hz) and high harmonic D6 (1174.66 Hz).
 */
export function playTransferSuccessChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc1.frequency.exponentialRampToValueAtTime(880.00, now + 0.1); // A5

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(880.00, now + 0.06);
    osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.22); // D6

    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(0.12, now + 0.025);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now + 0.06);
    osc1.stop(now + 0.36);
    osc2.stop(now + 0.36);

    triggerHaptic();
  } catch (err) {
    console.debug('Chime audio playback suppressed:', err);
  }
}

/**
 * Triggers native haptic feedback on Android / supported mobile devices.
 */
export function triggerHaptic() {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([30, 40, 50]);
    }
  } catch {
    // Vibration ignored if disabled or unsupported
  }
}
