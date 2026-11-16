/**
 * Profils de port série : filtres du sélecteur (identifiants USB du pont série), débit par défaut.
 * Un profil ne dit rien du protocole parlé au-dessus : c'est le rôle des pilotes (`sonic-grbl`…).
 */
export type SerialFilter = { usbVendorId: number; usbProductId?: number };

export type SerialProfile = {
  label: string;
  filters: SerialFilter[];
  baud: number;
};

const CH340: SerialFilter[] = [{ usbVendorId: 0x1a86 }];
const CP210X: SerialFilter[] = [{ usbVendorId: 0x10c4 }];
const FTDI: SerialFilter[] = [{ usbVendorId: 0x0403 }];
const ARDUINO: SerialFilter[] = [{ usbVendorId: 0x2341 }, { usbVendorId: 0x2a03 }];
const ESPRESSIF: SerialFilter[] = [{ usbVendorId: 0x303a }];
const STM32: SerialFilter[] = [{ usbVendorId: 0x0483 }];

export const SERIAL_PROFILES: Record<string, SerialProfile> = {
  /** Pont WCH CH340 / CH341 : graveurs laser de bureau (Atomstack, Ortur, Sculpfun…), clones Arduino. */
  ch340: { label: "CH340", filters: CH340, baud: 115200 },
  /** Pont Silicon Labs CP210x : cartes ESP32, certaines cartes GRBL. */
  cp210x: { label: "CP210x", filters: CP210X, baud: 115200 },
  ftdi: { label: "FTDI", filters: FTDI, baud: 115200 },
  arduino: { label: "Arduino", filters: ARDUINO, baud: 115200 },
  /** USB natif des ESP32-S2 / S3 / C3. */
  esp32: { label: "ESP32", filters: [...ESPRESSIF, ...CP210X, ...CH340], baud: 115200 },
  /** Machines GRBL (graveurs laser, traceurs, petites fraiseuses) : tous les ponts courants. */
  grbl: { label: "GRBL", filters: [...CH340, ...CP210X, ...FTDI, ...ARDUINO, ...ESPRESSIF, ...STM32], baud: 115200 },
};

export function getSerialProfile(name: string): SerialProfile | null {
  return Object.prototype.hasOwnProperty.call(SERIAL_PROFILES, name) ? SERIAL_PROFILES[name] : null;
}

const id16 = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseInt(v.replace(/^0x/i, ""), 16) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 0xffff ? n : null;
};

/** `[{ "usbVendorId": "1a86", "usbProductId": "7523" }]` (hexadécimal en chaîne, ou nombre) → filtres ; `null` si invalide. */
export function cleanSerialFilters(value: unknown, max = 16): SerialFilter[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: SerialFilter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    const vendor = id16(f.usbVendorId ?? f.vendorId);
    if (vendor === null) return null;
    const filter: SerialFilter = { usbVendorId: vendor };
    if (f.usbProductId !== undefined || f.productId !== undefined) {
      const product = id16(f.usbProductId ?? f.productId);
      if (product === null) return null;
      filter.usbProductId = product;
    }
    out.push(filter);
  }
  return out;
}

export function matchesFilters(info: { usbVendorId?: number; usbProductId?: number }, filters: SerialFilter[]): boolean {
  if (!filters.length) return true;
  return filters.some((f) => f.usbVendorId === info.usbVendorId && (f.usbProductId === undefined || f.usbProductId === info.usbProductId));
}

export const hex4 = (n: number | undefined): string => (typeof n === "number" ? n.toString(16).padStart(4, "0") : "");
