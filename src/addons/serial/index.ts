/**
 * Addon serial : port série (Web Serial) piloté par DataProvider.
 *
 * `sonic-serial` est le transport (un port, ses octets, ses lignes de texte) ; les pilotes parlent un protocole
 * au-dessus par `transport="#id"` : `sonic-grbl` (addon `grbl`) pour les graveurs laser et traceurs.
 */
export { SonicSerial, type SerialState } from "./serial";
export { SERIAL_PROFILES, getSerialProfile, cleanSerialFilters, matchesFilters, type SerialProfile, type SerialFilter } from "./profiles";
export { LineSplitter } from "../../shared/pipe/lines";
export { isBytePipe, type SonicBytePipe, type PipeWriteOptions } from "../../shared/pipe/pipe";
export { FakePipe } from "../../shared/pipe/fake-pipe";
