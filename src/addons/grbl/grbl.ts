import { customElement, property } from "lit/decorators.js";
import { DeviceElement, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { isBytePipe, type SonicBytePipe } from "../../shared/pipe/pipe";
import { sleep } from "../../shared/pipe/queue";
import { analyzeGcode, checkLine, cleanLine, num, prepareJob, RT, type GcodeStats, type GrblMessage, type GrblReport, type Vec3 } from "./codec";
import { dryRunLines, frameLines, resumeHint, resumeLines } from "./jobs";
import { GrblLink, type JobEnd } from "./link";
import { getMachine, isGcodeSource, MACHINES, type MachineProfile } from "./machines";

const tagName = "sonic-grbl";

const CONSOLE_LINES = 30;
/** Texte G-code au plus pour une tâche passée en argument (`run {gcode}`). */
const MAX_GCODE_CHARS = 20_000_000;
/** Puissance maximale du cadrage faisceau allumé, en %. */
const MAX_FRAME_POWER = 5;
/** Pointeur (focus, visée) : faisceau allumé sur place, très faible, éteint seul au bout de quelques secondes. */
const MAX_POINTER_POWER = 2;
const MAX_POINTER_S = 30;
const MAX_JOG_MM = 1000;

export type GrblJob = {
  /** `job` : gravure ; `dry` : essai à vide (mêmes mouvements, faisceau coupé) ; `frame` : tour de l'emprise. */
  kind: "job" | "frame" | "dry";
  /** Ligne du programme (préparé) où la tâche a commencé : 0, ou la ligne de reprise. */
  from: number;
  /** Lignes du programme préparé (sans le préambule de reprise). */
  total: number;
  /** Dernière ligne du programme entrée dans le planificateur de GRBL. */
  line: number;
  lines: number;
  sent: number;
  acked: number;
  /** 0..1, d'après les lignes acquittées (GRBL acquitte une ligne quand elle entre dans son planificateur). */
  progress: number;
  running: boolean;
  paused: boolean;
  elapsedS: number;
  estimateS: number;
  bbox: GcodeStats["bbox"];
};

export type GrblState = DeviceBaseState & {
  /** GRBL a répondu sur le transport. */
  connected: boolean;
  firmware: string | null;
  machine: string;
  /** `Idle`, `Run`, `Hold`, `Jog`, `Alarm`, `Door`, `Check`, `Home`, `Sleep`, ou `unknown`. */
  machineState: string;
  alarm: { code: number; message: string } | null;
  /** Position de travail (relative à l'origine posée), en mm. */
  pos: { x: number; y: number; z: number };
  /** Position machine. */
  mpos: { x: number; y: number; z: number };
  feed: number;
  /** Puissance en cours (valeur S). */
  power: number;
  /** Zone de travail en mm ; `null` si inconnue. */
  area: { x: number; y: number } | null;
  /** Valeur S de pleine puissance (`$30`). */
  maxS: number;
  /** `$32` : le faisceau suit la vitesse et se coupe à l'arrêt. `null` tant que les réglages ne sont pas lus. */
  laserMode: boolean | null;
  homing: boolean | null;
  /** Réglages lus (`$$`) : `{ "30": 1000, "32": 1, "130": 410… }`. */
  settings: Record<string, number>;
  job: GrblJob | null;
  /**
   * Dernière gravure ou dernier essai interrompu (arrêt, erreur, alarme) : `line` = dernière ligne acquittée,
   * `resumeAt` = ligne de reprise conseillée (`run: {n, from: resumeAt}`), `null` après une tâche menée au bout.
   */
  lastStop: { kind: "job" | "dry"; line: number; resumeAt: number; total: number; reason: string } | null;
  /** Pointeur allumé (faisceau faible sur place, pour le focus et la visée) : puissance en %, ou `null`. */
  pointer: number | null;
  /** Tâches terminées (utilisable comme `trigger`). */
  jobs: number;
  /** Remarques adressées à l'auteur du document ou à l'utilisateur. */
  issues: string[];
  /** Dernières lignes échangées (hors rapports d'état et lignes de tâche) : `> $I`, `< [VER:…]`. */
  console: string[];
};

type WakeLockSentinelLike = { release(): Promise<void> };

const xyz = (v: Vec3): { x: number; y: number; z: number } => ({ x: v[0], y: v[1], z: v[2] });

/**
 * Machine GRBL (graveur ou découpeuse laser, traceur à stylo) derrière un `sonic-serial` : état en direct,
 * déplacements manuels, cadrage, envoi d'un programme G-code en flux, pause, reprise, arrêt.
 *
 * - `transport="#port"` : le `sonic-serial` (profil `ch340` ou `grbl`, 115200 bauds).
 * - `source="#gcode"` : un `sonic-gcode` (ou tout élément `getGcode()`), programme lancé par `run`.
 * - `machine` : `auto` (réglages lus sur la machine) ou `atomstack-a5-pro`.
 * - `tool` : `laser` (défaut) ou `pen`. En `laser`, M3 est remplacé par M4 et une machine dont le mode laser
 *   est coupé (`$32=0`) est refusée : le faisceau ne s'éteindrait pas à l'arrêt.
 * - `control` (DP) : `{ run: n | {n, gcode}, hold: n, resume: n, stop: n, frame: n | {n, power, feed},
 *   jog: {n, x, y, feed}, goto: {n, x, y, feed}, jogCancel: n, setOrigin: n, clearOrigin: n, home: n,
 *   unlock: n, reset: n, refresh: n, send: {n, line} }`.
 * - État `<id>State` : machine (machineState, pos, alarm, area, maxS, laserMode), tâche (job, jobs), `console`.
 *
 * `run` et le cadrage faisceau allumé exigent un geste de l'utilisateur : jamais de tir lancé par un minuteur.
 * À la fermeture de la page ou au retrait du composant pendant une tâche, la machine est arrêtée.
 */
@customElement(tagName)
export class SonicGrbl extends DeviceElement<GrblState> {
  @property({ type: String }) transport = "";
  @property({ type: String }) source = "";
  @property({ type: String }) machine = "auto";
  @property({ type: String }) tool = "laser";
  /** Plafond de puissance en % de la pleine puissance (100 : pas de plafond). */
  @property({ type: Number, attribute: "max-power" }) maxPower = 100;
  /** Autorise l'écriture de réglages (`$n=valeur`) par la commande `send`. */
  @property({ type: Boolean, attribute: "allow-settings" }) allowSettings = false;
  /** Période d'interrogation de l'état, en ms. */
  @property({ type: Number, attribute: "poll-ms" }) pollMs = 250;
  /** Facteur des délais du protocole (1 ; 0 dans les tests). */
  @property({ type: Number, attribute: "time-scale" }) timeScale = 1;

  protected feature = null;
  protected readonly defaultCommand = "run";
  protected state: GrblState = this.initial();

  private pipe: SonicBytePipe | null = null;
  private link: GrblLink | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private transportKey = "";
  private lastPoll = 0;
  private wco: Vec3 = [0, 0, 0];
  private welcome: (() => void) | null = null;
  private stopping = false;
  private jobStart = 0;
  private wakeLock: WakeLockSentinelLike | null = null;
  private log: string[] = [];
  /** Dernier rapport : pause terminée (`Hold:0`), mouvement arrêté. */
  private holdDone = false;

  private initial(): GrblState {
    const profile = this.profile();
    return {
      status: "idle", error: null, supported: true, allowed: "unknown", active: false,
      connected: false, firmware: null, machine: getMachine(this.machine) ? this.machine : "auto", machineState: "unknown", alarm: null,
      pos: { x: 0, y: 0, z: 0 }, mpos: { x: 0, y: 0, z: 0 }, feed: 0, power: 0,
      area: profile.area ? { x: profile.area[0], y: profile.area[1] } : null, maxS: profile.maxS, laserMode: null, homing: null,
      settings: {}, job: null, lastStop: null, pointer: null, jobs: 0, issues: [], console: [],
    };
  }

  private profile(): MachineProfile {
    return getMachine(this.machine) ?? MACHINES.auto;
  }

  protected commands(): CommandMap {
    return {
      run: (a) => this.runJob(a, a.dry === true ? "dry" : "job"),
      dryRun: (a) => this.runJob(a, "dry"),
      frame: (a) => this.runJob(a, "frame"),
      hold: () => this.hold(),
      resume: () => this.resume(),
      stop: () => this.stop(),
      jog: (a) => this.jog(a, false),
      goto: (a) => this.jog(a, true),
      jogCancel: () => this.realtime(RT.JOG_CANCEL),
      pointer: (a) => this.pointer(a),
      setOrigin: () => this.simple("G92X0Y0"),
      clearOrigin: () => this.simple("G92.1"),
      home: () => this.home(),
      unlock: () => this.simple("$X"),
      reset: () => this.reset(),
      refresh: () => this.refresh(),
      send: (a) => this.sendLine(a),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.patch(this.initial());
    this.watch = setInterval(() => this.tick(), 100);
    window.addEventListener("pagehide", this.emergency);
  }

  disconnectedCallback(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    window.removeEventListener("pagehide", this.emergency);
    this.emergency();
    this.detach();
    super.disconnectedCallback();
  }

  /** Page fermée ou composant retiré pendant une tâche : arrêt immédiat (la position peut être perdue). */
  private emergency = (): void => {
    // Pointeur allumé : la réinitialisation coupe le faisceau.
    if (this.state.pointer !== null) this.link?.realtime(RT.RESET);
    const link = this.link;
    if (!link || !link.busy) return;
    link.stopFeeding();
    link.realtime(RT.HOLD);
    link.realtime(RT.RESET);
    this.releaseWakeLock();
  };

  // ─── Transport ────────────────────────────────────────────────────────────────────────────────────────────────
  private byId(ref: string): Element | null {
    if (!ref.startsWith("#")) return null;
    const id = ref.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  private tick(): void {
    const el = this.byId(this.transport);
    const pipe = isBytePipe(el) ? el : null;
    const ready = !!pipe?.pipeReady;
    const key = `${pipe ? "1" : "0"}${ready ? "1" : "0"}`;
    if (key !== this.transportKey || (ready && pipe !== this.pipe)) {
      this.transportKey = key;
      if (ready && pipe) void this.attach(pipe);
      else {
        const hadJob = !!this.state.job;
        this.detach();
        this.patch({
          ...this.initial(), jobs: this.state.jobs,
          error: this.transport && !pipe ? "transport introuvable (transport=\"#id\" d'un sonic-serial)" : hadJob ? "transport déconnecté pendant la tâche" : null,
          status: hadJob ? "error" : "idle",
        });
      }
      return;
    }
    if (!this.link || !this.state.connected) return;
    const now = performance.now();
    if (now - this.lastPoll >= Math.max(100, this.pollMs)) {
      this.lastPoll = now;
      this.link.realtime(RT.STATUS);
    }
    const job = this.state.job;
    if (job?.running) {
      const elapsedS = Math.round((Date.now() - this.jobStart) / 1000);
      if (elapsedS !== job.elapsedS) this.patch({ job: { ...job, elapsedS } }, false);
    }
  }

  private detach(): void {
    const link = this.link;
    this.link = null;
    link?.close();
    this.pipe = null;
    this.welcome = null;
    this.stopping = false;
    this.releaseWakeLock();
  }

  private wait(ms: number): Promise<void> {
    return this.timeScale > 0 && ms > 0 ? sleep(ms * this.timeScale) : Promise.resolve();
  }

  /** Transport prêt : on attend le message d'accueil (l'ouverture du port redémarre la carte), puis on lit version et réglages. */
  private async attach(pipe: SonicBytePipe): Promise<void> {
    this.detach();
    this.pipe = pipe;
    this.log = [];
    this.wco = [0, 0, 0];
    const link = new GrblLink(pipe, (m, raw) => this.onMessage(m, raw), this.timeScale);
    this.link = link;
    this.patch({ ...this.initial(), jobs: this.state.jobs, status: "requesting" });
    await Promise.race([new Promise<void>((resolve) => (this.welcome = resolve)), this.wait(2500)]);
    this.welcome = null;
    if (this.link !== link) return;
    let ack = await this.command("$I", 3000);
    // Carte redémarrée pendant la question : on la repose.
    if (!ack.ok && ack.aborted && this.link === link && pipe.pipeReady) ack = await this.command("$I", 3000);
    if (this.link !== link) return;
    if (!ack.ok) {
      this.patch({ status: "error", active: false, connected: false, error: "aucune réponse GRBL : vérifier que la machine est allumée et le débit du port (115200)" });
      return;
    }
    await this.command("$$", 5000);
    if (this.link !== link) return;
    const issues: string[] = [];
    if (this.machine !== "auto" && !getMachine(this.machine)) issues.push(`machine inconnue : ${this.machine} (connues : ${Object.keys(MACHINES).join(", ")})`);
    if (this.tool === "laser" && this.state.laserMode === false) issues.push("mode laser désactivé ($32=0) : les tâches sont refusées, le faisceau ne se couperait pas à l'arrêt");
    if (this.state.laserMode === null) issues.push("réglages non lus : zone de travail et mode laser inconnus");
    this.patch({ status: "ready", active: true, connected: true, error: null, issues });
    link.realtime(RT.STATUS);
    this.emit("sonic-grbl-ready", { firmware: this.state.firmware });
  }

  private note(text: string): void {
    this.log.push(text.slice(0, 120));
    if (this.log.length > CONSOLE_LINES) this.log.splice(0, this.log.length - CONSOLE_LINES);
    this.patch({ console: [...this.log] }, false);
  }

  private command(text: string, timeoutMs?: number): ReturnType<GrblLink["command"]> {
    const link = this.link;
    if (!link) return Promise.resolve({ ok: false, message: "machine non connectée", aborted: true });
    this.note(`> ${text}`);
    return link.command(text, timeoutMs);
  }

  private realtime(byte: number): boolean {
    if (!this.link) return false;
    this.link.realtime(byte);
    return true;
  }

  // ─── Messages de la machine ───────────────────────────────────────────────────────────────────────────────────
  private onMessage(message: GrblMessage, raw: string): void {
    switch (message.type) {
      case "status":
        this.onReport(message.report);
        return;
      case "ok":
        return;
      case "welcome":
        this.note(`< ${raw}`);
        this.patch({ firmware: this.state.firmware ?? message.version, alarm: null });
        this.welcome?.();
        return;
      case "alarm":
        this.note(`< ${raw}`);
        this.link?.stopFeeding();
        this.patch({ alarm: { code: message.code, message: message.message }, machineState: "Alarm" });
        return;
      case "setting":
        this.onSetting(message.id, message.value);
        return;
      case "info":
        this.note(`< ${raw}`);
        if (message.tag === "VER") this.patch({ firmware: message.text.split(":")[0] || this.state.firmware });
        return;
      case "error":
        if (!this.link?.busy) this.note(`< ${raw} (${message.message})`);
        return;
      default:
        this.note(`< ${raw}`);
    }
  }

  private onReport(r: GrblReport): void {
    if (r.wco) this.wco = r.wco;
    this.holdDone = r.state === "Hold" && (r.sub === 0 || r.sub === null);
    const mpos: Vec3 | undefined = r.mpos ?? (r.wpos ? [r.wpos[0] + this.wco[0], r.wpos[1] + this.wco[1], r.wpos[2] + this.wco[2]] : undefined);
    const wpos: Vec3 | undefined = r.wpos ?? (r.mpos ? [r.mpos[0] - this.wco[0], r.mpos[1] - this.wco[1], r.mpos[2] - this.wco[2]] : undefined);
    const round = (v: Vec3): Vec3 => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];
    const partial: Partial<GrblState> = { machineState: r.state };
    if (mpos) partial.mpos = xyz(round(mpos));
    if (wpos) partial.pos = xyz(round(wpos));
    if (r.feed !== undefined) partial.feed = r.feed;
    if (r.power !== undefined) partial.power = r.power;
    if (r.state === "Alarm") partial.alarm = this.state.alarm ?? { code: 0, message: "machine en alarme : déverrouiller (unlock) ou prendre l'origine" };
    else if (this.state.alarm) partial.alarm = null;
    const job = this.state.job;
    if (job) {
      const paused = r.state === "Hold";
      if (paused !== job.paused) partial.job = { ...job, paused };
    }
    this.patch(partial, false);
  }

  private onSetting(id: number, value: number): void {
    const settings = { ...this.state.settings, [String(id)]: value };
    const partial: Partial<GrblState> = { settings };
    const profile = this.profile();
    if (id === 30 && value > 0) partial.maxS = value;
    if (id === 32) partial.laserMode = value === 1;
    if (id === 22) partial.homing = value === 1;
    // Zone de travail : celle du profil nommé s'il en a une, sinon celle annoncée par la machine.
    if ((id === 130 || id === 131) && !profile.area) {
      const x = settings["130"], y = settings["131"];
      if (x > 0 && y > 0) partial.area = { x, y };
    }
    this.patch(partial, false);
  }

  // ─── Commandes simples ────────────────────────────────────────────────────────────────────────────────────────
  private ready(): boolean {
    if (this.link && this.state.connected) return true;
    this.patch({ error: "machine non connectée" });
    return false;
  }

  private idle(what: string): boolean {
    if (!this.ready()) return false;
    if (this.link?.busy) {
      this.patch({ error: `${what} impossible pendant une tâche` });
      return false;
    }
    return true;
  }

  private async simple(line: string): Promise<boolean> {
    if (!this.idle(line)) return false;
    const ack = await this.command(line);
    this.patch({ error: ack.ok ? null : `${line} : ${ack.message}` });
    return ack.ok;
  }

  private async home(): Promise<boolean> {
    if (!this.idle("prise d'origine")) return false;
    if (this.state.homing !== true) {
      this.patch({ error: "cette machine n'a pas de prise d'origine ($22=0) : placer la tête à la main puis setOrigin" });
      return false;
    }
    const ack = await this.command("$H", 90_000);
    this.patch({ error: ack.ok ? null : `prise d'origine : ${ack.message}` });
    return ack.ok;
  }

  private async refresh(): Promise<boolean> {
    if (!this.idle("lecture des réglages")) return false;
    const ack = await this.command("$$", 5000);
    return ack.ok;
  }

  private reset(): boolean {
    if (!this.link) return false;
    this.link.stopFeeding();
    this.link.realtime(RT.RESET);
    this.link.reset("machine réinitialisée");
    return true;
  }

  private hold(): boolean {
    return this.realtime(RT.HOLD);
  }

  private resume(): boolean {
    return this.realtime(RT.RESUME);
  }

  private pointerTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Pointeur pour le focus et la visée : `pointer {n, on: true, power (0,1..2 %), seconds (1..30)}` allume le faisceau
   * sur place (M3 puissance constante, sans mouvement), `{on: false}` l'éteint. Geste de l'utilisateur requis ;
   * éteint de lui-même au bout de `seconds` (15 par défaut) et par toute autre commande, arrêt ou départ de la page.
   */
  private async pointer(arg: CommandArg): Promise<boolean> {
    const on = !(arg.on === false || arg.on === "false" || arg.on === 0 || arg.on === "0");
    if (!on) return this.pointerOff();
    if (!this.idle("pointeur")) return false;
    if (this.tool !== "laser") {
      this.patch({ error: "pointeur : réservé au laser" });
      return false;
    }
    if (!this.gesture()) {
      this.patch({ error: "geste de l'utilisateur requis pour allumer le faisceau" });
      return false;
    }
    const power = Math.min(MAX_POINTER_POWER, Math.max(0.1, Number(arg.power) || 1));
    const seconds = Math.min(MAX_POINTER_S, Math.max(1, Number(arg.seconds) || 15));
    const s = Math.max(1, Math.round((this.state.maxS * power) / 100));
    const a = await this.command(`M3S${s}`);
    const b = a.ok ? await this.command("G1F1000") : a;
    if (!a.ok || !b.ok) {
      await this.command("M5");
      const failed = (a.ok ? b : a) as { message?: string };
      this.patch({ error: `pointeur : ${failed.message ?? "refusé"}`, pointer: null });
      return false;
    }
    if (this.pointerTimer) clearTimeout(this.pointerTimer);
    this.pointerTimer = setTimeout(() => void this.pointerOff(), seconds * 1000);
    this.patch({ pointer: power, error: null });
    return true;
  }

  private async pointerOff(): Promise<boolean> {
    if (this.pointerTimer) clearTimeout(this.pointerTimer);
    this.pointerTimer = null;
    if (this.state.pointer === null) return true;
    this.patch({ pointer: null });
    if (!this.link) return true;
    const ack = await this.command("M5");
    return ack.ok;
  }

  /** Déplacement manuel, faisceau éteint : relatif (`jog {x, y}`) ou vers un point de travail (`goto {x, y}`). */
  private async jog(arg: CommandArg, absolute: boolean): Promise<boolean> {
    await this.pointerOff();
    if (!this.idle("déplacement manuel")) return false;
    const has = (k: string): boolean => arg[k] !== undefined && arg[k] !== null && arg[k] !== "" && Number.isFinite(Number(arg[k]));
    if (!has("x") && !has("y")) {
      this.patch({ error: "jog : x ou y attendu, en mm" });
      return false;
    }
    const clampMm = (v: number): number => Math.min(MAX_JOG_MM, Math.max(-MAX_JOG_MM, v));
    const maxFeed = Math.min(this.state.settings["110"] || 6000, this.state.settings["111"] || 6000);
    const feed = Math.min(maxFeed, Math.max(10, has("feed") ? Number(arg.feed) : 2000));
    let line = `$J=${absolute ? "G90" : "G91"}G21`;
    if (has("x")) line += `X${num(clampMm(Number(arg.x)))}`;
    if (has("y")) line += `Y${num(clampMm(Number(arg.y)))}`;
    line += `F${num(feed)}`;
    const ack = await this.command(line);
    this.patch({ error: ack.ok ? null : `déplacement : ${ack.message}` });
    return ack.ok;
  }

  /** Ligne libre (console) : vérifiée, M3 remplacé par M4 en mode laser. */
  private async sendLine(arg: CommandArg): Promise<boolean> {
    if (!this.idle("commande")) return false;
    let line = cleanLine(typeof arg.line === "string" ? arg.line : "");
    const refusal = checkLine(line, { settings: this.allowSettings });
    if (refusal) {
      this.patch({ error: `send : ${refusal}` });
      return false;
    }
    if (this.tool === "laser" && !line.startsWith("$")) line = line.replace(/M0*3(?!\d)/g, "M4");
    const ack = await this.command(line);
    this.patch({ error: ack.ok ? null : `${line} : ${ack.message}` });
    return ack.ok;
  }

  // ─── Tâches ───────────────────────────────────────────────────────────────────────────────────────────────────
  private gesture(): boolean {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return !activation || activation.isActive;
  }

  private program(arg: CommandArg): string | string[] | null {
    if (typeof arg.gcode === "string") return arg.gcode.length <= MAX_GCODE_CHARS ? arg.gcode : null;
    const src = this.byId(this.source);
    return isGcodeSource(src) ? src.getGcode() : null;
  }

  /** Lance le programme (`job`), son essai à vide (`dry`) ou le tour de son emprise (`frame`). */
  private async runJob(arg: CommandArg, kind: "job" | "frame" | "dry"): Promise<boolean> {
    await this.pointerOff();
    if (!this.idle(kind === "frame" ? "cadrage" : kind === "dry" ? "essai à vide" : "lancement")) return false;
    const link = this.link as GrblLink;
    const refuse = (error: string): boolean => {
      this.patch({ error });
      return false;
    };
    if (this.state.machineState !== "Idle") return refuse(`machine pas au repos (${this.state.machineState}) : attendre, ou déverrouiller après une alarme`);
    const laser = this.tool !== "pen";
    if (laser && kind === "job" && this.state.laserMode === false) return refuse("mode laser désactivé ($32=0) : tâche refusée, le faisceau ne se couperait pas à l'arrêt");
    const source = this.program(arg);
    if (!source) return refuse(this.source || typeof arg.gcode === "string" ? "programme vide ou pas encore prêt" : "aucun programme : source=\"#id\" d'un sonic-gcode, ou run {gcode}");
    const cap = this.maxPower > 0 && this.maxPower < 100 ? Math.round((this.state.maxS * this.maxPower) / 100) : 0;
    const prepared = prepareJob(source, { tool: laser ? "laser" : "pen", maxS: cap });
    if (prepared.error) return refuse(prepared.error);
    const stats = analyzeGcode(prepared.lines);
    const issues = [...prepared.issues];
    if (stats.inches) issues.push("programme en pouces (G20)");
    if (stats.maxS > this.state.maxS) issues.push(`puissance S${stats.maxS} au-dessus de la pleine puissance de la machine (S${this.state.maxS})`);
    const area = this.state.area;
    if (stats.bbox && area && !stats.relative) {
      const b = stats.bbox;
      const over = b.w > area.x + 0.01 || b.h > area.y + 0.01 || b.x + b.w > area.x + 0.01 || b.y + b.h > area.y + 0.01;
      if (over) {
        const text = `programme hors de la zone de travail (jusqu'à X${num(b.x + b.w)} Y${num(b.y + b.h)} pour ${area.x} × ${area.y} mm)`;
        if (this.profile().area) return refuse(text);
        issues.push(text);
      } else if (b.x < -0.01 || b.y < -0.01) issues.push("coordonnées négatives : le programme sort de la zone si l'origine est au coin de la machine");
    }

    let lines = prepared.lines;
    let from = 0, preamble = 0;
    if (kind === "frame") {
      if (!stats.bbox || stats.relative) return refuse("cadrage impossible : programme sans emprise connue (coordonnées relatives)");
      const power = Math.min(MAX_FRAME_POWER, Math.max(0, Number(arg.power) || 0));
      const feed = Math.min(6000, Math.max(100, Number(arg.feed) || 3000));
      const lit = laser && power > 0;
      const framed = frameLines(prepared.lines, { shape: arg.shape === "hull" ? "hull" : "box", feed, sValue: lit ? (this.state.maxS * power) / 100 : 0, loops: Number(arg.loops) || 1 });
      if (!framed) return refuse("cadrage impossible : rien à graver dans ce programme");
      lines = framed;
      if (lit && !this.gesture()) return refuse("geste de l'utilisateur requis pour allumer le faisceau");
    } else {
      if (!this.gesture()) return refuse(`geste de l'utilisateur requis pour lancer ${kind === "dry" ? "un essai" : "une tâche"}`);
      if (arg.from !== undefined && arg.from !== null && arg.from !== "") {
        const plan = resumeLines(prepared.lines, Number(arg.from));
        if (plan.error) return refuse(plan.error);
        from = Math.max(0, Math.floor(Number(arg.from)) || 0);
        preamble = plan.preamble;
        lines = plan.lines;
      }
      if (kind === "dry") {
        const before = lines.length;
        lines = dryRunLines(lines, Number(arg.speed) || 1);
        preamble += lines.length - before;
      }
    }
    // Fin de programme : faisceau coupé, puis une temporisation que GRBL n'acquitte qu'une fois tout exécuté.
    lines = [...lines, "M5", "G4P0.01"];

    this.stopping = false;
    this.jobStart = Date.now();
    const total = prepared.lines.length;
    const share = kind === "frame" ? 1 : Math.max(0, (total - from) / total);
    const job: GrblJob = { kind, from, total, line: from, lines: lines.length, sent: 0, acked: 0, progress: 0, running: true, paused: false, elapsedS: 0, estimateS: kind === "frame" ? 0 : Math.round(stats.estimateS * share), bbox: stats.bbox };
    this.patch({ job, error: null, issues });
    void this.requestWakeLock();
    const started = link.startJob(
      lines,
      (acked, sent) => {
        const current = this.state.job;
        if (current) {
          const line = current.kind === "frame" ? 0 : Math.min(current.total, Math.max(current.from, current.from + acked - preamble));
          this.patch({ job: { ...current, acked, sent, line, progress: Math.round((acked / current.lines) * 1000) / 1000 } }, false);
        }
      },
      (end) => void this.onJobEnd(link, kind, end),
    );
    if (!started) {
      this.patch({ job: null });
      return refuse("tâche déjà en cours");
    }
    this.emit("sonic-grbl-start", { kind, lines: lines.length });
    return true;
  }

  /** Arrêt avant la fin d'une gravure ou d'un essai : où reprendre. */
  private stopNote(reason: string): GrblState["lastStop"] {
    const job = this.state.job;
    if (!job || job.kind === "frame") return this.state.lastStop;
    return { kind: job.kind, line: job.line, resumeAt: Math.max(job.from, resumeHint(job.line)), total: job.total, reason };
  }

  private async onJobEnd(link: GrblLink, kind: "job" | "frame" | "dry", end: JobEnd): Promise<void> {
    if (this.link !== link) return;
    this.releaseWakeLock();
    if (this.stopping) return;
    if (!end) {
      this.patch({ job: null, lastStop: kind === "job" ? null : this.state.lastStop, jobs: this.state.jobs + (kind === "job" ? 1 : 0), error: null });
      this.emit("sonic-grbl-done", { kind });
      return;
    }
    // Erreur en cours de tâche : on arrête proprement ce que la machine a encore en tampon.
    const alarm = this.state.alarm;
    const lastStop = this.stopNote(alarm ? alarm.message : end.message);
    await this.halt(link);
    if (this.link !== link) return;
    const error = alarm ? `tâche interrompue : ${alarm.message}` : `tâche interrompue à la ligne ${end.line} : ${end.message}`;
    this.patch({ job: null, lastStop, error });
    this.emit("sonic-grbl-error", { kind, line: end.line, message: end.message });
  }

  /** Pause, attente de l'arrêt du mouvement, puis remise à zéro : la position est gardée. */
  private async halt(link: GrblLink): Promise<void> {
    link.stopFeeding();
    link.realtime(RT.HOLD);
    for (let i = 0; i < 40 && this.link === link; i++) {
      const s = this.state.machineState;
      if (s === "Idle" || s === "Alarm" || (s === "Hold" && this.holdDone)) break;
      link.realtime(RT.STATUS);
      await this.wait(100);
      if (this.timeScale <= 0) await Promise.resolve();
    }
    if (this.link !== link) return;
    link.realtime(RT.RESET);
    link.reset("tâche arrêtée");
  }

  async stop(): Promise<boolean> {
    const link = this.link;
    if (!link) return false;
    if (!link.busy) {
      link.realtime(RT.JOG_CANCEL);
      await this.pointerOff();
      return true;
    }
    this.stopping = true;
    const lastStop = this.stopNote("arrêt demandé");
    await this.halt(link);
    this.stopping = false;
    if (this.link !== link) return false;
    this.releaseWakeLock();
    this.patch({ job: null, lastStop, error: null });
    this.emit("sonic-grbl-stop", {});
    return true;
  }

  private async requestWakeLock(): Promise<void> {
    const api = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!api || this.wakeLock) return;
    try {
      const lock = await api.request("screen");
      if (this.state.job) this.wakeLock = lock;
      else void lock.release().catch(() => undefined);
    } catch {
      // Refusé (page cachée, politique) : la tâche continue, l'écran peut se mettre en veille.
    }
  }

  private releaseWakeLock(): void {
    const lock = this.wakeLock;
    this.wakeLock = null;
    void lock?.release().catch(() => undefined);
  }
}

export default SonicGrbl;
