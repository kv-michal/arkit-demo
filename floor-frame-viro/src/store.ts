import { useSyncExternalStore } from "react";
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const get = () => value;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    get,
    set(next: T) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    useValue: () => useSyncExternalStore(subscribe, get, get),
  };
}
