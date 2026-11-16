// Pure core for airport-delays-faa-status-mcp. The only I/O is keyless reads of the FAA National Airspace System status service
// (nasstatus.faa.gov), done through an injected fetchText.
//
// Sources (public, no key):
//   https://nasstatus.faa.gov/api/airport-events                  JSON, one object per airport that has an active event:
//     groundStop, groundDelay, arrivalDelay, departureDelay, airportClosure, deicing, freeForm (NOTAM text), airportConfig
//     (runway configuration and arrival rate), plus airportLongName, latitude, longitude.
//   https://nasstatus.faa.gov/api/airport-status-information     XML, the classic AIRPORT_STATUS_INFORMATION document:
//     Delay_type blocks (Ground Delay Programs, Ground Stop Programs, General Arrival/Departure Delay Info, Airport Closures,
//     Airspace Flow Programs ...). Used for events the JSON does not carry (airspace flow programs) and as a cross-check.
// An airport that is in neither feed has no FAA-reported delay program, closure or deicing right now. Airline-specific delays
// (crew, maintenance, a single late flight) are never in these feeds.
import type { FetchText } from './types.js';
import { AIRPORTS, normCode, type Airport } from './airports.js';

export const REPO = 'airport-delays-faa-status-mcp';
export const SITE = 'https://www.mcpstamp.com';
export const UTM = `utm_source=mcp&utm_medium=${REPO}`;
export const more = () => `${SITE}/servers/?${UTM}`;
export const EVENTS = 'https://nasstatus.faa.gov/api/airport-events';
export const XML = 'https://nasstatus.faa.gov/api/airport-status-information';
export const SOURCE = 'FAA Air Traffic Control System Command Center, National Airspace System status (nasstatus.faa.gov). Covers FAA traffic management programs, closures and deicing, not airline-specific delays.';

export class InputError extends Error {}
export class UpstreamError extends Error {}

export type Kind = 'ground_stop' | 'ground_delay' | 'airport_closure' | 'arrival_delay' | 'departure_delay' | 'deicing';
export const SEVERITY: Kind[] = ['ground_stop', 'ground_delay', 'airport_closure', 'arrival_delay', 'departure_delay', 'deicing'];
const LABEL: Record<Kind, string> = {
  ground_stop: 'GROUND STOP', ground_delay: 'Ground delay program', airport_closure: 'Closure', arrival_delay: 'Arrival delays', departure_delay: 'Departure delays', deicing: 'Deicing in effect',
};

export interface Event { kind: Kind; text: string; reason: string | null; start: string | null; end: string | null; avg_delay_minutes: number | null; min_delay_minutes: number | null; max_delay_minutes: number | null; trend: string | null; advisory_url: string | null; source: 'json' | 'xml' }
export interface AirportStatus {
  code: string; name: string | null; events: Event[]; notices: string[]; runway_config: { arrival: string | null; departure: string | null; arrival_rate: number | null } | null;
}
export interface Snapshot { airports: Map<string, AirportStatus>; flow_programs: Record<string, string>[]; xml_update_time: string | null }

