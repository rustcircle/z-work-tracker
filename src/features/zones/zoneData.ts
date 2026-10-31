// What the picker lists and how it searches. Names come from tz.ts (pickerZones), so the list and the
// rest of the app always agree on which zones exist.
import { abbrAt, cityOf, clockAt, formatOffset, offsetAt, pickerZones } from '../../lib/tz';

/**
 * Obsolete spellings kept in the time zone database for old data. They are hidden from the list so a
 * place appears once, and map to the current name so searching for the old one (such as Calcutta) still
 * finds the current entry. Real places that merely share rules with another zone (Monaco, Grenada) are
 * not here.
 */
export const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'Africa/Timbuktu': 'Africa/Bamako',
  'America/Argentina/ComodRivadavia': 'America/Argentina/Catamarca',
  'America/Atka': 'America/Adak',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Ensenada': 'America/Tijuana',
  'America/Fort_Wayne': 'America/Indiana/Indianapolis',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Knox_IN': 'America/Indiana/Knox',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Montreal': 'America/Toronto',
  'America/Porto_Acre': 'America/Rio_Branco',
  'America/Rosario': 'America/Argentina/Cordoba',
  'America/Santa_Isabel': 'America/Tijuana',
  'America/Shiprock': 'America/Denver',
  'America/Virgin': 'America/St_Thomas',
  'Antarctica/South_Pole': 'Antarctica/McMurdo',
  'Asia/Ashkhabad': 'Asia/Ashgabat',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Chungking': 'Asia/Shanghai',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Harbin': 'Asia/Shanghai',
  'Asia/Istanbul': 'Europe/Istanbul',
  'Asia/Kashgar': 'Asia/Urumqi',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Tel_Aviv': 'Asia/Jerusalem',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ujung_Pandang': 'Asia/Makassar',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Australia/ACT': 'Australia/Sydney',
  'Australia/Canberra': 'Australia/Sydney',
  'Australia/LHI': 'Australia/Lord_Howe',
  'Australia/NSW': 'Australia/Sydney',
  'Australia/North': 'Australia/Darwin',
  'Australia/Queensland': 'Australia/Brisbane',
  'Australia/South': 'Australia/Adelaide',
  'Australia/Tasmania': 'Australia/Hobart',
  'Australia/Victoria': 'Australia/Melbourne',
  'Australia/West': 'Australia/Perth',
  'Australia/Yancowinna': 'Australia/Broken_Hill',
  'Europe/Belfast': 'Europe/London',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Tiraspol': 'Europe/Chisinau',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Johnston': 'Pacific/Honolulu',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Samoa': 'Pacific/Pago_Pago',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Yap': 'Pacific/Chuuk',
};

/** Zones listed in the picker: every picker zone except the obsolete spellings. */
export function listedZones(): string[] {
  return pickerZones().filter((z) => LEGACY_ALIASES[z] === undefined);
}

export interface ZoneRow {
  zone: string;
  city: string;
  /** "Europe/Lisbon" with spaces for underscores. */
  path: string;
  abbr: string;
  offsetText: string;
  offsetSecs: number;
  clock: string;
  /** Lower-case words this row can be found by. */
  words: string[];
}

function offsetForms(offsetSecs: number): string[] {
  const sign = offsetSecs < 0 ? '-' : '+';
  const abs = Math.abs(offsetSecs);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const mm = String(m).padStart(2, '0');
  const short = m ? `${sign}${h}:${mm}` : `${sign}${h}`;
  return [`utc${short}`, `gmt${short}`, short, `${sign}${String(h).padStart(2, '0')}:${mm}`];
}

/** One list row per zone, with the abbreviation, offset and local time in force at `sec`. */
export function buildRows(zones: readonly string[], sec: number): ZoneRow[] {
  const aliasesOf = new Map<string, string[]>();
  for (const [alias, current] of Object.entries(LEGACY_ALIASES)) {
    const list = aliasesOf.get(current) ?? [];
    list.push(alias);
    aliasesOf.set(current, list);
  }
  return zones.map((zone) => {
    const offsetSecs = offsetAt(sec, zone);
    const abbr = abbrAt(sec, zone);
    const offsetText = zone === 'UTC' ? 'UTC' : formatOffset(offsetSecs);
    const city = cityOf(zone);
    const path = zone.replaceAll('_', ' ');
    const aliasText = (aliasesOf.get(zone) ?? []).map((a) => a.replaceAll('_', ' ').replaceAll('/', ' ')).join(' ');
    const words = `${path.replaceAll('/', ' ')} ${abbr} ${aliasText}`
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean)
      .concat(zone.toLowerCase(), offsetForms(offsetSecs));
    return { zone, city, path, abbr, offsetText, offsetSecs, clock: clockAt(sec, zone), words };
  });
}

function scoreToken(row: ZoneRow, token: string): number {
  const city = row.city.toLowerCase();
  if (city === token) return 6;
  if (city.startsWith(token)) return 5;
  let best = 0;
  for (const w of row.words) {
    if (w === token) best = Math.max(best, 4);
    else if (w.startsWith(token)) best = Math.max(best, 3);
    else if (w.includes(token)) best = Math.max(best, 1);
  }
  return best;
}

/**
 * Rows matching every whitespace-separated token of the query (city, zone path, abbreviation, offset
 * such as "utc-4" or "+5:30", or an obsolete spelling), best matches first. An empty query keeps order.
 */
export function filterRows(rows: readonly ZoneRow[], query: string): ZoneRow[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...rows];
  const scored: { row: ZoneRow; score: number; i: number }[] = [];
  rows.forEach((row, i) => {
    let total = 0;
    for (const t of tokens) {
      const s = scoreToken(row, t);
      if (s === 0) return;
      total += s;
    }
    scored.push({ row, score: total, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.row);
}
