# RAO Demo — Agent Guide

This document is the primary reference for any coding agent working on this project. It covers architecture, data flow, every packet field the RAO API emits, how the frontend renders each one, and exactly where to make changes when new data surfaces.

---

## 1. What this project is

A streaming trace viewer for **Eastspring Investments** built on top of the **RAO (Retrieval Agent Orchestrator) API** by NucliaSEEM. The user types a question, the RAO backend runs a multi-stage retrieval-augmented pipeline (rephrase → retrieval → generation), and the frontend renders each intermediate step in real time as it arrives.

**Data sources the RAO pipeline has access to:**
- Eastspring's public website content (PDFs, annual reports, blog posts, investment statements) — indexed in NucliaDB (`advanced_ask` module)
- Live web search via Perplexity (`perplexity` module)
- A mock Supabase PostgreSQL database with client portfolio data — tables: `funds`, `holdings`, `instruments`, `portfolios`, `prices` — queried via MCP tools (`mcp` module)

---

## 2. How to run

```bash
# Terminal 1 — backend (auto-restarts on file changes)
cd server
npm run dev

# Terminal 2 — frontend
cd frontend
npm run dev
# Opens at http://localhost:5173
```

Backend listens on `http://127.0.0.1:3001`. Frontend expects the backend at that address (hardcoded as `BACKEND_URL` in `frontend/src/App.jsx`).

**Environment:** Backend reads `.env` from `server/.env`. Required variables:

| Variable | Purpose |
|---|---|
| `RAO_BASE_URL` | Base HTTPS URL of the RAO API |
| `RAO_AGENT_ID` | Agent UUID |
| `RAO_API_KEY` | Long-lived JWT (RS256) — used as Bearer token for all REST calls and HTTP POST streaming |
| `RAO_ACCOUNT_ID` | Account UUID (used in ephemeral token path) |
| `RAO_KB_ID` | Knowledge base UUID (defaults to `RAO_AGENT_ID` if unset) |
| `RAO_WORKFLOW_ID` | Workflow name sent as `?workflow_id=` (defaults to `"default"`) |

Path templates can be overridden with env vars (see `buildConfig()` in `server/src/server.js`) but the defaults match the current RAO API layout.

**Important:** Never use credentials from sample curl snippets. Always use only the values in `server/.env`.

---

## 3. Architecture

```
Browser (React + Mantine)
    │
    │  POST /api/interactions/stream          ← WebSocket transport
    │  POST /api/interactions/stream-post     ← HTTP POST transport
    ▼
Node.js Server  (server/src/server.js)
    │
    │  Relay: converts upstream stream → SSE  (text/event-stream)
    │  Browser always receives SSE regardless of upstream transport
    │
    ├── WebSocket transport
    │     1. POST /api/v1/account/{account_id}/kb/{kb_id}/ephemeral_tokens
    │        → get short-lived eph-token (NOT a JWT, not usable in Authorization header)
    │     2. Open WebSocket to /api/v1/agent/{agent_id}/session/ephemeral/ws?eph-token=...
    │     3. Send interactionRequest as JSON text frame
    │     4. Forward each message frame to browser as SSE "packet" event
    │
    └── HTTP POST transport
          1. POST /api/v1/agent/{agent_id}/session/ephemeral
             Authorization: Bearer {RAO_API_KEY}
          2. Response body is a stream of concatenated JSON objects (no delimiter)
          3. Server parses with extractJsonObjects() (brace-depth counter)
          4. Forward each object to browser as SSE "packet" event
```

### SSE event types the browser receives

| Event | When | Data shape |
|---|---|---|
| `ready` | Stream opened | `{ streamId, sessionId }` |
| `socket_open` | Upstream connected | `{ streamId, sessionId }` |
| `request_sent` | Question dispatched upstream | `{ streamId }` |
| `packet` | Every RAO API message | The RAO packet object (see §5) |
| `error` | Server-side failure | `{ streamId, message }` |
| `complete` | Stream finished | `{ streamId, packetType, operation }` |
| `socket_close` | Upstream closed | `{ streamId, code, reason }` |

---