const s = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v).replace(/\s+/g, ' ').trim());
const n = (v: unknown) => { const x = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x; };
export const hhmm = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC` : iso);

/** "1 hour and 12 minutes" -> 72, "36 minutes" -> 36, "45" -> 45. */
export function minutes(text: unknown): number | null {
  const t = s(text);
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const h = /(\d+)\s*hour/.exec(t), m = /(\d+)\s*min/.exec(t);
  if (!h && !m) return null;
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

function describe(kind: Kind, e: Omit<Event, 'text' | 'kind' | 'source'>): string {
  const d: string[] = [];
  if (e.min_delay_minutes !== null && e.max_delay_minutes !== null) d.push(`${e.min_delay_minutes} to ${e.max_delay_minutes} min`);
  else {
    if (e.avg_delay_minutes !== null) d.push(`average ${e.avg_delay_minutes} min`);
    if (e.max_delay_minutes !== null) d.push(`max ${e.max_delay_minutes} min`);
  }
  if (e.avg_delay_minutes !== null && e.min_delay_minutes !== null) d.push(`average ${e.avg_delay_minutes} min`);
  if (e.trend) d.push(`trend ${e.trend.toLowerCase()}`);
  if (e.start && kind !== 'deicing') d.push(`from ${hhmm(e.start)}`);
  if (e.end) d.push(`${kind === 'airport_closure' ? 'reopens' : 'until'} ${hhmm(e.end)}`);
  const daily = kind === 'airport_closure' ? /CLSD DLY (\d{2})(\d{2})-(\d{2})(\d{2})/.exec(e.reason ?? '') : null;
  if (daily) return `Closed daily ${daily[1]}:${daily[2]}-${daily[3]}:${daily[4]} UTC between ${hhmm(e.start)} and ${hhmm(e.end)} (NOTAM ${e.reason})`;
  return `${LABEL[kind]}${e.reason ? ` (${e.reason})` : ''}${d.length ? `: ${d.join(', ')}` : ''}`;
}

function event(kind: Kind, raw: any, src: 'json' | 'xml'): Event {
  const ad = raw?.arrivalDeparture ?? {};
  const e = {
    reason: s(raw?.impactingCondition ?? raw?.reason ?? raw?.simpleText),
    start: s(raw?.startTime ?? raw?.eventTime),
    end: s(raw?.endTime ?? raw?.expTime),
    avg_delay_minutes: n(raw?.avgDelay) ?? minutes(raw?.averageDelay),
    min_delay_minutes: minutes(ad?.min),
    max_delay_minutes: n(raw?.maxDelay) ?? minutes(ad?.max),
    trend: s(ad?.trend ?? raw?.trend),
    advisory_url: s(raw?.advisoryUrl),
  };
  return { kind, text: describe(kind, e), ...e, source: src };
}

export function parseEvents(body: string): Map<string, AirportStatus> {
  let rows: unknown;
  try { rows = JSON.parse(body); } catch { throw new UpstreamError('nasstatus.faa.gov airport-events returned something that is not JSON'); }
  if (!Array.isArray(rows)) throw new UpstreamError('nasstatus.faa.gov airport-events did not return a list');
  const out = new Map<string, AirportStatus>();
  for (const r of rows as any[]) {
    const code = normCode(String(r?.airportId ?? ''));
    if (!code) continue;
    const events: Event[] = [];
    if (r.groundStop) events.push(event('ground_stop', r.groundStop, 'json'));
    if (r.groundDelay) events.push(event('ground_delay', r.groundDelay, 'json'));
    if (r.airportClosure) {
      const txt = s(r.airportClosure.simpleText) ?? '';
      // "AD AP CLSD TO NON SKED TRANSIENT GA" closes the airport to private visitors only, not to airline flights.
      if (/NON SKED TRANSIENT GA/i.test(txt)) { /* notice only */ } else events.push(event('airport_closure', r.airportClosure, 'json'));
    }
    if (r.arrivalDelay) events.push(event('arrival_delay', r.arrivalDelay, 'json'));
    if (r.departureDelay) events.push(event('departure_delay', r.departureDelay, 'json'));
    if (r.deicing) events.push(event('deicing', r.deicing, 'json'));
    const notices: string[] = [];
    for (const k of ['freeForm', 'airportClosure']) {
      const t = s(r[k]?.simpleText);
      if (t && (k === 'freeForm' || /NON SKED TRANSIENT GA/i.test(t))) notices.push(t);
    }
    const c = r.airportConfig;
    out.set(code, {
      code, name: s(r.airportLongName), events, notices,
      runway_config: c ? { arrival: s(c.arrivalRunwayConfig), departure: s(c.departureRunwayConfig), arrival_rate: n(c.arrivalRate) } : null,
    });
  }
  return out;
}

const XML_KIND: Record<string, Kind> = {
  'ground delay programs': 'ground_delay', 'ground stop programs': 'ground_stop', 'ground stops': 'ground_stop', 'airport closures': 'airport_closure', 'deicing': 'deicing',
};

/** The classic XML: per-airport events by Delay_type name, and non-airport programs (airspace flow programs). */
export function parseXml(xml: string): { byAirport: Map<string, Event[]>; flow: Record<string, string>[]; update: string | null } {
  if (!xml.includes('<AIRPORT_STATUS_INFORMATION')) throw new UpstreamError('nasstatus.faa.gov airport-status-information returned something that is not the status document');
  const byAirport = new Map<string, Event[]>();
  const flow: Record<string, string>[] = [];
  const update = /<Update_Time>([^<]*)<\/Update_Time>/.exec(xml)?.[1] ?? null;
  for (const block of xml.split('<Delay_type>').slice(1)) {
    const name = (/<Name>([^<]*)<\/Name>/.exec(block)?.[1] ?? '').trim();
    const list = /<(\w+_List)>([\s\S]*?)<\/\1>/.exec(block);
    if (!list) continue;
    for (const item of list[2].matchAll(/<(\w+)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const fields: Record<string, string> = {};
      for (const m of item[2].matchAll(/<(\w+)\b([^>]*)>([^<]*)<\/\1>/g)) fields[m[1]] = m[3].trim();
      const type = /Type="([^"]+)"/.exec(item[2])?.[1];
      if (type) fields.Type = type;
      const lname = name.toLowerCase();
      if (!fields.ARPT) { flow.push({ program: name, ...fields }); continue; }
      let kind: Kind | undefined = XML_KIND[lname];
      if (lname.startsWith('general arrival')) kind = /depart/i.test(fields.Type ?? '') ? 'departure_delay' : 'arrival_delay';
      if (!kind) { flow.push({ program: name, ...fields }); continue; }
      if (kind === 'airport_closure' && /NON SKED TRANSIENT GA/i.test(fields.Reason ?? '')) continue;
      const e = {
        reason: s(fields.Reason), start: s(fields.Start), end: s(fields.Reopen ?? fields.End_Time), avg_delay_minutes: minutes(fields.Avg),
        min_delay_minutes: minutes(fields.Min), max_delay_minutes: minutes(fields.Max), trend: s(fields.Trend), advisory_url: null,
      };
      const code = normCode(fields.ARPT);
      byAirport.set(code, [...(byAirport.get(code) ?? []), { kind, text: describe(kind, e), ...e, source: 'xml' }]);
    }
  }
  return { byAirport, flow, update };
}

export async function snapshot(f: FetchText): Promise<Snapshot> {
  const [ev, xml] = await Promise.allSettled([
    f(EVENTS, { cacheTtl: 60, timeoutMs: 15000 }),
    f(XML, { cacheTtl: 60, timeoutMs: 15000, accept: 'application/xml,text/xml,*/*' }),
  ]);
  if (ev.status === 'rejected' && xml.status === 'rejected') throw new UpstreamError(`nasstatus.faa.gov did not answer: ${(ev.reason as Error).message}`);
  const airports = ev.status === 'fulfilled' ? parseEvents(ev.value) : new Map<string, AirportStatus>();
  let flow: Record<string, string>[] = [], update: string | null = null;
  if (xml.status === 'fulfilled') {
    try {
      const x = parseXml(xml.value);
      flow = x.flow; update = x.update;
      // Add events the JSON does not carry for an airport (same kind missing), so a ground stop in either feed is reported.
      for (const [code, evs] of x.byAirport) {
        const a = airports.get(code) ?? { code, name: null, events: [], notices: [], runway_config: null };
        for (const e of evs) if (!a.events.some((y) => y.kind === e.kind)) a.events.push(e);
        airports.set(code, a);
      }
    } catch (e) { if (ev.status === 'rejected') throw e; }
  }
  for (const a of airports.values()) a.events.sort((x, y) => SEVERITY.indexOf(x.kind) - SEVERITY.indexOf(y.kind));
  return { airports, flow_programs: flow, xml_update_time: update };
}

const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Resolve a code, ICAO code, airport name or city to FAA codes (a city can have several airports). */
export function resolve(q: string, snap?: Snapshot): { code: string; name: string | null; city: string | null }[] {
  const raw = String(q ?? '').trim();
  if (!raw) return [];
  const code = normCode(raw);
  if (/^[A-Z0-9]{3}$/.test(code)) {
    const a = AIRPORTS.find((x) => x.code === code);
    return [{ code, name: a?.name ?? snap?.airports.get(code)?.name ?? null, city: a?.city ?? null }];
  }
  const t = norm(raw);
  const hit = (a: Airport) => norm(a.name).includes(t) || norm(a.city).split(' ').slice(0, -1).join(' ') === t || norm(a.city).startsWith(t + ' ') || (a.also ?? []).some((x) => norm(x) === t);
  const found: { code: string; name: string | null; city: string | null }[] = AIRPORTS.filter(hit).map((a) => ({ code: a.code, name: a.name, city: a.city }));
  if (snap) for (const a of snap.airports.values()) if (a.name && norm(a.name).includes(t) && !found.some((x) => x.code === a.code)) found.push({ code: a.code, name: a.name, city: null });
  return found;
}

const worst = (a: AirportStatus) => (a.events.length ? SEVERITY.indexOf(a.events[0].kind) : 99);

export async function delaysNow(f: FetchText, _a: Record<string, never> = {}, now = new Date()) {
  const snap = await snapshot(f);
  const affected = [...snap.airports.values()].filter((a) => a.events.length).sort((x, y) => worst(x) - worst(y) || x.code.localeCompare(y.code));
  const counts = Object.fromEntries(SEVERITY.map((k) => [k, affected.filter((a) => a.events.some((e) => e.kind === k)).length]));
  const head = affected.length
    ? `FAA reports ${affected.length} airport${affected.length === 1 ? '' : 's'} with delays or closures right now: ${counts.ground_stop} ground stop${counts.ground_stop === 1 ? '' : 's'}, ${counts.ground_delay} ground delay program${counts.ground_delay === 1 ? '' : 's'}, ` +
      `${counts.airport_closure} closure${counts.airport_closure === 1 ? '' : 's'}, ${counts.arrival_delay + counts.departure_delay} with arrival or departure delays, ${counts.deicing} deicing.`
    : 'FAA reports no ground stops, ground delay programs, closures or general delays at any US airport right now.';
  const lines = affected.map((a) => `${a.code}${a.name ? ` ${a.name}` : ''}: ${a.events.map((e) => e.text).join('; ')}`);
  const flow = snap.flow_programs.map((p) => `${p.program}: ${Object.entries(p).filter(([k]) => k !== 'program').map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const summary = [head, ...lines, ...(flow.length ? ['Other programs:', ...flow] : []), 'Airline-specific delays and cancellations are not in the FAA feed; check the airline for a single flight.'].join('\n');
  return { summary, airports_affected: affected.length, counts, airports: affected, other_programs: snap.flow_programs, faa_update_time: snap.xml_update_time, as_of: now.toISOString(), source: SOURCE, more: more() };
}

