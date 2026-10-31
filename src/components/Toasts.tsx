// Transient messages, such as the auto-pause toast. Each stays until dismissed or eight seconds pass.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { IconClose, IconInfo } from './icons';

export interface Toast {
  id: number;
  message: string;
}

interface ToastApi {
  push: (message: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
let nextId = 1;

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast needs ToastProvider');
  return v;
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: (id: number) => void }) {
  useEffect(() => {
    const t = window.setTimeout(() => onDone(toast.id), 8000);
    return () => window.clearTimeout(t);
  }, [toast.id, onDone]);
  return (
    <div className="toast" role="status">
      <IconInfo />
      <span>{toast.message}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss message" onClick={() => onDone(toast.id)}>
        <IconClose />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string) => setToasts((t) => [...t.slice(-3), { id: nextId++, message }]), []);
  const done = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={done} />
        ))}
      </div>
    </Ctx.Provider>
  );
}
