/**
 * Addon device : API « appareil » du navigateur exposées en DataProviders, sans JS —
 * plein écran, pointer lock, wake lock, orientation et capteurs, presse-papiers, partage, vibration,
 * état de la page, tags NFC, appareils HID et USB, et un agrégateur de capacités pour que l'artefact dégrade proprement.
 *
 * Les manettes (`controller`, `interactive/gamepad`) et le MIDI (`audio/midi`) existent déjà dans leurs addons.
 */
export { SonicFullscreen, type FullscreenState } from "./fullscreen";
export { SonicPointerLock, type PointerLockState } from "./pointer-lock";
export { SonicWakeLock, type WakeLockState } from "./wake-lock";
export { SonicOrientation, type OrientationState } from "./orientation";
export { SonicGeolocation, distanceBearing, nearbyPlaces, type GeolocationState, type GeoPlace, type NearbyPlace } from "./geolocation";
export { SonicClipboard, type ClipboardState } from "./clipboard";
export { SonicShare, safeShareUrl, type ShareState } from "./share";
export { SonicVibrate, parsePattern, type VibrateState } from "./vibrate";
export { SonicPageState, type PageStateValue } from "./page-state";
export { SonicCapabilities, CAPABILITY_KEYS, type CapabilitiesState, type Capability, type CapabilityKey, type CapabilityPermission } from "./capabilities";
export { SonicNfc, buildNfcMessage, decodeNfcRecord, safeNfcUrl, type NfcState, type NfcRecord } from "./nfc";
export { SonicHid, decodeHidReport, parseDeviceFilters, type HidState, type HidReport } from "./hid";
export { SonicUsb, cleanSetup, MAX_USB_TRANSFER, type UsbState, type UsbIn, type UsbSetup } from "./usb";
export { DeviceElement, policyAllows, deviceError, describeElement, type DeviceBaseState, type DeviceStatus } from "../../shared/device/base";
