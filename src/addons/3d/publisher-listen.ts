/** Listener proxy DataProvider (`_proxies_.get(key).hasListener`). */

export type PublisherProxies = {
  _proxies_?: Map<string, { hasListener?: () => boolean }>;
} | null;

export function publisherFieldHasListener(
  pub: PublisherProxies,
  key: string,
): boolean {
  const child = pub?._proxies_?.get(key);
  return !!child?.hasListener?.();
}
