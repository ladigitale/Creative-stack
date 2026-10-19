import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { RoomClient, type RoomInfo, type RoomMessage, type RoomState } from "./room-client";

const tagName = "sonic-p2p";

export type P2pState = RoomState & {
  /** Salons visibles (liste publique de l'artefact), après `refresh`. */
  rooms: RoomInfo[];
  /** Compteur de messages reçus. */
  received: number;
};

type Command = { n?: number; type?: string; [k: string]: unknown };
type StoreLike = { dispatchAction(action: { type: string; payload?: unknown }): void };

/**
 * Salons de partage temps réel entre visiteurs d'un artefact (jeux, tableau blanc…).
 *
 * - `share` (DP) : la valeur locale est diffusée aux autres (au plus `rate` fois par seconde, la plus
 *   récente l'emporte). Les valeurs des autres arrivent dans `<id>Peers` : `{ <idMembre>: valeur }`.
 * - `control` (DP) : `{ cmd: { n: compteur, type, … } }`, une commande à chaque hausse de `n` :
 *   `refresh` · `create {name, access, code, listed, max}` · `join {roomId, code}` · `leave` ·
 *   `approve {id}` · `reject {id}` · `kick {id}` · `send {data}`.
 * - État `<id>State` : `{ status, error, rooms, room, me, members, pending, received }`.
 * - `message-action` + `store` : chaque message reçu devient `{ type, payload: { from, pseudo, data } }`.
 */
