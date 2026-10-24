import { useLayoutEffect } from 'react';

const HORIZONTAL_SLOP_PX = 8;

/**
 * Makes the mobile PWA behave like a native fixed viewport instead of a web page.
 *
 * iOS Safari/standalone PWAs can still rubber-band/pan the document sideways even
 * when DOM scrollWidth === clientWidth. CSS overflow rules are not enough there,
 * so we also cancel horizontal touch gestures at the document boundary while
 * leaving vertical scroll gestures alone.
 */
export function useNativeViewportLock() {
  useLayoutEffect(() => {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    const root = document.documentElement;
    root.classList.add('hm-native-viewport-lock');

    const clampDocumentX = () => {
      document.documentElement.scrollLeft = 0;
      document.body.scrollLeft = 0;
      if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
    };

    clampDocumentX();

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };

    // Only a document wider than the screen can pan sideways. When it is not,
    // cancelling "mostly horizontal" moves would also cancel the vertical scroll
    // a thumb starts at an angle, so those gestures are left alone.
    const documentCanPanSideways = () => document.documentElement.scrollWidth > window.innerWidth + 1;

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      if (!touch) return;

      if (event.touches.length > 1) {
        event.preventDefault();
        return;
      }

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const horizontal = absX > HORIZONTAL_SLOP_PX && absX > absY * 1.25;

      if (horizontal && documentCanPanSideways()) {
        event.preventDefault();
        clampDocumentX();
      }
    };

    const stopTracking = () => {
      tracking = false;
    };

    const preventGesture = (event: Event) => {
      event.preventDefault();
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', stopTracking, { passive: true });
    document.addEventListener('touchcancel', stopTracking, { passive: true });
    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });
    document.addEventListener('gestureend', preventGesture, { passive: false });
    document.addEventListener('dblclick', preventGesture, { passive: false });
    window.addEventListener('scroll', clampDocumentX, { passive: true });

    return () => {
      root.classList.remove('hm-native-viewport-lock');
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', stopTracking);
      document.removeEventListener('touchcancel', stopTracking);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      document.removeEventListener('gestureend', preventGesture);
      document.removeEventListener('dblclick', preventGesture);
      window.removeEventListener('scroll', clampDocumentX);
    };
  }, []);
}
