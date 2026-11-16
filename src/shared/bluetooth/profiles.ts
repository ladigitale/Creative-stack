/**
 * Profils d'appareils : filtres du sélecteur, canaux (`service/caractéristique`), découpage des écritures.
 * `validated` : confirmé sur matériel par le projet cité en source ; sinon écrit d'après documentation.
 */
export type BluetoothFilter = { name?: string; namePrefix?: string; services?: string[] };

export type BluetoothProfile = {
  filters: BluetoothFilter[];
  channels: Record<string, string>;
  /** Alias écoutés dès la connexion. */
  notify: string[];
  chunkSize: number;
  gapMs: number;
  /** Séquences d'octets refusées en écriture (mise à jour de micrologiciel, remise à zéro d'usine…). */
  forbidden?: number[][];
  validated: boolean;
  source: string;
};

const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const ISSC = "49535343-fe7d-4ae5-8fa9-9fafd205e455";
const MIDI = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
const NIIMBOT = "e7810a71-73ae-499d-8c15-faa9aef0c3f2";

const sensor = (service: string, characteristic: string): BluetoothProfile => ({
  filters: [{ services: [service] }],
  channels: { rx: `${service}/${characteristic}` },
  notify: ["rx"],
  chunkSize: 20,
  gapMs: 0,
  validated: false,
  source: "Bluetooth SIG",
});

export const PROFILES: Record<string, BluetoothProfile> = {
  /** Imprimantes LuckPrinter (Fichero D11s d'Action = AiYin D11s). */
  luck: {
    filters: [{ namePrefix: "FICHERO" }, { namePrefix: "D11s_" }],
    channels: { tx: "18f0/2af1", rx: "18f0/2af0" },
    notify: ["rx"],
    chunkSize: 200,
    gapMs: 20,
    // Mode mise à jour, poignée de main de mise à jour, remise à zéro d'usine, délai d'extinction.
    forbidden: [[0x10, 0xff, 0xe0], [0x10, 0xff, 0xff], [0x10, 0xff, 0x04], [0x10, 0xff, 0x12]],
    validated: true,
    source: "github.com/0xMH/fichero-printer (D11s, micrologiciel 2.4.6)",
  },
  /** Imprimantes tickets ESC/POS génériques (même service que `luck`, sans filtre de nom). */
  escpos: {
    filters: [{ services: ["18f0"] }],
    channels: { tx: "18f0/2af1", rx: "18f0/2af0" },
    notify: ["rx"],
    chunkSize: 100,
    gapMs: 20,
    validated: false,
    source: "ESC/POS",
  },
  /** Nordic UART : ESP32, micro:bit, Espruino, Adafruit. */
  "uart-nus": {
    filters: [{ services: [NUS] }],
    channels: { tx: `${NUS}/6e400002-b5a3-f393-e0a9-e50e24dcca9e`, rx: `${NUS}/6e400003-b5a3-f393-e0a9-e50e24dcca9e` },
    notify: ["rx"],
    chunkSize: 20,
    gapMs: 0,
    validated: false,
    source: "Nordic UART Service",
  },
  /** UART transparent Microchip (ISSC). */
  "uart-issc": {
    filters: [{ services: [ISSC] }],
    channels: { tx: `${ISSC}/49535343-8841-43f4-a8d4-ecbe34729bb3`, rx: `${ISSC}/49535343-1e4d-4bd9-ba61-23c647249616` },
    notify: ["rx"],
    chunkSize: 20,
    gapMs: 0,
    validated: false,
    source: "Microchip Transparent UART",
  },
  /** Modules HM-10 et clones : une seule caractéristique pour les deux sens. */
  "uart-hm10": {
    filters: [{ services: ["ffe0"] }],
    channels: { tx: "ffe0/ffe1", rx: "ffe0/ffe1" },
    notify: ["rx"],
    chunkSize: 20,
    gapMs: 0,
    validated: false,
    source: "HM-10",
  },
  /** Imprimantes « chat » (GB01, GT01, MX05…MX10). */
  cat: {
    filters: ["GB0", "GT01", "YT01", "MX0", "MX10", "X5"].map((namePrefix) => ({ namePrefix })),
    channels: { tx: "ae30/ae01", rx: "ae30/ae02" },
    notify: ["rx"],
    chunkSize: 20,
    gapMs: 10,
    validated: false,
    source: "github.com/rbaron/catprinter",
  },
  niimbot: {
    // Par service, et par début de nom : certains modèles n'annoncent pas le service avant la connexion.
    filters: [{ services: [NIIMBOT] }, ...["D11", "D10", "B1", "B2", "B3", "M2"].map((namePrefix) => ({ namePrefix }))],
    channels: { tx: `${NIIMBOT}/bef8d6c9-9c21-4c9e-b632-bd58c1009f9f`, rx: `${NIIMBOT}/bef8d6c9-9c21-4c9e-b632-bd58c1009f9f` },
    notify: ["rx"],
    // Un paquet par écriture : les lignes d'image dépassent 20 octets.
    chunkSize: 200,
    gapMs: 0,
    validated: false,
    source: "printers.niim.blue",
  },
  midi: {
    filters: [{ services: [MIDI] }],
    channels: { tx: `${MIDI}/7772e5db-3868-4112-a1a9-f2669d106bf3`, rx: `${MIDI}/7772e5db-3868-4112-a1a9-f2669d106bf3` },
    notify: ["rx"],
    chunkSize: 20,
    gapMs: 0,
    validated: false,
    source: "BLE MIDI",
  },
  "heart-rate": sensor("heart_rate", "heart_rate_measurement"),
  battery: sensor("battery_service", "battery_level"),
  csc: sensor("cycling_speed_and_cadence", "csc_measurement"),
  "cycling-power": sensor("cycling_power", "cycling_power_measurement"),
};

export function getProfile(name: string): BluetoothProfile | null {
  return Object.prototype.hasOwnProperty.call(PROFILES, name) ? PROFILES[name] : null;
}
