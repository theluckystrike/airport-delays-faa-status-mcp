# Data sources

All sources are public, keyless and read at call time. Test fixtures in `test/fixtures/` were downloaded on 2026-11-16 at about 17:42 UTC.

| Data | URL | Notes |
|---|---|---|
| FAA airport events | https://nasstatus.faa.gov/api/airport-events | JSON, one object per airport with an active event: groundStop, groundDelay, arrivalDelay, departureDelay, airportClosure, deicing, freeForm NOTAM text and airportConfig (runways, arrival rate). Fixture: 8 airports, SFO and SAN ground delay programs, PHX departure delays, PIT deicing, ARA and SNA closures. |
| FAA airport status information | https://nasstatus.faa.gov/api/airport-status-information | The classic XML document (Delay_type blocks). Used for airspace flow programs and as a second source for ground stops and delays the JSON does not carry. |

Airport names and cities for about 80 busy US airports are a table in `src/airports.ts`, so names like "O'Hare" or "Newark" resolve to codes. The hosted server caches the feeds for 60 seconds. FAA data is a US government work.
