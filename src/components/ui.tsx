// Small design-system primitives: buttons, fields, chips, switches, a modal with a focus trap.
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { readableText } from '../lib/color';
import { IconClose } from './icons';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', small = false, icon, className, children, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', `btn-${variant}`, small ? 'btn-small' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon}
      {children !== undefined && children !== null && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ label, icon, className, type = 'button', ...rest }: { label: string; icon: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={`icon-btn ${className ?? ''}`} aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  );
}

/** A labelled form row. The control is passed a generated id through the render prop. */
export function Field({
  label,
  hint,
  error,
  children,
  inline = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  inline?: boolean;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${inline ? 'field-inline' : ''}`}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A native checkbox presented as a switch. */
export function Switch({ checked, onChange, label, hint, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="switch-row">
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-h` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <span id={`${id}-h`} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** A coloured chip. The project's name is always printed; colour never carries the meaning alone. */
export function ProjectChip({ name, color, archived = false, title }: { name: string; color: string; archived?: boolean; title?: string }) {
  return (
    <span className="chip" style={{ background: color, color: readableText(color) }} title={title ?? name}>
      <span className="chip-name">{name}</span>
      {archived && <span className="chip-flag">archived</span>}
    </span>
  );
}

export function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} aria-hidden="true" />;
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success'; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Card({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section className={`card ${className}`} aria-label={label}>
      {children}
    </section>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
  dismissible = true,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    if (node) {
      const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (!ref.current) return;
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [open, dismissible]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismissible && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {dismissible && <IconButton label="Close dialog" icon={<IconClose />} onClick={onClose} />}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** A group of mutually exclusive choices drawn as segmented buttons. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A small confirmation dialog: the action is only taken when the user presses the confirm button. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
