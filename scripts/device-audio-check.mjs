import assert from 'node:assert/strict';
import { audioRms, createMicrophoneCheck } from '../web/src/deviceAudioCheck.js';

const wave = amplitude => Float32Array.from({ length: 1024 }, (_, i) => amplitude * Math.sin(i * 0.2));
const sampleFor = (check, samples, duration, options = {}) => {
  let result;
  for (let t = 0; t <= duration; t += 20) result = check.sample(samples, t, options);
  return result;
};
assert.equal(audioRms(new Float32Array(1024)), 0);
assert.equal(audioRms(new Float32Array(1024).fill(0.4)), 0);
assert.equal(sampleFor(createMicrophoneCheck(), wave(0.001), 2000).passed, false, 'near-silent background input must not pass');
assert.equal(sampleFor(createMicrophoneCheck(), wave(0.1), 2000, { speaking: true }).passed, false, 'system narration must not pass the microphone test');
assert.equal(sampleFor(createMicrophoneCheck(), wave(0.1), 2000, { running: false }).passed, false, 'suspended AudioContext cannot pass');
const spike = createMicrophoneCheck();
spike.sample(wave(0.1), 0); spike.sample(wave(0.1), 20);
assert.equal(spike.sample(wave(0), 400).passed, false, 'a brief spike must not pass');
assert.equal(sampleFor(createMicrophoneCheck(), wave(0.08), 800).passed, true);
assert.equal(sampleFor(createMicrophoneCheck(), wave(0.005), 300).passed, true, 'soft speech can pass the low audio fallback threshold');
console.log('8 microphone checks passed: silence, DC offset, near-silence, narration, suspended context, brief spike, audible input and soft speech.');
