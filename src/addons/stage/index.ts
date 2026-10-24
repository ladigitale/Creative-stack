/**
 * Addon stage : scène 2D en DOM pilotée par le format `nodes` partagé (src/shared/nodes.ts),
 * le même que lit `sonic-3d`. Opt-in : `@supersoniks/creative-stack/stage`
 */
export { SonicStage } from "./stage";
export { StageNodes, writeElement, clearElement, type NodeState, type StageLayout, type StageNodesOptions } from "./stage-core";
export type { NodePatch, NodesSpec, NodeEase, NodeCurve } from "../../shared/nodes";

import "./stage";
