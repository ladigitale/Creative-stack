/** Moteur procgen (build ESM vendu, voir ENGINE.md). Seule la surface utilisée par l'addon est typée. */
export interface ProcgenStore {
  kind: string;
  get(path: string): any;
  set(path: string, value: any): void;
  watch(path: string, cb: (value: any) => void): () => void;
}
export class ProcgenScene extends HTMLElement {
  static store: ProcgenStore;
  static useConcorde(api: { dp: (path: string) => any }): void;
  static useStore(store: ProcgenStore): void;
  static scenes: Record<string, unknown>;
  static styles: Record<string, unknown>;
  static library: Record<string, unknown>;
  readonly path: string;
  connectedCallback(): void;
  disconnectedCallback(): void;
}
