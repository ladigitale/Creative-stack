import HTML from "@supersoniks/concorde/core/utils/HTML";
import { PublisherManager } from "@supersoniks/concorde/utils";
import {
  CHANNEL_FORM_KEYS,
  OUT_PARAM_KEYS,
  channelFormValue,
  toNum,
} from "./helpers";

export type FormBindHost = {
  dataProvider: string;
  outDataProvider: string;
  formPublisher: ReturnType<typeof PublisherManager.get> | null;
  outPublisher: ReturnType<typeof PublisherManager.get> | null;
  channel0: string;
  channel1: string;
  channel2: string;
  channel3: string;
  param0: number;
  param1: number;
  param2: number;
  param3: number;
  remoteTarget: { x: number; y: number } | null;
  mouseVec: [number, number, number, number];
  mouse: boolean;
  hovering: boolean;
  runtime: { canvas: HTMLCanvasElement } | null;
  onFormMutation: () => void;
};

function resolveFormProviderId(host: FormBindHost & HTMLElement): string {
  const own = host.dataProvider?.trim();
  if (own) return own;
  return (
    HTML.getAncestorAttributeValue(host, "dataProvider") ||
    HTML.getAncestorAttributeValue(host, "formDataProvider") ||
    ""
  );
}

function unbindFormProvider(host: FormBindHost) {
  if (host.formPublisher) {
    host.formPublisher.offInternalMutation(host.onFormMutation);
    host.formPublisher = null;
  }
}

function bindFormProvider(host: FormBindHost & HTMLElement) {
  unbindFormProvider(host);
  const id = resolveFormProviderId(host);
  if (!id) return;
  host.formPublisher = PublisherManager.get(id);
  host.formPublisher.onInternalMutation(host.onFormMutation);
  host.onFormMutation();
}

function bindOutPublisher(host: FormBindHost & HTMLElement) {
  const id = host.outDataProvider?.trim() || resolveFormProviderId(host) || "";
  host.outPublisher = id ? PublisherManager.get(id) : null;
}

function applyFormParams(host: FormBindHost, data: Record<string, unknown>) {
  for (const key of CHANNEL_FORM_KEYS) {
    if (!(key in data)) continue;
    const next = channelFormValue(data[key]);
    if (next === undefined) continue;
    if (host[key] !== next) host[key] = next;
  }
  for (const key of OUT_PARAM_KEYS) {
    if (!(key in data)) continue;
    const n = toNum(data[key], NaN);
    if (!Number.isFinite(n)) continue;
    if (host[key] !== n) host[key] = n;
  }
  // targetX/Y (0–1, CSS top-left) → attracteur GPU ; hors plage = off
  if ("targetX" in data || "targetY" in data) {
    const tx = toNum(data.targetX, NaN);
    const ty = toNum(data.targetY, NaN);
    if (
      Number.isFinite(tx) &&
      Number.isFinite(ty) &&
      tx >= 0 &&
      tx <= 1 &&
      ty >= 0 &&
      ty <= 1
    ) {
      host.remoteTarget = { x: tx, y: ty };
      applyRemoteMouse(host);
    } else {
      host.remoteTarget = null;
      host.mouseVec[0] = 0;
      host.mouseVec[1] = 0;
    }
  }
}

/** Convertit target normalisé → coords buffer (origine bas-gauche, comme le pointeur). */
function applyRemoteMouse(host: FormBindHost) {
  if (!host.remoteTarget || !host.runtime) return;
  // Pendant un hover pointeur, le doigt / souris gagne
  if (host.mouse && host.hovering) return;
  const w = host.runtime.canvas.width;
  const h = host.runtime.canvas.height;
  if (w < 2 || h < 2) return;
  host.mouseVec[0] = host.remoteTarget.x * w;
  host.mouseVec[1] = (1 - host.remoteTarget.y) * h;
}

export const formBind = {
  resolveFormProviderId,
  unbindFormProvider,
  bindFormProvider,
  bindOutPublisher,
  applyFormParams,
  applyRemoteMouse,
} as const;
