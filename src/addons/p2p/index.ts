/**
 * Addon p2p : salons temps réel entre visiteurs d'un artefact Tadaaa (jeux, tableau blanc),
 * par l'API de salons + hub Mercure. Tout se pilote par DataProvider.
 */
export { SonicP2p, type P2pState } from "./p2p";
export { RoomClient, RoomApiError, type RoomInfo, type RoomState, type Member, type RoomMessage, type RoomClientOptions } from "./room-client";