## 4. Transport comparison

| | WebSocket | HTTP POST |
|---|---|---|
| Auth | `?eph-token=` query param (ephemeral token, NOT the API key) | `Authorization: Bearer {RAO_API_KEY}` |
| Answer quality | Sometimes returns "Not enough data" for data-heavy questions | Usually returns fuller answers (more MCP tool calls observed) |
| Completion signal | WebSocket close event | operation 3 in stream |
| Error signal | operation 4 packet | operation 4 packet |

**Default transport in the UI:** HTTP POST (left option in SegmentedControl).

---

## 5. RAO API packet structure

Every packet is a JSON object. Most top-level fields are `null` in any given packet — only one "payload slot" is populated at a time.

```jsonc
{
  // ── always present ──────────────────────────────────────────
  "operation": 0,          // 0=normal, 2=init/ack, 3=done(clean), 4=error/abort

  // ── one of these is non-null per packet ─────────────────────
  "step": { ... },         // pipeline step update (most common)
  "context": { ... },      // retrieved context (knowledge base or web)
  "answer": "string",      // final answer text (stream ends after this)
  "possible_answer": { … },// draft answer before finalisation (currently ignored)
  "exception": { ... },    // error detail (usually accompanies operation:4)

  // ── rarely/never populated in current data ───────────────────
  "answer_citations": null,
  "answer_urls": [],
  "agent_request": null,
  "generated_text": null,
  "feedback": null,
  "oauth": null,
  "data_visualizations": null,
  "seqid": null,
  "original_question_uuid": null,  // top-level; the per-step UUIDs are inside step/context
  "actual_question_uuid": null
}
```

### 5.1 `step` object

Present in preprocessing, retrieval, and generation steps.

```jsonc
{
  "module": "rephrase",      // see module list below
  "title": "Rephrase: Sub-questions",
  "value": "3 questions.\nQuestions: Q1?, Q2?, Q3?",
  "agent_path": "/preprocess/77f0eef7-...",  // path prefix determines stage
  "reason": "Explanation of why this result...",
  "timeit": 1.887,           // seconds (float)
  "input_nuclia_tokens": 0.04382,   // normalised cost units (perplexity uses raw token counts)
  "output_nuclia_tokens": 0.02824,
  "error": null,             // string if module errored; for mcp this is a JSON string
  "original_question_uuid": "...",
  "actual_question_uuid": "..."   // differs from original when sub-querying
}
```

**`agent_path` → stage mapping (authoritative):**

| Prefix | Stage |
|---|---|
| `/preprocess/` | preprocessing |
| `/context/` | retrieval |
| `/generation/` | generation |

**Module names and what they do:**

| Module | Stage | What it does |
|---|---|---|
| `rephrase` | preprocessing | Breaks the user question into sub-queries |
| `mcp` | retrieval | Runs MCP tools (SQL queries against Supabase, table introspection) |
| `advanced_ask` | retrieval | Semantic search over NucliaDB (Eastspring PDFs, reports) |
| `perplexity` | retrieval | Live web search |
| `summarize` | generation | Synthesises all retrieved context into a final answer |
| `remi` | evaluation | Post-answer evaluation (not yet observed in practice) |

### 5.2 `context` object

Emitted after each retrieval module completes — contains what was actually retrieved.

```jsonc
{
  "id": "...",
  "question": "Which specific sub-query was this retrieval for?",
  "summary": "Compressed summary of retrieved content (shown as Output in UI)",
  "source": "nucliadb-1205",     // source system identifier
  "agent": "advanced_ask",       // which module produced this
  "agent_id": "...",
  "chunks": [                    // raw retrieved passages
    {
      "chunk_id": "...",
      "title": "2022-aes-5---asian-reits-and-dividends---6-may.pdf",  // document filename
      "source": "nucliadb-1205",
      "text": "The actual retrieved passage text...",
      "url": [],                 // empty for KB chunks, array of web URLs for perplexity chunks
      "origin_url": null,
      "origin_agent": "advanced_ask",  // or "perplexity"
      "labels": [],
      "metadata": null,
      "action": null
    }
  ],
  "citations": ["chunk_id_1", "chunk_id_2"],  // which chunk_ids were actually cited (can be null)
  "missing": null,               // what information was missing (potential future use)
  "images": {},
  "image_urls": [],
  "prompts": [],
  "structured": [],
  "citations_id": null,
  "original_question_uuid": "...",
  "actual_question_uuid": "..."
}
```

