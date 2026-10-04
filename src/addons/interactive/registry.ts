/**
 * Registre global des sonic-store + dispatch typé.
 * Utilisé par keyboard / gamepad / gesture / action / ticker.
 */

export type SonicActionMessage = {
  type: string;
  payload?: unknown;
  t?: number;
  dt?: number;
};

export type StoreHandle = {
  id: string;
  dispatch: (action: SonicActionMessage) => void;
  getState: () => unknown;
  reset: () => void;
};

const stores = new Map<string, StoreHandle>();

export function registerStore(handle: StoreHandle): void {
  stores.set(handle.id, handle);
}

export function unregisterStore(id: string): void {
  stores.delete(id);
}

export function getStore(id: string): StoreHandle | undefined {
  return stores.get(id);
}

/** Dispatch une action vers un store enregistré. No-op si absent. */
export function dispatch(storeId: string, action: SonicActionMessage): void {
  const store = stores.get(storeId);
  if (!store) return;
  store.dispatch({
    ...action,
    t: action.t ?? performance.now(),
  });
}

export function listStoreIds(): string[] {
  return [...stores.keys()];
}
