// Fixtures in test/fixtures/ are the FAA NAS status feeds downloaded 2026-11-16 at about 17:42 UTC: airport-events (JSON, 8 airports)
// and airport-status-information (XML). Values read off them: SFO ground delay program for low ceilings, average 65 min, max 148 min,
// 16:00 to 03:59 UTC; SAN ground delay program for airport volume, average 36, max 72; PHX departure delays 16 to 30 minutes, increasing;
// PIT deicing; ARA closed 17:12 to 19:00 UTC; SNA closed daily 07:30-14:15 UTC (night curfew NOTAM); LAS and LAX carry only
// "closed to non-scheduled transient GA" notices, which do not affect airline flights.
// The ground stop and airspace flow program XML in the last parsing test is a hand-written sample in the FAA document format, because
// no ground stop was active when the fixtures were taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { minutes, parseEvents, parseXml, snapshot, resolve, delaysNow, airportStatus, checkTrip, InputError, UpstreamError, UTM } from '../dist/core.js';

const EV = readFileSync(new URL('./fixtures/airport-events-2026-11-16.json', import.meta.url), 'utf8');
const XML = readFileSync(new URL('./fixtures/airport-status-information-2026-11-16.xml', import.meta.url), 'utf8');
const f = async (u) => {
  if (u === 'https://nasstatus.faa.gov/api/airport-events') return EV;
  if (u === 'https://nasstatus.faa.gov/api/airport-status-information') return XML;
  throw new Error(`HTTP 404 (no fixture for ${u})`);
};
const NOW = new Date('2026-11-16T17:45:00Z');
const GS_XML = '<AIRPORT_STATUS_INFORMATION><Update_Time>Mon Nov 16 22:00:00 2026 GMT</Update_Time><Delay_type><Name>Ground Stop Programs</Name><Ground_Stop_List>' +
  '<Program><ARPT>EWR</ARPT><Reason>thunderstorms</Reason><End_Time>5:45 pm EST</End_Time></Program></Ground_Stop_List></Delay_type>' +
  '<Delay_type><Name>Airspace Flow Programs</Name><Airspace_Flow_List><Airspace_Flow><CTL_Element>FCAA05</CTL_Element><Reason>WEATHER / THUNDERSTORMS</Reason>' +
  '<AFP_StartTime>1900</AFP_StartTime><AFP_EndTime>0259</AFP_EndTime><Avg>45 minutes</Avg></Airspace_Flow></Airspace_Flow_List></Delay_type></AIRPORT_STATUS_INFORMATION>';

test('minutes text and JSON events: SFO and SAN programs, PHX departures, GA-only closures as notices', () => {
  assert.equal(minutes('1 hour and 12 minutes'), 72); assert.equal(minutes('36 minutes'), 36); assert.equal(minutes('2 hours'), 120); assert.equal(minutes('45'), 45); assert.equal(minutes(''), null);
  const m = parseEvents(EV);
  assert.equal(m.size, 8);
  const sfo = m.get('SFO').events[0];
  assert.equal(sfo.kind, 'ground_delay'); assert.equal(sfo.reason, 'low ceilings'); assert.equal(sfo.avg_delay_minutes, 65); assert.equal(sfo.max_delay_minutes, 148);
  assert.equal(sfo.text, 'Ground delay program (low ceilings): average 65 min, max 148 min, from 11-16 16:00 UTC, until 11-17 03:59 UTC');
  const phx = m.get('PHX').events[0];
  assert.equal(phx.kind, 'departure_delay'); assert.equal(phx.min_delay_minutes, 16); assert.equal(phx.max_delay_minutes, 30); assert.match(phx.text, /16 to 30 min, average 15 min, trend increasing/);
  assert.equal(m.get('LAS').events.length, 0); assert.equal(m.get('LAS').notices.length, 1); assert.equal(m.get('LAS').runway_config.arrival_rate, 56);
  assert.match(m.get('SNA').events[0].text, /^Closed daily 07:30-14:15 UTC/);
});

test('XML: per-airport events and airspace flow programs, including a ground stop sample', () => {
  const x = parseXml(XML);
  assert.equal(x.update, 'Mon Nov 16 17:41:19 2026 GMT');
  assert.deepEqual([...x.byAirport.keys()].sort(), ['ARA', 'PHX', 'SAN', 'SFO', 'SNA']);
  assert.equal(x.byAirport.get('SAN')[0].avg_delay_minutes, 36); assert.equal(x.byAirport.get('SAN')[0].max_delay_minutes, 72);
  assert.equal(x.byAirport.get('PHX')[0].kind, 'departure_delay');
  const g = parseXml(GS_XML);
  assert.equal(g.byAirport.get('EWR')[0].kind, 'ground_stop'); assert.equal(g.byAirport.get('EWR')[0].end, '5:45 pm EST');
  assert.equal(g.flow.length, 1); assert.equal(g.flow[0].CTL_Element, 'FCAA05');
  assert.throws(() => parseXml('<html></html>'), UpstreamError);
});

