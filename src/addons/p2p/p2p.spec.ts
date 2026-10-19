import { afterEach, describe, expect, it } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./p2p";
import type { SonicP2p, P2pState } from "./p2p";
import { RoomClient, RoomApiError } from "./room-client";

/** Hub et API factices : un EventSource qu'on alimente à la main, un fetch qui note les appels. */
class FakeES {
  static all: FakeES[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  close() {
    this.readyState = 2;
  }
  push(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

type Call = { url: string; method: string; body: unknown; auth?: string };
function fakeServer(routes: Record<string, (body: any) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const isForm = init.body instanceof URLSearchParams;
    const body = isForm ? Object.fromEntries((init.body as URLSearchParams).entries()) : init.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, method: init.method ?? "GET", body, auth });
    const key = `${init.method ?? "GET"} ${new URL(url, "http://x").pathname.replace(/\/rooms/, "/rooms").split("/rooms")[1] ?? url}`;
    const hit = routes[key] ?? routes[`${init.method} hub`];
    const r = hit ? hit(body) : { status: 404, json: { detail: "no route " + key } };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

const creds = (extra: Record<string, string> = {}) => ({
  hubUrl: "https://hub.test/.well-known/mercure",
  token: "jwt-1",
  expiresIn: 300,
  topics: { member: "t/member/me", data: "t/data", ctl: "t/ctl", ...extra },
});
const room = { id: "r1", name: "Salon", access: "open", hasCode: false, members: 1, max: 4, full: false };
const me = { id: "m1", pseudo: "Ana", host: true, status: "active" };

afterEach(() => {
  document.body.innerHTML = "";
  FakeES.all = [];
});

describe("RoomClient", () => {
  it("crée un salon, s'abonne aux topics, publie sur le hub avec le jeton, ignore son propre écho", async () => {
    const { f, calls } = fakeServer({
      "POST ": () => ({ status: 201, json: { room, member: { ...me, key: "k1" }, mercure: creds({ host: "t/host" }), members: [me] } }),
      "POST hub": () => ({ status: 204, json: null }),
    });
    const c = new RoomClient({ api: "https://api.test", artifact: "mon-jeu", fetch: f, EventSource: FakeES as unknown as typeof EventSource });
    const got: unknown[] = [];
    c.onMessage((m) => got.push(m));
    await c.create({ name: "Salon", pseudo: "Ana", code: true });
    expect(calls[0].url).toBe("https://api.test/api/public/artifacts/mon-jeu/rooms");
    expect(calls[0].body).toEqual({ name: "Salon", pseudo: "Ana", code: true });
    expect(c.state.status).toBe("ready");
    const u = new URL(FakeES.all[0].url);
    expect(u.searchParams.getAll("topic")).toEqual(["t/member/me", "t/data", "t/ctl", "t/host"]);
    expect(u.searchParams.get("authorization")).toBe("jwt-1");

    await c.send({ x: 1 });
    const pub = calls.find((x) => x.url.startsWith("https://hub.test"))!;
    expect(pub.auth).toBe("Bearer jwt-1");
    expect(pub.body).toMatchObject({ topic: "t/data", private: "on" });
    expect(JSON.parse((pub.body as { data: string }).data)).toEqual({ f: "m1", d: { x: 1 } });

    FakeES.all[0].push({ f: "m1", d: "écho" });
    FakeES.all[0].push({ f: "m2", d: "salut" });
    expect(got).toEqual([{ from: "m2", pseudo: "", data: "salut" }]);
    c.close();
  });

  it("salon sur approbation : file d'attente côté hôte, accord côté invité → jeton actif", async () => {
    const { f, calls } = fakeServer({
      "POST /join": () => ({ status: 202, json: { status: "pending", room, member: { id: "m2", pseudo: "Bob", host: false, status: "pending", key: "k2" }, mercure: { hubUrl: "https://hub.test/h", token: "p", expiresIn: 300, topics: { member: "t/member/m2" } }, members: [] } }),
      "POST /r1/token": () => ({ json: { status: "active", room, mercure: creds(), members: [me] } }),
    });
    const c = new RoomClient({ artifact: "mon-jeu", fetch: f, EventSource: FakeES as unknown as typeof EventSource });
    await c.join({ pseudo: "Bob", roomId: "r1" });
    expect(c.state.status).toBe("pending");
    expect(new URL(FakeES.all[0].url).searchParams.getAll("topic")).toEqual(["t/member/m2"]);
    await c.send("non"); // pas encore membre : rien n'est publié
    expect(calls.filter((x) => x.url.startsWith("https://hub")).length).toBe(0);
    FakeES.all[0].push({ type: "approved" });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.state.status).toBe("ready");
    expect(FakeES.all[1]).toBeDefined();
    expect(new URL(FakeES.all[1].url).searchParams.getAll("topic")).toContain("t/data");
    c.close();
  });

  it("rejet, exclusion et fermeture changent l'état et coupent la connexion", async () => {
    for (const [evt, status] of [[{ type: "rejected" }, "rejected"], [{ type: "kicked" }, "kicked"], [{ type: "closed" }, "closed"]] as const) {
      const { f } = fakeServer({ "POST /join": () => ({ json: { status: "active", room, member: { ...me, host: false, key: "k" }, mercure: creds(), members: [me] } }) });
      const c = new RoomClient({ artifact: "mon-jeu", fetch: f, EventSource: FakeES as unknown as typeof EventSource });
      await c.join({ pseudo: "Ana", code: "bakodu" });
      const es = FakeES.all[FakeES.all.length - 1];
      es.push(evt);
      expect(c.state.status).toBe(status);
      expect(es.readyState).toBe(2);
    }
  });

  it("une exclusion visant un autre membre est ignorée ; le roster met à jour la liste", async () => {
    const { f } = fakeServer({ "POST /join": () => ({ json: { status: "active", room, member: { ...me, key: "k" }, mercure: creds(), members: [me] } }) });
    const c = new RoomClient({ artifact: "mon-jeu", fetch: f, EventSource: FakeES as unknown as typeof EventSource });
    await c.join({ pseudo: "Ana" });
    FakeES.all[0].push({ type: "kicked", member: "autre" });
    expect(c.state.status).toBe("ready");
    FakeES.all[0].push({ type: "roster", members: [me, { id: "m2", pseudo: "Bob", host: false }] });
    expect(c.state.members.length).toBe(2);
    expect(c.state.room?.members).toBe(2);
    c.close();
  });

  it("erreur API : état error, exception propagée pour create, liste lue sous `member` ou `rooms`", async () => {
    const { f } = fakeServer({
      "POST ": () => ({ status: 409, json: { detail: "Ce code est déjà utilisé" } }),
      "GET ": () => ({ json: { member: [room] } }),
    });
    const c = new RoomClient({ artifact: "mon-jeu", fetch: f, EventSource: FakeES as unknown as typeof EventSource });
    await expect(c.create({ name: "x", pseudo: "Ana", code: "bakodu" })).rejects.toBeInstanceOf(RoomApiError);
    expect(c.state).toMatchObject({ status: "error", error: "Ce code est déjà utilisé" });
    expect(await c.listRooms()).toEqual([room]);
  });

  it("coalesce : un seul envoi en vol, la valeur la plus récente part ensuite", async () => {
    let release: (() => void) | undefined;
    const sent: unknown[] = [];
    const base = fakeServer({ "POST /join": () => ({ json: { status: "active", room, member: { ...me, key: "k" }, mercure: creds(), members: [me] } }) });
    const f = (async (url: string, init: RequestInit = {}) => {
      if (url.startsWith("https://hub")) {
        sent.push(JSON.parse((init.body as URLSearchParams).get("data")!).d);
        if (sent.length === 1) await new Promise<void>((r) => (release = r));
        return { ok: true, status: 204, json: async () => null } as Response;
      }
      return base.f(url, init);
    }) as unknown as typeof fetch;
    const c = new RoomClient({ artifact: "mon-jeu", fetch: f, EventSource: FakeES as unknown as typeof EventSource });
    await c.join({ pseudo: "Ana" });
    const first = c.send(1, { coalesce: true });
    await c.send(2, { coalesce: true });
    await c.send(3, { coalesce: true });
    release!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([1, 3]);
    c.close();
  });
});

describe("sonic-p2p", () => {
  it("commande create → état publié ; share diffusé ; valeurs des autres dans <id>Peers", async () => {
    const { f, calls } = fakeServer({
      "POST ": () => ({ status: 201, json: { room, member: { ...me, key: "k1" }, mercure: creds(), members: [me] } }),
      "POST hub": () => ({ status: 204, json: null }),
    });
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    const realFetch = globalThis.fetch;
    globalThis.fetch = f;
    try {
      document.body.innerHTML = `<sonic-p2p id="net" artifact="mon-jeu" api="https://api.test" pseudo="Ana" share="game.local" rate="60" control="net.ctl"></sonic-p2p>`;
      const el = document.querySelector("sonic-p2p") as SonicP2p;
      await el.updateComplete;
      expect((get("netState") as P2pState).status).toBe("idle");
      await el.run({ type: "create", name: "Salon" });
      expect((get("netState") as P2pState)).toMatchObject({ status: "ready", room: { id: "r1" }, me: { id: "m1" } });

      // Partage : la valeur locale part vers le hub ; l'écho d'un autre membre arrive dans Peers.
      const { set } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
      set("game.local", { x: 5 });
      await new Promise((r) => setTimeout(r, 40));
      const pub = calls.find((c) => c.url.startsWith("https://hub"));
      expect(JSON.parse((pub!.body as { data: string }).data).d).toEqual({ s: { x: 5 } });
      FakeES.all[0].push({ type: "roster", members: [me, { id: "m2", pseudo: "Bob", host: false }] });
      FakeES.all[0].push({ f: "m2", d: { s: { x: 9 } } });
      await new Promise((r) => setTimeout(r, 5));
      expect(get("netPeers")).toEqual({ m2: { x: 9 } });
      expect((get("netState") as P2pState).received).toBe(1);

      // Un membre qui part disparaît des pairs.
      FakeES.all[0].push({ type: "roster", members: [me] });
      await new Promise((r) => setTimeout(r, 5));
      expect(get("netPeers")).toEqual({});
    } finally {
      globalThis.fetch = realFetch;
      delete (globalThis as { EventSource?: unknown }).EventSource;
    }
  });

  it("artifact manquant : erreur lisible dans l'état, aucune requête", async () => {
    document.body.innerHTML = `<sonic-p2p id="bad"></sonic-p2p>`;
    const el = document.querySelector("sonic-p2p") as SonicP2p;
    await el.updateComplete;
    await el.run({ type: "refresh" });
    expect((get("badState") as P2pState).error).toMatch(/artifact/);
  });
});
