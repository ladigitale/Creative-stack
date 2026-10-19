/**
 * Client des salons Artefacts (API Tadaaa `/api/public/artifacts/{slug}/rooms` + hub Mercure).
 * Sans interface : le composant `sonic-p2p` s'appuie dessus, mais il se teste et s'utilise seul.
 *
 * - Plan de contrôle : REST (créer, lister, rejoindre, accepter, exclure, renouveler, quitter).
 * - Plan de données : les participants publient directement sur le hub avec un JWT limité au
 *   topic `data` du salon, et lisent par SSE (EventSource) avec le même jeton.
 */

export type RoomInfo = { id: string; name: string; access: "open" | "approval"; hasCode: boolean; members: number; max: number; full: boolean; code?: string };
export type Member = { id: string; pseudo: string; host: boolean; status?: string };
export type MercureCreds = {
  hubUrl: string;
  token: string;
  expiresIn: number;
  topics: { member: string; data?: string; ctl?: string; host?: string };
};
export type RoomStatus = "idle" | "connecting" | "pending" | "ready" | "rejected" | "kicked" | "closed" | "error";

export type RoomState = {
  status: RoomStatus;
  error: string;
  room: RoomInfo | null;
  me: Member | null;
  members: Member[];
  /** Demandes d'entrée en attente (hôte d'un salon sur approbation). */
  pending: Member[];
};

export type RoomMessage = { from: string; pseudo: string; data: unknown };

export type RoomClientOptions = {
  /** Origine de l'API (ex. `https://api.tadaaa.space`) ; vide = même origine. */
  api?: string;
  /** Slug de l'artefact. */
  artifact: string;
  /** Jeton de lien `?k=` d'un artefact « lien secret ». */
  linkToken?: string;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
  /** Délai de reconnexion SSE (ms), doublé jusqu'à 15 s. */
  retryMs?: number;
};

type Listener<T> = (value: T) => void;

/** Erreur API : `code` = statut HTTP, `message` = détail renvoyé par le serveur. */
export class RoomApiError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const MAX_RENEW_MS = 4 * 60_000;

export class RoomClient {
  state: RoomState = emptyState();
  private opts: RoomClientOptions;
  private f: typeof fetch;
  private ES: typeof EventSource | undefined;
  private creds: MercureCreds | null = null;
  private key = "";
  private source: EventSource | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private closed = false;
  private inflight = false;
  private queued: unknown;
  private hasQueued = false;
  private stateListeners = new Set<Listener<RoomState>>();
  private messageListeners = new Set<Listener<RoomMessage>>();

  constructor(opts: RoomClientOptions) {
    this.opts = opts;
    this.f = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.ES = opts.EventSource ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
  }

  onState(fn: Listener<RoomState>): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  onMessage(fn: Listener<RoomMessage>): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  // ───────────── plan de contrôle ─────────────

  async listRooms(): Promise<RoomInfo[]> {
    const res = await this.call("GET", "");
    const rows = Array.isArray(res) ? res : (res as { member?: unknown; rooms?: unknown }).member ?? (res as { rooms?: unknown }).rooms ?? [];
    return Array.isArray(rows) ? (rows as RoomInfo[]) : [];
  }

