// Tool registry shared by the stdio and Worker entries.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { InputError, REPO, SITE, airportStatus, checkTrip, delaysNow } from './core.js';
import type { FetchText } from './types.js';

export const VERSION = '1.0.0';

export const META = {
  alias: 'airport-delays',
  metaDescription: 'MCP server for airport delays today from the FAA: ground stops, ground delay programs, arrival and departure delays, closures and deicing at US airports, one airport\'s status and a trip check.',
  intro: 'Airport delays today for AI assistants, read live from the FAA National Airspace System status: ground stops, ground delay programs, closures and deicing at US airports.',
};

export const TOOL_INFO = [
  { name: 'airport_delays_now', blurb: 'Every US airport with an FAA ground stop, ground delay program, arrival or departure delay, closure or deicing right now, worst first.' },
  { name: 'airport_status', blurb: 'One airport by code, name or city (JFK, KORD, Newark, O\'Hare): delays with average and maximum minutes, reason and end time, or a clear "no FAA delays", plus runway configuration.' },
  { name: 'airport_delays_check_trip', blurb: 'Check origin, connections and destination in one call and say which airports on the trip have FAA delays.' },
];

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: Record<string, unknown> & { summary: string }) {
  return { content: [{ type: 'text' as const, text: `${data.summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: `${e instanceof InputError ? 'Error' : 'Upstream FAA error'}: ${msg}` }] };
}
const wrap = <A>(fn: (a: A) => unknown) => async (a: A) => { try { return ok((await fn(a)) as any); } catch (e) { return fail(e); } };

export function createServer(fetchText: FetchText): McpServer {
  const server = new McpServer({ name: REPO, version: VERSION, websiteUrl: SITE } as any, {
    instructions:
      'US airport delays read at call time from the FAA National Airspace System status (nasstatus.faa.gov): ground stops, ground delay programs, arrival and departure delays, closures and deicing. ' +
      'A model cannot know whether an airport has a ground stop right now. Use airport_delays_now for "airport delays today", airport_status for one airport ("is there a ground stop at JFK", "delays at O\'Hare") ' +
      'and airport_delays_check_trip for an itinerary. These are FAA traffic programs; a single flight\'s delay or cancellation comes from the airline and is not here.',
  });

  server.registerTool('airport_delays_now', {
    title: 'Airport delays now (FAA)',
    description:
      'All US airports with an active FAA event right now: ground stops, ground delay programs (average and maximum delay, reason such as weather or volume, end time), ' +
      'general arrival and departure delays with trend, airport closures and deicing, sorted worst first, plus airspace flow programs.',
    inputSchema: {},
    annotations: { title: 'Airport delays now', ...RO },
  }, wrap(() => delaysNow(fetchText)));

  server.registerTool('airport_status', {
    title: 'Airport status and delays',
    description:
      'FAA delay status of one US airport, by IATA code (JFK), ICAO code (KJFK), airport name or city (Newark, O\'Hare, Denver): any ground stop, ground delay program, ' +
      'arrival or departure delay, closure or deicing with reason, minutes and end time, or a clear statement that the FAA reports no delay there; plus the runway configuration and arrival rate when posted.',
    inputSchema: { airport: z.string().min(2).max(60).describe('Airport code, name or city.') },
    annotations: { title: 'Airport status', ...RO },
  }, wrap((a: any) => airportStatus(fetchText, a)));

  server.registerTool('airport_delays_check_trip', {
    title: 'Check a trip for airport delays',
    description:
      'Check every airport on an itinerary (origin, connections, destination; 1 to 8 airports) for FAA ground stops, ground delay programs, delays and closures in one call.',
    inputSchema: { airports: z.array(z.string().min(2).max(60)).min(1).max(8).describe('Airports in trip order, e.g. ["BOS", "ORD", "SFO"].') },
    annotations: { title: 'Check a trip', ...RO },
  }, wrap((a: any) => checkTrip(fetchText, a)));

  return server;
}
