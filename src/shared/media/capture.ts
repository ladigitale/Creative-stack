/**
 * Accès caméra / micro : ouverture d'un flux, statuts standard, périphériques.
 * Aucune demande de permission au chargement : les composants n'appellent
 * `openStream` qu'après un geste (autostart) ou sur pilotage explicite.
 */

export type CaptureStatus = "idle" | "requesting" | "ready" | "paused" | "denied" | "error" | "unsupported";

export type MediaDeviceInfoLite = { id: string; label: string };

export function mediaDevicesAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";
}

/** Erreur getUserMedia → statut et message lisible (français, pour l'agent comme pour l'utilisateur). */
export function captureError(e: unknown, kind: "caméra" | "micro"): { status: CaptureStatus; error: string } {
  const name = (e as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { status: "denied", error: `accès ${kind === "caméra" ? "à la caméra" : "au micro"} refusé` };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { status: "error", error: `aucun${kind === "caméra" ? "e caméra" : " micro"} trouvé${kind === "caméra" ? "e" : ""}` };
    case "NotReadableError":
    case "TrackStartError":
      return { status: "error", error: `${kind} déjà utilisé${kind === "caméra" ? "e" : ""} par une autre application` };
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return { status: "error", error: `réglages ${kind === "caméra" ? "de caméra" : "de micro"} impossibles à satisfaire` };
    case "AbortError":
      return { status: "error", error: `ouverture ${kind === "caméra" ? "de la caméra" : "du micro"} interrompue` };
    default:
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function openStream(
  constraints: MediaStreamConstraints,
  kind: "caméra" | "micro",
): Promise<{ stream: MediaStream } | { status: CaptureStatus; error: string }> {
  if (!mediaDevicesAvailable()) {
    const secure = typeof window === "undefined" || window.isSecureContext !== false;
    return { status: "unsupported", error: secure ? `${kind} non disponible dans ce navigateur` : `${kind} : page non sécurisée (https requis)` };
  }
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(constraints) };
  } catch (e) {
    return captureError(e, kind);
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const t of stream?.getTracks() ?? []) {
    try {
      t.stop();
    } catch {
      /* déjà arrêtée */
    }
  }
}

/** Périphériques d'un type (libellés vides tant que la permission n'est pas accordée). */
export async function listDevices(kind: "videoinput" | "audioinput"): Promise<MediaDeviceInfoLite[]> {
  if (!mediaDevicesAvailable() || typeof navigator.mediaDevices.enumerateDevices !== "function") return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === kind)
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === "videoinput" ? "Caméra" : "Micro"} ${i + 1}` }));
  } catch {
    return [];
  }
}

const GESTURES = ["pointerdown", "keydown", "touchend"] as const;

/** Appelle `cb` au premier geste utilisateur sur la page. Retourne l'annulation. */
export function onFirstGesture(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  let done = false;
  const handler = () => {
    if (done) return;
    done = true;
    off();
    cb();
  };
  const off = () => {
    for (const ev of GESTURES) window.removeEventListener(ev, handler, { capture: true });
  };
  for (const ev of GESTURES) window.addEventListener(ev, handler, { capture: true, passive: true });
  return () => {
    done = true;
    off();
  };
}
