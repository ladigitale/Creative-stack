/**
 * Addon bluetooth : appareils Bluetooth Low Energy (Web Bluetooth) pilotés par DataProvider.
 *
 * `sonic-bluetooth` est le transport (un appareil, ses caractéristiques GATT) ; les pilotes parlent un
 * protocole au-dessus par `transport="#id"` : `sonic-label-printer` pour les imprimantes thermiques
 * d'étiquettes (Fichero d'Action et la famille LuckPrinter, Niimbot, imprimantes « chat », Phomemo, ESC/POS
 * générique). Profil `midi` : claviers et contrôleurs MIDI Bluetooth décodés par le transport lui-même.
 */
export { SonicBluetooth, type BluetoothState, type BluetoothValue, type BleMidiState } from "./bluetooth";
export { BleMidiDecoder, encodeBleMidi, splitMidi, midiEvent, trackNotes, type BleMidiEvent, type BleMidiType, type HeldMidiNote } from "./midi/ble-midi";
export { SonicLabelPrinter, parseLabelMm, labelPixels, toPrintBitmap, type LabelPrinterState, type LabelPrinterSettings } from "./label-printer";
export { LUCK, luckProtocol, rasterHeader, parseLuckStatus, parseLuckError } from "./printer/luck";
export { escposProtocol } from "./printer/escpos";
export { CAT, CAT_WIDTH_PX, catProtocol, catFrame, catLine, catJob, crc8, parseCatFrames, parseCatState, reverseBits, groupFrames, catEnergy, type CatFrame } from "./printer/cat";
export { PHOMEMO, PHOMEMO_CHUNK, PHOMEMO_VARIANTS, phomemoProtocol, phomemoJob, phomemoRaster, phomemoVariant, phomemoDensity, type PhomemoVariant } from "./printer/phomemo";
export {
  NIIM, NIIM_IN, NIIMBOT_MODELS, NIIMBOT_TASKS, niimbotProtocol, niimbotPacket, parseNiimbotPackets, niimbotRows, niimbotCounts, niimbotDensity,
  niimbotError, niimbotModel, parseNiimbotHeartbeat, type NiimbotModel, type NiimbotPacket, type NiimbotTask,
} from "./printer/niimbot";
export { PROTOCOLS, createProtocol, modelFromName, type PrinterModel } from "./printer/models";
export { PrinterLink, type PrinterProtocol, type PrintJob, type PrinterInfo, type PrinterStatus, type PaperType } from "./printer/protocol";
export { PROFILES, getProfile, type BluetoothProfile, type BluetoothFilter } from "../../shared/bluetooth/profiles";
export { isBytePipe, type SonicBytePipe, type PipeWriteOptions } from "../../shared/pipe/pipe";
export { FakePipe } from "../../shared/pipe/fake-pipe";
export { toHex, fromHex } from "../../shared/pipe/bytes";
export { expandUuid } from "../../shared/bluetooth/uuid";
