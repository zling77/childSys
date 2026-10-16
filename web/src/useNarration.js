import { useCallback, useEffect, useState } from 'react';
import { cancelSpeak, isSpeaking, onTtsState, prepareTts, speak } from './tts.js';

const playEventName = 'previsit:narration-play';
let lastText = '';

export function useNarration(text, key, options = {}) {
  useEffect(() => {
    const spokenText = String(text ?? '').trim();
    lastText = spokenText;
    cancelSpeak();

    if (!spokenText) return undefined;

    let disposed = false;
    let completed = false;
    let inFlight = false;
    let userInteracted = false;
    let attempts = 0;
    let retryTimer = null;

    const speakCurrent = async () => {
      if (disposed || completed || inFlight || lastText !== spokenText) return;
      inFlight = true;
      attempts += 1;
      const status = await speak(spokenText, {
        rate: options.rate ?? 0.94,
        pitch: options.pitch ?? 1,
        volume: options.volume ?? 1,
      });
      inFlight = false;
      if (disposed || lastText !== spokenText) return;
      if (status === 'end') {
        completed = true;
        return;
      }
      if (userInteracted && attempts < 2) {
        retryTimer = window.setTimeout(() => {
          if (!isSpeaking()) void speakCurrent();
        }, 120);
      }
    };

    const autoPlayTimer = window.setTimeout(() => {
      void prepareTts().then(() => speakCurrent());
    }, 80);

    // Browsers may reject speech started before a user gesture. If that happens,
    // use the first real interaction to play the still-unheard prompt once.
    const onFirstInteraction = (event) => {
      userInteracted = true;
      void prepareTts().then(() => {
        const narrationControl = event.target instanceof Element
          && event.target.closest('[data-narration-control="true"]');
        if (!narrationControl && !completed && !inFlight && !isSpeaking()) void speakCurrent();
      });
    };

    const onPlay = () => {
      if (lastText === spokenText) {
        userInteracted = true;
        completed = false;
        attempts = 0;
        cancelSpeak();
        void prepareTts().then(() => speakCurrent());
      }
    };

    window.addEventListener(playEventName, onPlay);
    window.addEventListener('pointerdown', onFirstInteraction, { once: true });
    window.addEventListener('keydown', onFirstInteraction, { once: true });
    return () => {
      disposed = true;
      window.clearTimeout(autoPlayTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
      cancelSpeak();
      window.removeEventListener(playEventName, onPlay);
      window.removeEventListener('pointerdown', onFirstInteraction);
      window.removeEventListener('keydown', onFirstInteraction);
    };
  }, [key ?? text, options.rate, options.pitch, options.volume]);
}

export function playNarration() {
  window.dispatchEvent(new Event(playEventName));
}

export function stopNarration() {
  cancelSpeak();
}

export function useNarrationPlayback() {
  const [playing, setPlaying] = useState(isSpeaking());

  useEffect(() => onTtsState(setPlaying), []);

  const toggle = useCallback(() => {
    if (isSpeaking()) stopNarration();
    else playNarration();
  }, []);

  return { playing, toggle };
}