### 5.3 `possible_answer` object

Emitted by the `summarize` module just before the final `answer` packet. Contains the draft answer and metadata. Currently filtered out by the frontend because the `step` packet and `answer` packet that follow contain the same content.

```jsonc
{
  "answer": "The final answer text...",
  "module": "summarize",
  "agent_path": "/generation/...",
  "citations": null,    // chunk_ids cited — null in current data
  "chunks": null,
  "structured": null,
  "images": null,
  "image_urls": null,
  "original_question_uuid": "...",
  "actual_question_uuid": "..."
}
```

### 5.4 `exception` object

```jsonc
{
  "detail": "unhandled errors in a TaskGroup (1 sub-exception)",
  "extra": null
}
```

Always accompanies `operation: 4`. The `detail` may be an empty string.

### 5.5 Operation codes

| Code | Meaning | Frontend action |
|---|---|---|
| 0 | Normal packet | Process payload |
| 2 | Stream initialised / ack | Ignored (no payload) |
| 3 | Clean completion | Server emits `complete` SSE event |
| 4 | Error / abort | Server emits `complete` SSE event; frontend shows error |

---

## 6. Frontend rendering pipeline

**File:** `frontend/src/App.jsx`

### 6.1 Packet filtering — what gets shown

```
RAW SSE packet
     │
     ├─ operation === 4  →  show error banner, stop stream
     │
     ├─ isUsefulPacket() === false  →  silently drop
     │     Passes if: packet.step | packet.answer | packet.context | packet.exception
     │
     ├─ answer !== null  →  set status done, stop stream (no trace item created)
     │
     └─ shouldIgnoreStep()  →  silently drop
           Filters: context validation titles, mcp prompt/error/finished, advanced_ask empty
```

### 6.2 Stage classification — `stageFromPacket(packet)`

1. Checks `step.agent_path` prefix first (`/preprocess/`, `/context/`, `/generation/`) — most reliable
2. Falls back to `MODULE_TO_STAGE[step.module]`
3. Falls back to payload-based heuristics (`context` → retrieval, `answer` → generation)

### 6.3 Field → UI mapping

| Packet field | Extracted by | Rendered as |
|---|---|---|
| `step.module` | inline in onEvent | event-module label (bold, green) |
| `step.title` | inline in onEvent | event-title label |
| `step.value` | `extractOutputMarkdown()` | "Output" markdown block |
| `step.value` (rephrase) | `formatRephraseOutput()` | Numbered sub-query list |
| `step.value` (mcp tool result) | `formatMcpOutput()` | Bold tool name + SQL code block |
| `step.reason` | `extractReasoning()` | Dimmed reasoning text below output |
| `step.timeit` | inline in onEvent | Meta chip: `X ms` or `X.X s` if ≥1s |
| `step.input_nuclia_tokens` | inline | Meta chip: `in: X` |
| `step.output_nuclia_tokens` | inline | Meta chip: `out: X` |
| `step.error` (mcp) | `parseMcpError()` | Red error text (JSON parsed to message) |
| `step.error` (others) | inline | Red error text |
| `step.agent_path` | `stageFromPacket()` | Stage classification only, not displayed |
| `context.summary` | `extractOutputMarkdown()` | "Output" markdown block |
| `context.question` | inline in onEvent | "Sub-query" text |
| `context.source` / `context.agent` | `extractPacketSources()` | Source chips on stage header |
| `context.chunks[].source` | `extractPacketSources()` | Source chips |
| `context.chunks[].url[]` | `extractChunkUrls()` | "Web sources" clickable hostname links (perplexity) |
| `context.chunks[].title` | `extractChunkDocs()` | "Documents" pill chips (advanced_ask) |
| `context.chunks[].text` | — | **Not currently shown** |
| `context.missing` | — | **Not currently shown** (always null) |
| `possible_answer` | — | **Filtered out** (step+answer packets carry same content) |
| `answer_citations` | — | **Not currently shown** (always null) |
| `answer_urls` | — | **Not currently shown** (always empty) |
| `data_visualizations` | — | **Not currently shown** (always null) |

