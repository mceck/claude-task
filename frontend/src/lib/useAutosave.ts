import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../api/client';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Debounces edits, sends only changed fields and drains pending edits in order. */
export function useAutosave<T extends object>(value: T, save: (changes: Partial<T>) => Promise<unknown>, enabled = true) {
  const [status, setStatus] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const state = useRef({ value, saved: value, save, enabled, mounted: false, timer: undefined as ReturnType<typeof setTimeout> | undefined, running: null as Promise<void> | null });
  Object.assign(state.current, { value, save, enabled });
  const serialized = JSON.stringify(value);

  const flush = useCallback((): Promise<void> => {
    const current = state.current;
    clearTimeout(current.timer);
    if (current.running) return current.running;
    current.running = (async () => {
      while (current.enabled) {
        const snapshot = current.value;
        const changes = Object.fromEntries(Object.entries(snapshot).filter(([key, next]) => !same(next, current.saved[key as keyof T]))) as Partial<T>;
        if (!Object.keys(changes).length) {
          if (current.mounted) {
            setStatus('saved');
            setError('');
          }
          return;
        }
        if (current.mounted) {
          setStatus('saving');
          setError('');
        }
        try {
          await current.save(changes);
          current.saved = { ...current.saved, ...changes };
        } catch (err) {
          if (current.mounted) {
            setStatus('error');
            setError(errorMessage(err));
          } else toast.error('Couldn’t save changes', { description: errorMessage(err) });
          return;
        }
      }
    })().finally(() => { current.running = null; });
    return current.running;
  }, []);

  useEffect(() => {
    const current = state.current;
    if (!enabled) return;
    if (same(current.value, current.saved)) {
      if (!current.running) {
        setStatus('saved');
        setError('');
      }
      return;
    }
    setStatus('pending');
    current.timer = setTimeout(() => { void flush(); }, 600);
    return () => clearTimeout(current.timer);
  }, [serialized, enabled, flush]);

  useEffect(() => {
    const current = state.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      void flush();
    };
  }, [flush]);

  // Edits must stop showing "saved" in the same render, before effects run.
  const shownStatus = status === 'saved' && enabled && !same(value, state.current.saved) ? 'pending' : status;
  return { status: shownStatus, error, flush };
}
