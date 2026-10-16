import { useEffect, useRef } from "react";

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  // When false, clicking the backdrop and pressing Escape do nothing -
  // used while an operation that shouldn't be abandoned is running.
  dismissable?: boolean;
}

/**
 * Shared backdrop for every dialog/panel in the editor: dims the app,
 * closes on Escape or a click on the backdrop itself (not on the dialog
 * contents), and marks itself role="dialog" so global editor shortcuts
 * (see useEditorShortcuts) stay out of the way while it's open.
 */
export function Modal({ onClose, children, dismissable = true }: ModalProps) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!dismissable) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [dismissable]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 modal-backdrop"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}