### 6.4 Source chip label logic — `extractPacketSources(packet)`

For `context` packets:
1. Tries `context.source` first
2. Tries `chunk.source` for each chunk
3. Falls back to `context.agent`

Note: `context.source` for advanced_ask is `"nucliadb-XXXX"` (internal ID, not readable). The readable source chips for retrieval stage headers come mostly from `context.agent` → normalised to "Advanced Ask", "Perplexity", etc.

Document titles (from `chunk.title`) are shown *within* each event card under "Documents", not in the stage header chips.

### 6.5 Sub-query tracking — `moduleSubqueryHint`

Context validation step values contain the rephrased sub-query that was sent to that module. This is captured and stored in `moduleSubqueryHint[moduleName]` so that subsequent context packets from the same module inherit the right "Sub-query" label, even when `context.question` is missing.

---

## 7. How to handle new packet fields

When you see a new field appearing in the RAO API response that isn't currently handled:

### Step 1 — Capture a raw artifact

Run a curl command against the HTTP POST endpoint and save the output:

```bash
curl -s -N -X POST http://127.0.0.1:3001/api/interactions/stream-post \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "77e3e4168b314452b68ac57c6859bb4b",
    "interactionRequest": {
      "question": "YOUR QUESTION HERE",
      "operation": 0,
      "headers": {}
    }
  }' > artifacts/response_<label>.txt
```

The session ID `77e3e4168b314452b68ac57c6859bb4b` is a known working session. Artifacts go in `artifacts/` at the project root.

To analyse a captured artifact:

```bash
# Count packets
grep -c 'event: packet' artifacts/response_<label>.txt

# Find packets with a specific field non-null
grep '"new_field":' artifacts/response_<label>.txt | grep -v '"new_field":null' | head -5

# Pretty-print a specific packet
grep '"new_field":' artifacts/response_<label>.txt | head -1 | \
  python3 -c "import sys,json; d=json.loads(sys.stdin.read().split('data: ')[1]); print(json.dumps(d, indent=2))"
```

### Step 2 — Decide which layer handles it

| The new field is in… | Handle in… |
|---|---|
| A completely new top-level packet type | `isUsefulPacket()` + `onEvent` handler |
| An existing packet but new sub-field of `step` | `extractOutputMarkdown()`, `extractReasoning()`, or directly in `onEvent` trace item creation |
| An existing packet but new sub-field of `context` | `extractPacketSources()`, `extractChunkUrls()`, `extractChunkDocs()`, or new extractor |
| A new operation code | `detectCompletion()` in `server/src/server.js` + `onEvent` in frontend |
| A structural change to how JSON is streamed | `extractJsonObjects()` in `server/src/server.js` |

### Step 3 — Add extraction logic

Add a new extractor function near the other extractors in `App.jsx` (lines ~38–270). Follow the pattern:

```javascript
function extractNewField(packet) {
  // Return null/[] if not applicable
  if (!packet?.context?.new_field) return null;
  return packet.context.new_field;
}
```

Call it in the `onEvent` trace item creation block (~line 450) and include the result in the trace item object.

### Step 4 — Add rendering

Add rendering inside the event card JSX (~line 590). Pattern for a new section:

```jsx
{item.newField ? (
  <Box mt="sm">
    <Text fw={700} size="xs" mb={4} className="content-label">
      Section Title
    </Text>
    {/* render item.newField here */}
  </Box>
) : null}
```

---

## 8. Key files reference

| File | Purpose |
|---|---|
| `server/src/server.js` | Node.js HTTP server. All RAO API communication, SSE relay, both transport handlers |
| `frontend/src/App.jsx` | Entire React application — state, streaming, packet parsing, rendering |
| `frontend/src/styles.css` | All CSS. Uses CSS custom properties defined in `:root`. No CSS modules |
| `server/.env` | Credentials and config (never commit) |
| `artifacts/` | Saved raw SSE streams for analysis |