@customElement(tagName)
export class SonicP2p extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Origine de l'API (vide : même origine). */
  @property({ type: String }) api = "";
  /** Slug de l'artefact. */
  @property({ type: String }) artifact = "";
  @property({ type: String, attribute: "link-token" }) linkToken = "";
  @property({ type: String }) pseudo = "";
  @property({ type: String }) share = "";
  @property({ type: Number }) rate = 20;
  @property({ type: String }) control = "";
  @property({ type: String }) store = "";
  @property({ type: String, attribute: "message-action" }) messageAction = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: String, attribute: "peers-data-provider" }) peersDataProvider = "";

  private client: RoomClient | null = null;
  private offs: (() => void)[] = [];
  private unsubShare: (() => void) | null = null;
  private unsubControl: (() => void) | null = null;
  private lastCmd: number | undefined;
  private rooms: RoomInfo[] = [];
  private peers: Record<string, unknown> = {};
  private received = 0;
  private lastSent = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingShare: { v: unknown } | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.publishState();
    this.publishPeers();
  }

  disconnectedCallback(): void {
    this.unsubShare?.();
    this.unsubControl?.();
    this.unsubShare = this.unsubControl = null;
    this.offs.forEach((o) => o());
    this.offs = [];
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.client?.close();
    this.client = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("api") || changed.has("artifact") || changed.has("linkToken")) this.resetClient();
    if (changed.has("share")) {
      this.unsubShare?.();
      this.unsubShare = this.share ? listenDp(this.share, (v) => this.queueShare(v)) : null;
    }
    if (changed.has("control")) {
      this.unsubControl?.();
      this.lastCmd = undefined;
      this.unsubControl = this.control
        ? listenDp(this.control, (v) => {
            const cmd = (v as { cmd?: Command } | null)?.cmd;
            if (!cmd || typeof cmd.n !== "number") return;
            const prev = this.lastCmd;
            this.lastCmd = cmd.n;
            // La première valeur lue (état initial) n'est pas une commande.
            if (prev !== undefined && cmd.n > prev) void this.run(cmd);
          })
        : null;
    }
  }

  getState(): P2pState {
    const base = this.client?.state ?? { status: "idle", error: "", room: null, me: null, members: [], pending: [] };
    return plain<P2pState>({ ...base, rooms: this.rooms, received: this.received });
  }

  /** Exécute une commande (public pour les tests et les composants voisins). */
  async run(cmd: Command): Promise<void> {
    const c = this.ensureClient();
    if (!c) return;
    const pseudo = str(cmd.pseudo) || this.pseudo;
    this.errorOverride = "";
    try {
      switch (cmd.type) {
        case "refresh":
          this.rooms = await c.listRooms();
          this.publishState();
          break;
        case "create":
          await c.create({
            name: str(cmd.name),
            pseudo,
            access: cmd.access === "approval" ? "approval" : "open",
            code: typeof cmd.code === "boolean" || typeof cmd.code === "string" ? cmd.code : undefined,
            listed: typeof cmd.listed === "boolean" ? cmd.listed : undefined,
            max: typeof cmd.max === "number" ? cmd.max : undefined,
          });
          break;
        case "join":
          await c.join({ pseudo, roomId: str(cmd.roomId) || undefined, code: str(cmd.code) || undefined });
          break;
        case "leave":
          await c.leave();
          this.peers = {};
          this.publishPeers();
          break;
        case "approve":
        case "reject":
          await c.decide(str(cmd.id), cmd.type === "approve");
          break;
        case "kick":
          await c.kick(str(cmd.id));
          break;
        case "send":
          await c.send(cmd.data);
          break;
      }
    } catch (e) {
      // L'erreur est visible dans l'état (`error`), sans casser la page.
      const err = e instanceof Error ? e.message : String(e);
      this.errorOverride = err;
      this.publishState();
    }
  }

  private errorOverride = "";

  private ensureClient(): RoomClient | null {
    if (this.client) return this.client;
    if (!this.artifact || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(this.artifact)) {
      this.errorOverride = "attribut artifact manquant ou invalide";
      this.publishState();
      return null;
    }
    if (this.api && !/^https?:\/\//i.test(this.api)) {
      this.errorOverride = "attribut api : URL http(s) attendue";
      this.publishState();
      return null;
    }
    this.errorOverride = "";
    const c = new RoomClient({ api: this.api, artifact: this.artifact, linkToken: this.linkToken || undefined });
    this.offs.push(
      c.onState((s) => {
        if (s.status !== "ready") this.peers = {};
        else this.prunePeers(s);
        this.publishState();
        this.publishPeers();
      }),
      c.onMessage((m) => this.onMessage(m)),
    );
    this.client = c;
    return c;
  }

  private resetClient(): void {
    this.client?.close();
    this.offs.forEach((o) => o());
    this.offs = [];
    this.client = null;
    this.peers = {};
    this.publishState();
    this.publishPeers();
  }

  private prunePeers(s: RoomState): void {
    const ids = new Set(s.members.map((m) => m.id));
    for (const id of Object.keys(this.peers)) if (!ids.has(id)) delete this.peers[id];
  }

  private onMessage(m: RoomMessage): void {
    this.received += 1;
    // Message de partage d'état (`share`) : enveloppe { s: valeur } ; autre : message libre.
    const d = m.data as { s?: unknown } | null;
    if (d && typeof d === "object" && !Array.isArray(d) && "s" in d && Object.keys(d).length === 1) {
      this.peers[m.from] = d.s;
      this.publishPeers();
    }
    if (this.store && this.messageAction) {
      const id = this.store.replace(/^#/, "");
      const root = this.getRootNode() as Document | ShadowRoot;
      const el = (root.getElementById?.(id) ?? document.getElementById(id)) as (Element & StoreLike) | null;
      if (el && typeof el.dispatchAction === "function") el.dispatchAction({ type: this.messageAction, payload: { from: m.from, pseudo: m.pseudo, data: d && typeof d === "object" && "s" in d ? (d as { s: unknown }).s : m.data } });
    }
    this.publishState();
  }

  /** Valeur locale à partager : au plus `rate` envois par seconde, la plus récente gagne. */
  private queueShare(v: unknown): void {
    if (this.client?.state.status !== "ready") return;
    this.pendingShare = { v };
    if (this.sendTimer) return;
    const gap = 1000 / Math.max(1, Math.min(60, this.rate));
    const wait = Math.max(0, this.lastSent + gap - Date.now());
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      const p = this.pendingShare;
      this.pendingShare = null;
      if (!p) return;
      this.lastSent = Date.now();
      void this.client?.send({ s: p.v }, { coalesce: true }).catch(() => undefined);
    }, wait);
  }

  private publishState(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    const st = this.getState();
    if (this.errorOverride && !st.error) st.error = this.errorOverride;
    set(out, st);
  }

  private publishPeers(): void {
    const out = (this.peersDataProvider || (this.id ? `${this.id}Peers` : "")).trim();
    if (!out) return;
    // Publication groupée : plusieurs messages dans le même tick = une seule écriture.
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      set(out, plain({ ...this.peers }));
    }, 0);
  }

  render() {
    return html``;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export default SonicP2p;
