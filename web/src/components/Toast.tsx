import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type Toast = (msg: string) => void;

const ToastContext = createContext<Toast>(() => {});

export const useToast = (): Toast => useContext(ToastContext);

const SHOW_MS = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((text: string) => {
    setMsg(text);
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), SHOW_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div id="toast" className={shown ? 'toast' : 'toast hidden'}>{msg}</div>
    </ToastContext.Provider>
  );
}
