import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { shareOrOpenFile } from '../pwa/share';

interface LightboxProps {
  src: string;
  name: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer. Installed PWAs on iOS leave the app when a link
 * opens a new tab, so images open in place. The share button fetches the file
 * with the app's session and opens the system share sheet (Save to Photos,
 * AirDrop, Messages); a long press on the picture works too.
 */
export function Lightbox({ src, name, onClose }: LightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="hm-lightbox" role="dialog" aria-modal="true" aria-label={name} data-testid="lightbox">
      <div className="hm-lightbox__bar">
        <button ref={closeRef} type="button" className="hm-lightbox__button" onClick={onClose} aria-label="Close image">
          <Icon name="close" size={18} />
        </button>
        <span className="hm-lightbox__name">{name}</span>
        <button
          type="button"
          className="hm-lightbox__button"
          onClick={() => void shareOrOpenFile(src, name)}
          aria-label="Save or share image"
        >
          <Icon name="download" size={18} />
        </button>
      </div>
      <div className="hm-lightbox__stage" onClick={onClose}>
        <img className="hm-lightbox__img" src={src} alt={name} onClick={(event) => event.stopPropagation()} />
      </div>
    </div>
  );
}
