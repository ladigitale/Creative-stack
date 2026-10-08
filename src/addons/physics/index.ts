/**
 * Addon physics : monde 2D planck.js (Box2D) décrit en SDUI, piloté par
 * DataProvider, chocs et capteurs envoyés au store, rendu canvas utilisable
 * comme source d'images pour `sonic-shader`.
 */
export { SonicPhysics, type PhysicsState } from "./world";
export { PHYSICS_PART_TAGS } from "./elements";
export { PhysicsWorld, parseBody, parseJoint, type BodySpec, type JointSpec, type PhysicsEvent, type Drive, type BodyState } from "./core";
