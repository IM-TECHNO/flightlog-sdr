import liveries from "./liveries.json";

export type Livery = { body: string; belly: string; stripe: string; tail: string; engine: string };
const table = liveries as Record<string, Livery>;

/** Key of the model/colours to use for an airline ICAO code ("default" when unknown). */
export const liveryKey = (icao?: string | null): string => (icao && icao in table ? icao : "default");
export const liveryFor = (icao?: string | null): Livery => table[liveryKey(icao)];
export const modelUri = (icao?: string | null): string => `/models/planes/${liveryKey(icao)}.gltf`;