test('snapshot merges the feeds, and a ground stop only in the XML is still reported', async () => {
  const s = await snapshot(f);
  assert.equal(s.airports.get('SFO').events.length, 1);
  const g = await snapshot(async (u) => (u.endsWith('airport-events') ? '[]' : GS_XML));
  assert.equal(g.airports.get('EWR').events[0].text, 'GROUND STOP (thunderstorms): until 5:45 pm EST');
  const onlyJson = await snapshot(async (u) => { if (u.endsWith('airport-events')) return EV; throw new Error('HTTP 503'); });
  assert.equal(onlyJson.airports.size, 8);
  await assert.rejects(snapshot(async () => { throw new Error('HTTP 503'); }), UpstreamError);
});

test('resolving airports: codes, ICAO codes, names and cities', () => {
  assert.deepEqual(resolve('KSFO').map((a) => a.code), ['SFO']);
  assert.deepEqual(resolve('Newark').map((a) => a.code), ['EWR']);
  assert.deepEqual(resolve("O'Hare").map((a) => a.code), ['ORD']);
  assert.deepEqual(resolve('Chicago').map((a) => a.code), ['ORD', 'MDW']);
  assert.deepEqual(resolve('Houston').map((a) => a.code), ['IAH', 'HOU']);
  assert.deepEqual(resolve('Atlantis'), []);
});

test('delays now: 6 airports, SFO and SAN programs first, then closures, PHX, PIT', async () => {
  const r = await delaysNow(f, {}, NOW);
  assert.equal(r.airports_affected, 6);
  assert.deepEqual(r.counts, { ground_stop: 0, ground_delay: 2, airport_closure: 2, arrival_delay: 0, departure_delay: 1, deicing: 1 });
  assert.deepEqual(r.airports.map((a) => a.code), ['SAN', 'SFO', 'ARA', 'SNA', 'PHX', 'PIT']);
  assert.match(r.summary, /^FAA reports 6 airports with delays or closures right now: 0 ground stops, 2 ground delay programs, 2 closures, 1 with arrival or departure delays, 1 deicing\./);
  assert.ok(r.more.includes(UTM));
});

test('airport status: SFO delayed, JFK clear, Chicago gives both airports, LAX notice only', async () => {
  const a = await airportStatus(f, { airport: 'SFO' }, NOW);
  assert.equal(a.airports[0].delayed, true); assert.match(a.summary, /^SFO San Francisco International: Ground delay program \(low ceilings\)/);
  const b = await airportStatus(f, { airport: 'jfk' }, NOW);
  assert.equal(b.airports[0].delayed, false); assert.match(b.summary, /^JFK John F\. Kennedy International: no FAA-reported delays/);
  const c = await airportStatus(f, { airport: 'Chicago' }, NOW);
  assert.deepEqual(c.airports.map((x) => x.code), ['ORD', 'MDW']);
  const d = await airportStatus(f, { airport: 'LAX' }, NOW);
  assert.equal(d.airports[0].delayed, false); assert.match(d.summary, /arrival rate 68 an hour/); assert.match(d.summary, /Notices: LAX !LAX 05\/277/);
});

test('trip check: BOS, ORD, SFO has one delayed airport', async () => {
  const r = await checkTrip(f, { airports: ['BOS', "O'Hare", 'SFO'] }, NOW);
  assert.equal(r.any_delays, true); assert.deepEqual(r.legs.map((l) => [l.code, l.delayed]), [['BOS', false], ['ORD', false], ['SFO', true]]);
  assert.match(r.summary, /^1 of 3 airports on this trip have FAA delays or closures: SFO\./);
});

test('input errors', async () => {
  await assert.rejects(airportStatus(f, { airport: 'Atlantis' }, NOW), InputError);
  await assert.rejects(airportStatus(f, { airport: ' ' }, NOW), InputError);
  await assert.rejects(checkTrip(f, { airports: [] }, NOW), InputError);
  await assert.rejects(checkTrip(f, { airports: ['BOS', 'Atlantis'] }, NOW), InputError);
});

test('stdio: initialize, tools/list with annotations and a tools/call error over JSON-RPC (offline)', async () => {
  const child = spawn(process.execPath, [new URL('../dist/stdio.js', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = []; let buf = '';
  const got = (id) => new Promise((res) => { const iv = setInterval(() => { const m = lines.find((l) => l.id === id); if (m) { clearInterval(iv); res(m); } }, 10); });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal((await got(1)).result.serverInfo.name, 'airport-delays-faa-status-mcp');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  const tools = (await got(2)).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['airport_delays_now', 'airport_status', 'airport_delays_check_trip']);
  for (const t of tools) { assert.ok(t.title); assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false); assert.equal(t.annotations.openWorldHint, true); }
  send({ id: 3, method: 'tools/call', params: { name: 'airport_delays_check_trip', arguments: { airports: [] } } });
  const r3 = await got(3);
  child.kill();
  assert.equal(r3.result?.isError ?? Boolean(r3.error), true);
});
