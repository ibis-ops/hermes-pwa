import { useLayoutEffect } from 'react';

const KEYBOARD_THRESHOLD_PX = 80;

/**
 * Keep the app inside the part of the screen the keyboard leaves free.
 *
 * On iOS, and above all in an installed (standalone) web app, opening the
 * keyboard does not shrink the layout viewport: a `position: fixed` shell keeps
 * its full height, the composer ends up under the keyboard, and Safari scrolls
 * the whole page to reveal the focused field, which drags the header off the
 * top. `window.visualViewport` reports the visible area, so the shell is sized
 * from it and the page is pinned at the top.
 *
 * Exposes `--hm-visual-height` and `--hm-keyboard-inset` on the root element,
 * toggles `hm-keyboard-open`, and nudges the active chat list to its end so the
 * last message stays above the keyboard.
 */
export function useVisualViewport() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    let keyboardOpen = false;

    const apply = () => {
      frame = 0;
      const height = Math.round(viewport.height);
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      root.style.setProperty('--hm-visual-height', `${height}px`);
      root.style.setProperty('--hm-keyboard-inset', `${inset}px`);
      const nextOpen = inset > KEYBOARD_THRESHOLD_PX;
      if (nextOpen !== keyboardOpen) {
        keyboardOpen = nextOpen;
        root.classList.toggle('hm-keyboard-open', nextOpen);
        if (nextOpen) {
          const list = document.querySelector<HTMLElement>('.hm-chat__messages');
          if (list) list.scrollTop = list.scrollHeight;
        }
      }
      if (window.scrollY !== 0 || viewport.offsetTop !== 0) {
        window.scrollTo(0, 0);
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(apply);
    };
    const scheduleLater = () => {
      // The keyboard animates; a second pass after it settles catches the final size.
      schedule();
      window.setTimeout(schedule, 120);
      window.setTimeout(schedule, 360);
    };

    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('focusin', scheduleLater);
    window.addEventListener('focusout', scheduleLater);
    window.addEventListener('orientationchange', scheduleLater);
    apply();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('focusin', scheduleLater);
      window.removeEventListener('focusout', scheduleLater);
      window.removeEventListener('orientationchange', scheduleLater);
      root.style.removeProperty('--hm-visual-height');
      root.style.removeProperty('--hm-keyboard-inset');
      root.classList.remove('hm-keyboard-open');
    };
  }, []);
}
