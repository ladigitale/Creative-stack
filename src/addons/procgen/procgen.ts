import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { ProcgenScene } from "./engine/procgen-engine.js";

const tagName = "sonic-procgen";

type Json = any;

/**
 * Scène 2D procédurale rendue sur GPU (WebGL2), lue et pilotée par DataProvider.
 *
 * Lecture (clés du `dataProvider`) : scene, patch, seed, params, style, view, select, anim.
 * Écriture : selection, status {composing, items, issues, ms, fps, gpuMs, scale, skip, animated, error}, view.
 * `target` : id d'un sonic-store qui reçoit {type, payload} quand l'objet sélectionné change.
 *
 * Le store est celui de Concorde (dp) : branché une fois pour la page.
 */
export class SonicProcgen extends ProcgenScene {
  /** Id du sonic-store qui reçoit la sélection. */
  get target(): string {
    return this.getAttribute("target") ?? "";
  }
  /** Type d'action envoyé à `target` (défaut select). */
  get selectActionType(): string {
    return this.getAttribute("select-action-type") || "select";
  }
  private selUnwatch: (() => void) | null = null;
  private lastSel = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.bindTarget();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.selUnwatch?.();
    this.selUnwatch = null;
  }

  private bindTarget(): void {
    this.selUnwatch?.();
    this.selUnwatch = null;
    const p = this.path;
    if (!p || !this.target) return;
    this.selUnwatch = SonicProcgen.store.watch(`${p}.selection`, (sel: Json) => {
      const key = sel ? `${sel.pointer ?? ""}#${sel.copy ?? ""}` : "";
      if (key === this.lastSel) return;
      this.lastSel = key;
      dispatch(this.target, {
        type: this.selectActionType,
        payload: sel
          ? { objectId: sel.label ?? sel.def ?? sel.pointer, pointer: sel.pointer, copy: sel.copy ?? null, type: sel.type, def: sel.def }
          : { objectId: null },
      });
    });
  }
}

ProcgenScene.useConcorde({ dp: dp as unknown as (path: string) => Json });
if (!customElements.get(tagName)) customElements.define(tagName, SonicProcgen);
