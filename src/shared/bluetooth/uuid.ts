/** UUID Bluetooth : forme courte (`18f0`), nom standard (`heart_rate`) ou UUID complet → UUID complet en minuscules. */

const BASE = "-0000-1000-8000-00805f9b34fb";

/** Noms standard utilisés par les profils (services et caractéristiques). */
export const STANDARD_UUIDS: Record<string, string> = {
  heart_rate: "180d",
  heart_rate_measurement: "2a37",
  battery_service: "180f",
  battery_level: "2a19",
  device_information: "180a",
  cycling_speed_and_cadence: "1816",
  csc_measurement: "2a5b",
  cycling_power: "1818",
  cycling_power_measurement: "2a63",
  fitness_machine: "1826",
  environmental_sensing: "181a",
};

export function expandUuid(value: string): string | null {
  let v = String(value ?? "").trim().toLowerCase();
  if (STANDARD_UUIDS[v]) v = STANDARD_UUIDS[v];
  if (/^(0x)?[0-9a-f]{4}$/.test(v)) return `0000${v.replace(/^0x/, "")}${BASE}`;
  if (/^[0-9a-f]{8}$/.test(v)) return `${v}${BASE}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v;
  return null;
}

/**
 * Services jamais ouverts, même demandés par le document : mise à jour de micrologiciel (DFU Nordic,
 * OAD Texas Instruments), claviers et souris (HID), clés de sécurité (FIDO).
 */
const BLOCKED = ["fe59", "00001530-1212-efde-1523-785feabcd123", "f000ffc0-0451-4000-b000-000000000000", "1812", "fffd"].map((u) => expandUuid(u) as string);

export function isBlockedService(uuid: string): boolean {
  return BLOCKED.includes(uuid);
}

/** `"18f0/2af1"` → `{service, characteristic}` en UUID complets. */
export function parseChannel(value: unknown): { service: string; characteristic: string } | null {
  if (typeof value !== "string") return null;
  const [s, c, extra] = value.split("/");
  const service = expandUuid(s ?? "");
  const characteristic = expandUuid(c ?? "");
  return service && characteristic && extra === undefined ? { service, characteristic } : null;
}