  async create(input: { name: string; pseudo: string; access?: "open" | "approval"; code?: string | boolean; listed?: boolean; max?: number }): Promise<RoomInfo> {
    this.leaveLocal();
    this.setState({ ...emptyState(), status: "connecting" });
    try {
      const res = (await this.call("POST", "", clean(input))) as Join;
      return await this.enter(res);
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }

  async join(input: { pseudo: string; roomId?: string; code?: string }): Promise<RoomState> {
    this.leaveLocal();
    this.setState({ ...emptyState(), status: "connecting" });
    try {
      const res = (await this.call("POST", "/join", clean(input))) as Join;
      await this.enter(res);
      return this.state;
    } catch (e) {
      this.fail(e);
      return this.state;
    }
  }

  async decide(targetId: string, accept: boolean): Promise<void> {
    await this.authed("/requests", { targetId, accept });
    this.setState({ ...this.state, pending: this.state.pending.filter((m) => m.id !== targetId) });
  }

  async kick(targetId: string): Promise<void> {
    await this.authed("/kick", { targetId });
  }

  async leave(): Promise<void> {
    const had = this.state.room && this.state.me;
    if (had) await this.authed("/leave", {}).catch(() => undefined);
    this.leaveLocal();
    this.setState(emptyState());
  }

  /** Arrête les connexions locales (sans prévenir le serveur : il purge les inactifs). */
  close(): void {
    this.leaveLocal();
    this.closed = true;
  }

  // ───────────── plan de données ─────────────

  /**
   * Publie un message JSON aux autres participants. Avec `coalesce`, un seul envoi est en vol :
   * les valeurs arrivées entre-temps sont remplacées par la plus récente (synchronisation d'état).
   */
  async send(data: unknown, opts: { coalesce?: boolean } = {}): Promise<void> {
    if (this.state.status !== "ready" || !this.creds?.topics.data || !this.state.me) return;
    if (opts.coalesce && this.inflight) {
      this.queued = data;
      this.hasQueued = true;
      return;
    }
    this.inflight = true;
    try {
      await this.publish(data);
    } finally {
      this.inflight = false;
      if (this.hasQueued) {
        const next = this.queued;
        this.hasQueued = false;
        this.queued = undefined;
        void this.send(next, { coalesce: true });
      }
    }
  }

  private async publish(data: unknown): Promise<void> {
    const c = this.creds!;
    const body = new URLSearchParams({ topic: c.topics.data!, data: JSON.stringify({ f: this.state.me!.id, d: data }), private: "on" });
    const res = await this.f(c.hubUrl, { method: "POST", headers: { Authorization: `Bearer ${c.token}` }, body });
    if (res.status === 401 || res.status === 403) {
      await this.renew();
      const again = await this.f(this.creds!.hubUrl, { method: "POST", headers: { Authorization: `Bearer ${this.creds!.token}` }, body });
      if (!again.ok) throw new RoomApiError(again.status, "publish refused");
    } else if (!res.ok) {
      throw new RoomApiError(res.status, "publish failed");
    }
  }

  // ───────────── interne ─────────────

  private url(path: string): string {
    const base = (this.opts.api ?? "").replace(/\/+$/, "");
    const q = this.opts.linkToken ? `?k=${encodeURIComponent(this.opts.linkToken)}` : "";
    return `${base}/api/public/artifacts/${encodeURIComponent(this.opts.artifact)}/rooms${path}${q}`;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await this.f(this.url(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* corps vide ou non JSON */
    }
    if (!res.ok) {
      const j = json as { detail?: string; message?: string; title?: string } | null;
      throw new RoomApiError(res.status, j?.detail ?? j?.message ?? j?.title ?? `HTTP ${res.status}`);
    }
    return json;
  }

  private async authed(path: string, extra: Record<string, unknown>): Promise<unknown> {
    const { room, me } = this.state;
    if (!room || !me) throw new RoomApiError(400, "not in a room");
    return this.call("POST", `/${room.id}${path}`, { memberId: me.id, key: this.key, ...extra });
  }

  private async enter(res: Join): Promise<RoomInfo> {
    this.key = res.member.key;
    this.creds = res.mercure;
    this.state = {
      status: res.status === "pending" ? "pending" : "ready",
      error: "",
      room: res.room,
      me: { id: res.member.id, pseudo: res.member.pseudo, host: res.member.host, status: res.status },
      members: res.members ?? [],
      pending: [],
    };
    this.closed = false;
    this.subscribe();
    this.scheduleRenew();
    this.emit();
    return res.room;
  }

  private subscribe(): void {
    this.source?.close();
    this.source = null;
    const c = this.creds;
    if (!c || !this.ES) return;
    const u = new URL(c.hubUrl, globalThis.location?.href);
    for (const t of [c.topics.member, c.topics.data, c.topics.ctl, c.topics.host]) if (t) u.searchParams.append("topic", t);
    u.searchParams.set("authorization", c.token);
    const es = new this.ES(u.toString());
    this.source = es;
    es.onopen = () => {
      this.retry = 0;
    };
    es.onmessage = (ev) => this.onEvent(ev as MessageEvent<string>);
    es.onerror = () => {
      // Jeton expiré : EventSource abandonne (CLOSED) → on se reconnecte avec un jeton frais.
      if (es.readyState === 2 && !this.closed && this.source === es) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const delay = Math.min(15_000, (this.opts.retryMs ?? 500) * 2 ** this.retry++);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        await this.renew();
      } catch (e) {
        if (e instanceof RoomApiError && (e.code === 403 || e.code === 404)) {
          this.setState({ ...this.state, status: "kicked", error: e.message });
          this.leaveLocal();
          return;
        }
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async renew(): Promise<void> {
    const { room, me } = this.state;
    if (!room || !me) return;
    const res = (await this.authed("/token", {})) as { status: string; room?: RoomInfo; mercure: MercureCreds; members?: Member[] };
    const wasPending = this.state.status === "pending";
    this.creds = res.mercure;
    const nowActive = res.status === "active";
    this.state = {
      ...this.state,
      room: res.room ?? room,
      members: res.members ?? this.state.members,
      status: nowActive ? "ready" : "pending",
      me: { ...me, status: res.status },
    };
    // Passage pending → actif : nouveaux topics ; sinon on rouvre seulement si la connexion est tombée.
    if (wasPending !== (this.state.status === "pending") || !this.source || this.source.readyState === 2) this.subscribe();
    this.emit();
  }

  private scheduleRenew(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    const ms = Math.min(MAX_RENEW_MS, Math.max(5_000, (this.creds?.expiresIn ?? 300) * 800));
    this.renewTimer = setTimeout(async () => {
      this.renewTimer = null;
      if (this.closed) return;
      try {
        await this.renew();
      } catch (e) {
        if (e instanceof RoomApiError && (e.code === 403 || e.code === 404)) {
          this.setState({ ...this.state, status: e.code === 404 ? "closed" : "kicked", error: e.message });
          this.leaveLocal();
          return;
        }
      }
      if (!this.closed) this.scheduleRenew();
    }, ms);
  }

  private onEvent(ev: MessageEvent<string>): void {
    let msg: unknown;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "roster": {
        const members = Array.isArray(m.members) ? (m.members as Member[]) : [];
        const room = this.state.room ? { ...this.state.room, members: members.length, full: members.length >= this.state.room.max } : null;
        this.setState({ ...this.state, members, room });
        return;
      }
      case "join-request": {
        const who = m.member as Member | undefined;
        if (who?.id && !this.state.pending.some((p) => p.id === who.id)) this.setState({ ...this.state, pending: [...this.state.pending, who] });
        return;
      }
      case "approved":
        void this.renew().catch((e) => this.fail(e));
        return;
      case "rejected":
        this.finish("rejected");
        return;
      case "kicked":
        if (typeof m.member === "string" && m.member !== this.state.me?.id) return;
        this.finish("kicked");
        return;
      case "closed":
        this.finish("closed");
        return;
    }
    // Message de données : { f: id de l'émetteur, d: charge utile }.
    if (typeof m.f === "string" && "d" in m) {
      if (m.f === this.state.me?.id) return;
      const pseudo = this.state.members.find((x) => x.id === m.f)?.pseudo ?? "";
      for (const l of this.messageListeners) l({ from: m.f, pseudo, data: m.d });
    }
  }

  private finish(status: RoomStatus): void {
    this.leaveLocal();
    this.setState({ ...this.state, status, pending: [] });
  }

  private leaveLocal(): void {
    this.source?.close();
    this.source = null;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.renewTimer = this.retryTimer = null;
    this.creds = null;
    this.key = "";
    this.hasQueued = false;
    this.queued = undefined;
    this.closed = true;
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.leaveLocal();
    this.setState({ ...emptyState(), status: "error", error: message });
  }

  private setState(s: RoomState): void {
    this.state = s;
    this.emit();
  }

  private emit(): void {
    for (const l of this.stateListeners) l(this.state);
  }
}

type Join = { status: "active" | "pending"; room: RoomInfo; member: Member & { key: string }; mercure: MercureCreds; members?: Member[] };

function emptyState(): RoomState {
  return { status: "idle", error: "", room: null, me: null, members: [], pending: [] };
}

function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}