function statusLine(code: string, name: string | null, a: AirportStatus | undefined): string {
  const label = `${code}${name ? ` ${name}` : ''}`;
  if (!a || !a.events.length) return `${label}: no FAA-reported delays, ground stops or closures right now${a?.runway_config?.arrival_rate ? ` (arrival rate ${a.runway_config.arrival_rate} an hour, runways ${a.runway_config.arrival ?? '?'} in / ${a.runway_config.departure ?? '?'} out)` : ''}.`;
  return `${label}: ${a.events.map((e) => e.text).join('; ')}.`;
}

export async function airportStatus(f: FetchText, a: { airport: string }, now = new Date()) {
  if (!a.airport || !String(a.airport).trim()) throw new InputError('airport is required: an airport code (JFK, KORD) or a name or city (Newark, O\'Hare, Denver)');
  const snap = await snapshot(f);
  const ids = resolve(a.airport, snap);
  if (!ids.length) throw new InputError(`no airport matches "${a.airport}". Use the 3-letter airport code, e.g. ORD, ATL, LAX.`);
  if (ids.length > 6) throw new InputError(`"${a.airport}" matches ${ids.length} airports; use a code.`);
  const results = ids.map((id) => {
    const st = snap.airports.get(id.code);
    return { code: id.code, name: st?.name ?? id.name, city: id.city, delayed: !!st?.events.length, events: st?.events ?? [], notices: st?.notices ?? [], runway_config: st?.runway_config ?? null };
  });
  const summary = results.map((r) => statusLine(r.code, r.name, snap.airports.get(r.code))).join('\n') +
    (results.some((r) => r.notices.length) ? `\nNotices: ${results.flatMap((r) => r.notices.map((t) => `${r.code} ${t}`)).join(' | ')}` : '') +
    '\nThe FAA feed covers airport-wide programs. A single late or cancelled flight is the airline\'s decision and is not in it.';
  return { summary, query: a.airport, airports: results, faa_update_time: snap.xml_update_time, as_of: now.toISOString(), source: SOURCE, more: more() };
}