### `server/src/server.js` key functions

| Function | What it does |
|---|---|
| `streamInteraction()` | WebSocket transport handler |
| `streamInteractionViaPost()` | HTTP POST transport handler |
| `extractJsonObjects(buffer)` | Parses concatenated JSON stream from HTTP POST body |
| `detectCompletion(packet)` | Returns non-null when operation 3 or 4 detected → triggers `complete` SSE event |
| `parseStreamRequest(req)` | Reads + normalises the incoming request body |
| `resolveSessionId()` | Uses existing sessionId or creates a new session |
| `buildConfig()` | Reads all env vars and path templates |

### `frontend/src/App.jsx` key functions

| Function | What it does |
|---|---|
| `stageFromPacket(packet)` | Maps packet → UI stage (preprocessing / retrieval / generation / evaluation) |
| `isUsefulPacket(packet)` | Returns true if the packet should create a trace item |
| `shouldIgnoreStep(step)` | Returns true for noisy/internal step packets that should be hidden |
| `extractSubqueryHint(packet)` | Extracts the sub-question from context validation steps |
| `extractOutputMarkdown(packet)` | Extracts the main display text from step.value / context.summary |
| `extractReasoning(packet)` | Extracts the reason/title text shown as dimmed reasoning |
| `extractPacketSources(packet)` | Extracts source labels for the stage header chips |
| `extractChunkUrls(packet)` | Extracts web URLs from perplexity context chunks |
| `extractChunkDocs(packet)` | Extracts cleaned document titles from advanced_ask context chunks |
| `formatRephraseOutput(value)` | Parses "N questions. Questions: Q1?, Q2?" into a numbered list |
| `formatMcpOutput(step)` | Formats MCP tool calls as bold tool name + SQL code block |
| `parseMcpError(errorStr)` | Parses MCP JSON error strings to human-readable message |
| `streamSse()` | Reads the SSE stream from the backend and fires `onEvent` per event |

---

## 9. Currently unhandled fields (future opportunities)

| Field | Location | Notes |
|---|---|---|
| `context.chunks[].text` | context packet | Raw retrieved passage text — not shown, only `context.summary` is |
| `context.missing` | context packet | Always null in current data; would indicate information gaps |
| `possible_answer.citations` | possible_answer packet | Chunk IDs cited in draft answer — always null currently |
| `answer_citations` | answer packet | Always null currently |
| `answer_urls` | answer packet | Always empty array currently |
| `data_visualizations` | top-level | Always null currently — may carry chart data in future |
| `context.structured` | context packet | Always empty array — may carry structured data in future |
| `step.error` (non-MCP) | step packet | Shown as raw string; only MCP errors are currently parsed |

---

## 10. UI layout overview

```
┌─────────────────────────────────────────────────────┐
│ Header (82px)                                       │
│   Title + active stage label                        │
├─────────────────────────────────────────────────────┤
│ Main (scrollable)                                   │
│   User bubble (right-aligned)                       │
│   ▸ Preprocessing  (N steps) ── collapsed           │
│   ▸ Retrieval      (N steps) ── collapsed           │
│      source chips: MCP | Advanced Ask | Perplexity  │
│   ▸ Generation     (N steps) ── collapsed           │
├─────────────────────────────────────────────────────┤
│ Footer (170px)                                      │
│   [ Textarea, max 2 rows, scrollable beyond ]       │
│   Transport: [HTTP POST] [WebSocket]   [Submit]     │
│   (Tab key shows sample query picker)               │
└─────────────────────────────────────────────────────┘
```

Each stage accordion item expands to show event cards. Each event card is a `<details open>` element showing:
- Module name + step title + timestamp
- Sub-query (the specific question this step was answering)
- Output (markdown rendered)
- Web sources (clickable hostnames, perplexity only)
- Documents (PDF title pills, advanced_ask only)
- Reasoning (dimmed text)
- Meta chips: time, token in/out
- Error text (red, if any)
