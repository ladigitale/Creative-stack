/**
 * Addon bluetooth : appareils Bluetooth Low Energy (Web Bluetooth) pilotés par DataProvider.
 *
 * `sonic-bluetooth` est le transport (un appareil, ses caractéristiques GATT) ; les pilotes parlent un
 * protocole au-dessus par `transport="#id"` : `sonic-label-printer` pour les imprimantes thermiques
 * d'étiquettes (Fichero d'Action et la famille LuckPrinter, ESC/POS générique).
 */
export { SonicBluetooth, type BluetoothState, type BluetoothValue } from "./bluetooth";
export { SonicLabelPrinter, parseLabelMm, labelPixels, toPrintBitmap, type LabelPrinterState, type LabelPrinterSettings } from "./label-printer";
export { LUCK, luckProtocol, rasterHeader, parseLuckStatus, parseLuckError } from "./printer/luck";
export { escposProtocol } from "./printer/escpos";
export { PROTOCOLS, createProtocol, modelFromName, type PrinterModel } from "./printer/models";
export { PrinterLink, type PrinterProtocol, type PrintJob, type PrinterInfo, type PrinterStatus, type PaperType } from "./printer/protocol";
export { PROFILES, getProfile, type BluetoothProfile, type BluetoothFilter } from "../../shared/bluetooth/profiles";
export { isBytePipe, type SonicBytePipe, type PipeWriteOptions } from "../../shared/bluetooth/pipe";
export { FakePipe } from "../../shared/bluetooth/fake-pipe";
export { toHex, fromHex } from "../../shared/bluetooth/bytes";
export { expandUuid } from "../../shared/bluetooth/uuid";