export async function checkTrip(f: FetchText, a: { airports: string[] }, now = new Date()) {
  if (!Array.isArray(a.airports) || a.airports.length < 1 || a.airports.length > 8) throw new InputError('airports must list 1 to 8 airports in trip order, e.g. ["BOS", "ORD", "SFO"]');
  const snap = await snapshot(f);
  const legs = a.airports.map((q) => {
    const ids = resolve(q, snap);
    if (!ids.length) throw new InputError(`no airport matches "${q}". Use the 3-letter code.`);
    const id = ids[0];
    const st = snap.airports.get(id.code);
    return { query: q, code: id.code, name: st?.name ?? id.name, delayed: !!st?.events.length, events: st?.events ?? [], runway_config: st?.runway_config ?? null };
  });
  const hit = legs.filter((l) => l.delayed);
  const summary = (hit.length ? `${hit.length} of ${legs.length} airports on this trip have FAA delays or closures: ${hit.map((l) => l.code).join(', ')}.` : `No FAA delays, ground stops or closures at any of ${legs.map((l) => l.code).join(', ')} right now.`) +
    `\n${legs.map((l) => statusLine(l.code, l.name, snap.airports.get(l.code))).join('\n')}` +
    '\nA ground delay program or ground stop at the destination holds flights at their origin, so it delays departures elsewhere too.';
  return { summary, any_delays: hit.length > 0, legs, faa_update_time: snap.xml_update_time, as_of: now.toISOString(), source: SOURCE, more: more() };
}
