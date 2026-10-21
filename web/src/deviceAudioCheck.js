// This verifies audible input, not speaker identity or speech recognition.
// Remove DC bias so a constant/silent buffer cannot pass as sound.
export function audioRms(samples) {
  if (!samples.length) return 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length);
}

export function createMicrophoneCheck() {
  let voicedMs = 0, quietMs = 0, previous = null, passed = false;
  return {
    sample(samples, now, { speaking = false, running = true } = {}) {
      const elapsed = previous === null ? 0 : Math.min(80, Math.max(0, now - previous));
      previous = now;
      const rms = audioRms(samples);
      if (!passed) {
        if (speaking || !running) { voicedMs = 0; quietMs = 0; }
        else if (rms >= 0.003) { voicedMs += elapsed; quietMs = 0; }
        else { quietMs += elapsed; if (quietMs > 180) voicedMs = 0; }
        passed = voicedMs >= 200;
      }
      return { passed, rms, level: Math.min(100, Math.round(rms * 700)), voicedMs };
    },
  };
}
