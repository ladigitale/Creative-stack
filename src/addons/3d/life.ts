import { PublisherManager } from "@supersoniks/concorde/utils";
import { ensure } from "./ensure";
import { formBind } from "./form-bind";
import { wantsOffscreenPlay } from "./playback";
import type { SceneRuntime } from "./runtime";

/** Host Lit pour cycle de vie / observers / bind DP. */
export type LifeHost = {
  aspectRatio: string;
  dataProvider: string;
  outDataProvider: string;
  releaseOffscreen: boolean;
  playOffscreen: boolean;
  frameConsumerCount: number;
  inView: boolean;
  runtime: SceneRuntime | null;
  camera: string;
  fov: number;
  exposure: number;
  dprMax: number;
  fit: boolean;
  minDistance: number;
  maxDistance: number;
  minPolar: number;
  maxPolar: number;
  style: CSSStyleDeclaration;
  formPublisher: ReturnType<typeof PublisherManager.get> | null;
  outPublisher: ReturnType<typeof PublisherManager.get> | null;
  resizeObserver: ResizeObserver | null;
  intersectionObserver: IntersectionObserver | null;
  onFormMutation: () => void;
  syncPlayback: () => void;
};

function applyAspectRatio(host: LifeHost) {
  const forced = host.aspectRatio.trim();
  if (forced) {
    host.style.setProperty(
      "--sonic-3d-ar",
      forced.includes("/") ? forced : forced.replace(":", " / "),
    );
    return;
  }
  host.style.removeProperty("--sonic-3d-ar");
}

function unbindFormProvider(host: LifeHost) {
  if (host.formPublisher) {
    host.formPublisher.offInternalMutation(host.onFormMutation);
    host.formPublisher = null;
  }
}

function bindFormProvider(host: LifeHost) {
  unbindFormProvider(host);
  const id = formBind.resolveFormProviderId(
    host as unknown as HTMLElement,
    host.dataProvider,
  );
  if (!id) return;
  host.formPublisher = PublisherManager.get(id);
  host.formPublisher.onInternalMutation(host.onFormMutation);
  host.onFormMutation();
}

function bindOutPublisher(host: LifeHost) {
  const id = formBind.resolveOutProviderId(
    host as unknown as HTMLElement,
    host.outDataProvider,
    host.dataProvider,
  );
  host.outPublisher = id ? PublisherManager.get(id) : null;
}

function firstUpdated(host: LifeHost) {
  applyAspectRatio(host);
  host.resizeObserver = new ResizeObserver(() =>
    ensure.syncSize(host as never),
  );
  host.resizeObserver.observe(host as unknown as Element);
  host.intersectionObserver = new IntersectionObserver(
    (entries) => {
      host.inView = entries.some((e) => e.isIntersecting);
      ensure.syncVisibility(host as never);
    },
    { threshold: 0 },
  );
  host.intersectionObserver.observe(host as unknown as Element);
  bindFormProvider(host);
  bindOutPublisher(host);
  requestAnimationFrame(() => {
    if (host.inView || !host.releaseOffscreen || wantsOffscreenPlay(host)) {
      void ensure.ensureRuntime(host as never);
    }
  });
}

export const life = {
  applyAspectRatio,
  unbindFormProvider,
  bindFormProvider,
  bindOutPublisher,
  firstUpdated,
} as const;
