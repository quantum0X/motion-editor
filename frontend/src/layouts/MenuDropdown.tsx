import { useRef, useEffect } from "react";

export interface MenuItemDef {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  divider?: boolean; // if true, renders a separator instead of a clickable row (label/onClick ignored)
  danger?: boolean;
}

interface MenuDropdownProps {
  label: string;
  items: MenuItemDef[];
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * One top-level menu (e.g. "File") plus its dropdown. The menu bar
 * itself (MenuBar.tsx) owns which single menu is open at a time, since
 * opening one should close any other that's already open - standard
 * desktop menu bar behavior.
 */
export function MenuDropdown({ label, items, isOpen, onOpen, onClose }: MenuDropdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => (isOpen ? onClose() : onOpen())}
        className={`px-2.5 py-1 text-xs rounded transition-colors ${
          isOpen ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
        }`}
      >
        {label}
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 min-w-[220px] rounded-md bg-surface-2 border border-border-strong shadow-2xl py-1 z-50">
          {items.map((item, idx) =>
            item.divider ? (
              <div key={idx} className="h-px bg-border-subtle my-1" />
            ) : (
              <button
                key={idx}
                onClick={() => {
                  if (item.disabled) return;
                  item.onClick?.();
                  onClose();
                }}
                disabled={item.disabled}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
                  item.disabled
                    ? "text-text-tertiary opacity-40 cursor-default"
                    : item.danger
                      ? "text-danger hover:bg-danger/10"
                      : "text-text-primary hover:bg-surface-3"
                }`}
              >
                <span>{item.label}</span>
                {item.shortcut && <span className="text-text-tertiary font-mono-tabular text-[11px] ml-4">{item.shortcut}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
