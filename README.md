# airport-delays-faa-status-mcp

Airport delays today for AI assistants. Ask whether there is a ground stop at Newark, how long the ground delay program at San Francisco is running, which US airports have delays right now, or whether anything on your Boston to Chicago to San Francisco trip is held.

This is a Model Context Protocol (MCP) server. It reads the FAA National Airspace System status (the Air Traffic Control System Command Center feed behind nasstatus.faa.gov) at call time. It needs no API key.

## Tools

| Tool | What it returns |
| --- | --- |
| `airport_delays_now` | Every US airport with an FAA ground stop, ground delay program, arrival or departure delay, closure or deicing right now, worst first, plus airspace flow programs. |
| `airport_status` | One airport by IATA or ICAO code, name or city (JFK, KORD, Newark, O'Hare): each event with reason, average and maximum delay and end time, or a clear statement that the FAA reports no delay; runway configuration and arrival rate when posted. |
| `airport_delays_check_trip` | Origin, connections and destination (1 to 8 airports) in one call, with which ones have FAA delays. |

Every result has structured JSON, a plain-text summary, `as_of`, `source` and `more` (a page on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=airport-delays-faa-status-mcp)). Every tool is marked read-only.

## What it knows that your model does not

- Whether a ground stop or ground delay program is running right now, why (weather, low ceilings, volume, equipment) and until when.
- Average and maximum delay of a ground delay program, and the minimum to maximum range and trend of general arrival and departure delays.
- Which closures matter: night curfews and full closures are reported, while NOTAMs that only close an airport to private transient aircraft are kept as notices.

## Install

### Hosted (custom connector, ChatGPT developer mode, any remote MCP client)

Paste this URL. No token, no sign-up.

```
https://airport-delays-faa-status-mcp.lipmichal.workers.dev/mcp
```

### Cursor

Add to `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "airport-delays": { "url": "https://airport-delays-faa-status-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`.

```json
{
  "servers": {
    "airport-delays": { "type": "http", "url": "https://airport-delays-faa-status-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

### Local stdio

The npm package is not published. Build it from this repository with Node 20 or newer, then point your MCP client at `node /path/to/airport-delays-faa-status-mcp/dist/stdio.js`.

```
git clone https://github.com/theluckystrike/airport-delays-faa-status-mcp && cd airport-delays-faa-status-mcp
npm install && npm run build
node dist/stdio.js
```

## Example prompts

- "Are there any airport delays right now?"
- "Is there a ground stop at Newark?"
- "Why is San Francisco delayed, and how long is the delay?"
- "I fly Boston to Chicago O'Hare to San Francisco this afternoon. Any FAA delays?"
- "Is O'Hare deicing today?"

## Data sources

Full list in [DATA_SOURCES.md](DATA_SOURCES.md).

- [FAA National Airspace System status](https://nasstatus.faa.gov/): `https://nasstatus.faa.gov/api/airport-events` (JSON) and `https://nasstatus.faa.gov/api/airport-status-information` (XML).

## Limitations

- These are FAA traffic management programs. A single flight's delay or cancellation (crew, aircraft, airline operations) is the airline's and is not in the feed.
- US airports only. Times are in UTC as the FAA posts them; a ground stop end time in the XML is in local time as written by the FAA.
- An airport missing from the feed has no FAA-reported event; that is not a promise that every flight is on time.

## More

More MCP servers that answer questions your assistant cannot answer alone are on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=airport-delays-faa-status-mcp).

Part of the Zovo MCP collection at https://mcp.zovo.one

Built by [theluckystrike](https://github.com/theluckystrike).

## Development

```
npm install
npm test                              # builds, then runs the fixture tests and an offline stdio test
node scripts/stdio-transcript.mjs     # live stdio round trip, writes .live/stdio-transcript.jsonl
```

CI (`.github/workflows/bundle.yml`) runs the tests, the type check and `wrangler deploy --dry-run --outdir out`, and uploads the Worker bundle as an artifact.

## License

MIT
