import { useRef } from 'react';
import { Icon } from './Icon';

interface AttachMenuProps {
  open: boolean;
  onClose: () => void;
  onFiles: (files: FileList | null) => void;
  /** Present when skills can be listed: adds "Use a skill". */
  onSkill?: (() => void) | undefined;
}

/**
 * Attachment picker. One entry on purpose: a bare file input (no `accept`, no
 * `capture`) is the one combination where iOS offers Photo Library, Take Photo
 * and Choose File together, and Android/desktop show their normal picker.
 */
export function AttachMenu({ open, onClose, onFiles, onSkill }: AttachMenuProps) {
  const filesInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  return (
    <>
      <button type="button" className="hm-attach-overlay" onClick={onClose} aria-label="Close attachment menu" />
      <div className="hm-attach-menu" role="menu">
        <button
          type="button"
          className="hm-attach-item"
          role="menuitem"
          onClick={() => filesInputRef.current?.click()}
        >
          <span className="hm-attach-item__icon" aria-hidden="true">
            <Icon name="paperclip" size={18} />
          </span>
          <span className="hm-attach-item__body">
            <span className="hm-attach-item__label">Photo or file</span>
            <span className="hm-attach-item__hint">Photos, screenshots, PDFs, text and CSV, up to 16 MB</span>
          </span>
        </button>
        {onSkill ? (
          <button
            type="button"
            className="hm-attach-item"
            role="menuitem"
            onClick={() => {
              onClose();
              onSkill();
            }}
          >
            <span className="hm-attach-item__icon" aria-hidden="true">
              <Icon name="bolt" size={18} />
            </span>
            <span className="hm-attach-item__body">
              <span className="hm-attach-item__label">Use a skill</span>
              <span className="hm-attach-item__hint">Start this message with one of Hermes's skills</span>
            </span>
          </button>
        ) : null}
      </div>

      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hm-composer__file-input"
        aria-label="Choose photos or files"
        onChange={(e) => {
          onFiles(e.target.files);
          onClose();
        }}
      />
    </>
  );
}
