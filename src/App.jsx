import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Accordion,
  AppShell,
  Box,
  Button,
  Group,
  ScrollArea,
  SegmentedControl,
  Switch,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";

const BACKEND_URL = "http://127.0.0.1:3001";

const SAMPLE_QUERIES = [
  "What are Eastspring's top performing funds this year?",
  "Which client portfolios have the largest allocation to Asian equities?",
  "What is Eastspring's current view on global interest rates?",
  "What are the top 5 holdings across all client portfolios?",
  "Summarise the key investment themes from Eastspring's latest annual report.",
  "What are the major equity investment trends in the US and globally in early 2025, what are the top 5 holdings by weight in each of our portfolios as of 31 Jan 2025, and how do our current exposures align or diverge from those trends?",
];

/**
 * The six scenarios from the root README matrix. Each one is just a preset of the three
 * controls below (transport, session mode, history toggle); the controls stay editable.
 */
export const SCENARIOS = [
  { id: 1, transport: "post", sessionMode: "ephemeral", persistHistory: true, summary: "HTTP POST · ephemeral · client sends chat_history" },
  { id: 2, transport: "post", sessionMode: "ephemeral", persistHistory: false, summary: "HTTP POST · ephemeral · no history (baseline)" },
  { id: 3, transport: "post", sessionMode: "persistent", persistHistory: true, summary: "HTTP POST · persistent · RAO stores history" },
  { id: 4, transport: "websocket", sessionMode: "ephemeral", persistHistory: true, summary: "WebSocket · ephemeral · client sends chat_history" },
  { id: 5, transport: "websocket", sessionMode: "ephemeral", persistHistory: false, summary: "WebSocket · ephemeral · no history (baseline)" },
  { id: 6, transport: "websocket", sessionMode: "persistent", persistHistory: true, summary: "WebSocket · persistent · RAO stores history" },
];

export function findScenario({ transport, sessionMode, persistHistory }) {
  const effectiveHistory = sessionMode === "persistent" ? true : persistHistory;
  return SCENARIOS.find(
    (s) => s.transport === transport && s.sessionMode === sessionMode && s.persistHistory === effectiveHistory,
  );
}

const MODULE_TO_STAGE = {
  rephrase: "preprocessing",
  mcp: "retrieval",
  advanced_ask: "retrieval",
  perplexity: "retrieval",
  summarize: "generation",
  remi: "evaluation",
};

function stageFromPacket(packet) {
  const agentPath = packet?.step?.agent_path || "";
  if (agentPath.startsWith("/preprocess/")) return "preprocessing";
  if (agentPath.startsWith("/generation/")) return "generation";
  if (agentPath.startsWith("/context/")) return "retrieval";
  if (packet?.step?.module) return MODULE_TO_STAGE[packet.step.module] || "retrieval";
  if (packet?.answer || packet?.possible_answer) return "generation";
  if (packet?.feedback || packet?.oauth) return "evaluation";
  if (packet?.context) return "retrieval";
  return "retrieval";
}

function isUsefulPacket(packet) {
  if (!packet || typeof packet !== "object") return false;
  if (packet.step) return true;
  if (packet.answer || packet.context || packet.exception) return true;
  return false;
}

function shouldIgnoreStep(step) {
  if (!step || typeof step !== "object") return false;
  const moduleName = String(step.module || "").toLowerCase();
  const title = String(step.title || "").toLowerCase();
  const value = String(step.value || "").trim().toLowerCase();

  if (title.includes(": context validation")) return true;

  if (moduleName === "mcp") {
    if (title === "mcp: prompt selection") return true;
    if (title === "mcp: tool error") return true;
    if (title === "mcp: interaction finished") return true;
    if (title === "mcp: tool result" && value === "no tool used") return true;
  }

  if (moduleName === "advanced_ask" && title === "knowledge box advanced ask: rag retrieval") {
    if (value === "not enough data to answer this.") return true;
  }

  return false;
}

function extractSubqueryHint(packet) {
  const step = packet?.step;
  if (!step) return null;
  const title = String(step.title || "").toLowerCase();
  const value = String(step.value || "").trim();

  if (!value) return null;
  if (
    title === "mcp: context validation" ||
    title === "perplexity answer: context validation" ||
    title === "knowledge box advanced ask: context validation"
  ) {
    return value;
  }
  return null;
}

function extractOutputMarkdown(packet) {
  if (packet?.step?.value) return String(packet.step.value);
  if (packet?.context?.summary) return String(packet.context.summary);
  if (packet?.exception?.detail) return String(packet.exception.detail);
  return "";
}

function extractReasoning(packet) {
  if (packet?.step?.reason) return String(packet.step.reason);
  if (packet?.step?.title) return String(packet.step.title);
  return "";
}

const SOURCE_TOKEN_ALIASES = {
  ai: "AI",
  api: "API",
  db: "DB",
  kb: "KB",
  llm: "LLM",
  mcp: "MCP",
  rag: "RAG",
  sse: "SSE",
  ui: "UI",
  ux: "UX",
  ws: "WS",
};

const SOURCE_SUFFIX_ALIASES = ["ai", "api", "db", "kb", "ui"];

function formatSourceToken(token) {
  if (!token) return "";

  const trimmed = token.trim();
  if (!trimmed) return "";

  const normalized = trimmed.toLowerCase();
  if (SOURCE_TOKEN_ALIASES[normalized]) {
    return SOURCE_TOKEN_ALIASES[normalized];
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  if (/[A-Z]/.test(trimmed.slice(1))) {
    return trimmed;
  }

  for (const suffix of SOURCE_SUFFIX_ALIASES) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      const prefix = normalized.slice(0, -suffix.length);
      return `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}${SOURCE_TOKEN_ALIASES[suffix]}`;
    }
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function normalizeSourceLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.trim().replace(/([a-z0-9])([A-Z])/g, "$1 $2");

  if (!label) return null;

  const parts = label
    .split(/[\s_./:-]+/)
    .map((part) => formatSourceToken(part))
    .filter(Boolean);

  if (parts.length === 0) return null;

  return parts.join(" ");
}

function extractPacketSources(packet) {
  const sources = [];
  const seen = new Set();

  const addSource = (value) => {
    const label = normalizeSourceLabel(value);
    const key = label?.toLowerCase();

    if (!label || !key || seen.has(key)) return;
    seen.add(key);
    sources.push(label);
  };

  if (packet?.context) {
    addSource(packet.context.source);

    if (Array.isArray(packet.context.chunks)) {
      for (const chunk of packet.context.chunks) {
        addSource(chunk?.source);
      }
    }

    if (sources.length === 0) {
      addSource(packet.context.agent);
    }
  }

  if (sources.length === 0 && stageFromPacket(packet) === "retrieval") {
    addSource(packet?.step?.module);
  }

  return sources;
}

function formatRephraseOutput(value) {
  if (!value) return value;
  const match = value.match(/^(\d+)\s+questions?\.\s*\nQuestions?:\s*(.+)$/is);
  if (!match) return value;
  const raw = match[2].trim();
  const questions = raw.split(/\?,\s+/).map((q, i, arr) =>
    i < arr.length - 1 ? q.trim() + "?" : q.trim()
  );
  return questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
}

function formatMcpOutput(step) {
  const value = step?.value || "";
  const toolMatch = value.match(/^Used tool:\s*(\S+)\s+with arguments:\s*/);
  if (!toolMatch) return value;
  const tool = toolMatch[1];
  const argsStr = value.slice(toolMatch[0].length);
  const sqlMatch = argsStr.match(/['"](?:query|sql)['"]\s*:\s*['"]?([\s\S]+?)['"]?\s*[,}]/);
  if (sqlMatch) {
    return `**\`${tool}\`**\n\`\`\`sql\n${sqlMatch[1].trim()}\n\`\`\``;
  }
  return `**\`${tool}\`**\n\`\`\`\n${argsStr}\n\`\`\``;
}

function parseMcpError(errorStr) {
  if (!errorStr) return null;
  try {
    const obj = JSON.parse(errorStr);
    return obj?.error?.message || obj?.message || errorStr;
  } catch {
    return errorStr;
  }
}

function extractChunkUrls(packet) {
  if (!packet?.context?.chunks) return [];
  const urls = [];
  const seen = new Set();
  for (const chunk of packet.context.chunks) {
    if (Array.isArray(chunk.url)) {
      for (const u of chunk.url) {
        if (typeof u === "string" && u && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
    }
    if (typeof chunk.origin_url === "string" && chunk.origin_url && !seen.has(chunk.origin_url)) {
      seen.add(chunk.origin_url);
      urls.push(chunk.origin_url);
    }
  }
  return urls;
}

function extractChunkDocs(packet) {
  if (!packet?.context?.chunks) return [];
  const docs = [];
  const seen = new Set();
  const isKBContext = packet?.context?.agent === "advanced_ask";
  for (const chunk of packet.context.chunks) {
    const isKBChunk = chunk?.origin_agent === "advanced_ask" || isKBContext;
    if (isKBChunk && chunk?.title) {
      const clean = chunk.title
        .replace(/\.[a-z]+$/i, "")
        .replace(/[-_]+/g, " ")
        .trim();
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        docs.push(clean);
      }
    }
  }
  return docs;
}

async function streamSse({ endpoint, payload, onEvent, signal }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Stream failed (${response.status}): ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let shouldStop = false;

  while (!shouldStop) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const eventText of events) {
      const lines = eventText.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) continue;

      const event = eventLine.slice(7).trim();
      const raw = dataLine.slice(6);
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        // keep raw payload
      }
      const keepStreaming = onEvent({ event, data });
      if (keepStreaming === false) {
        shouldStop = true;
        break;
      }
    }
  }

  try {
    await reader.cancel();
  } catch {
    // noop
  }
}

function MarkdownBlock({ text }) {
  return (
    <Box className="md-block">
      <ReactMarkdown>{text || ""}</ReactMarkdown>
    </Box>
  );
}

const composerTextareaStyles = {
  input: {
    backgroundColor: "#ffffff",
    color: "#203026",
    borderColor: "#cfddd1",
    boxShadow: "none",
    caretColor: "#4b9b79",
    "&::placeholder": {
      color: "#667268",
    },
    "&:focus": {
      borderColor: "#4b9b79",
    },
  },
};

/**
 * Builds the body sent to the relay server for one turn.
 *
 *   sessionMode "ephemeral"  -> RAO stores nothing. When `persistHistory` is on we send the
 *                               full transcript as `chat_history` on every request.
 *   sessionMode "persistent" -> RAO stores every exchange against `sessionId`. We never send
 *                               `chat_history` (it would override the stored history for that
 *                               request only). The first turn omits `sessionId`; the relay
 *                               creates a session and reports its id on the `ready` event.
 */
export function buildInteractionPayload({ question, sessionMode, persistHistory, history, sessionId }) {
  const interactionRequest = { question, operation: 0, headers: {} };
  const payload = { sessionMode, interactionRequest };

  if (sessionMode === "ephemeral") {
    if (persistHistory) {
      interactionRequest.chat_history = history.map((turn) => ({
        question: turn.question,
        answer: turn.answer,
      }));
    }
    return payload;
  }

  if (sessionId) {
    payload.sessionId = sessionId;
  } else {
    payload.sessionCreatePayload = {
      name: "RAO demo UI conversation",
      summary: "Created from the RAO demo UI",
    };
  }
  return payload;
}

function shortId(value) {
  if (!value) return "";
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

export default function App() {
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [streamMode, setStreamMode] = useState("post");
  const [sessionMode, setSessionMode] = useState("ephemeral");
  const [persistHistory, setPersistHistory] = useState(true);
  const [history, setHistory] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [sessionInfo, setSessionInfo] = useState(null);
  const [answer, setAnswer] = useState("");
  const [lastRequest, setLastRequest] = useState(null);
  const [streamStatus, setStreamStatus] = useState("idle");
  const [activeStage, setActiveStage] = useState("none");
  const [error, setError] = useState("");
  const [traceItems, setTraceItems] = useState([]);
  const [moduleSubqueryHint, setModuleSubqueryHint] = useState({});
  const abortRef = useRef(null);
  // The most recent completed turn. It is committed to `history` when the next question
  // starts, so the current turn is rendered once (with its trace) and not twice.
  const pendingTurnRef = useRef(null);

  const stageBlocks = useMemo(() => {
    const blocks = [];
    let current = null;
    for (const item of traceItems) {
      if (!current || current.stage !== item.stage) {
        current = {
          id: `${item.stage}-${item.id}`,
          stage: item.stage,
          items: [],
          sources: [],
        };
        blocks.push(current);
      }
      current.items.push(item);

      for (const source of item.sources || []) {
        if (!current.sources.includes(source)) {
          current.sources.push(source);
        }
      }
    }
    return blocks;
  }, [traceItems]);

  const resetConversation = () => {
    if (abortRef.current) abortRef.current.abort();
    pendingTurnRef.current = null;
    setHistory([]);
    setSessionId(null);
    setSessionInfo(null);
    setAnswer("");
    setLastRequest(null);
    setSubmittedQuestion("");
    setTraceItems([]);
    setModuleSubqueryHint({});
    setError("");
    setStreamStatus("idle");
    setActiveStage("none");
  };

  const handleSessionModeChange = (value) => {
    // History semantics differ between modes, so switching starts a fresh conversation.
    setSessionMode(value);
    resetConversation();
  };

  const applyScenario = (id) => {
    const scenario = SCENARIOS.find((s) => s.id === Number(id));
    if (!scenario) return;
    setStreamMode(scenario.transport);
    setPersistHistory(scenario.persistHistory);
    if (scenario.sessionMode !== sessionMode) {
      handleSessionModeChange(scenario.sessionMode);
    } else {
      setSessionMode(scenario.sessionMode);
    }
  };

  const scenario = findScenario({ transport: streamMode, sessionMode, persistHistory });

  const runStream = async () => {
    if (!question.trim()) return;

    // Commit the previous turn before building this request so chat_history includes it.
    const nextHistory = pendingTurnRef.current ? [...history, pendingTurnRef.current] : history;
    pendingTurnRef.current = null;
    setHistory(nextHistory);

    const payload = buildInteractionPayload({
      question,
      sessionMode,
      persistHistory,
      history: nextHistory,
      sessionId,
    });
    setLastRequest(payload);

    setStreamStatus("running");
    setSubmittedQuestion(question);
    setError("");
    setAnswer("");
    setTraceItems([]);
    setModuleSubqueryHint({});
    setActiveStage("none");
    setShowSuggestions(false);

    const endpoint =
      streamMode === "post"
        ? `${BACKEND_URL}/api/interactions/stream-post`
        : `${BACKEND_URL}/api/interactions/stream`;

    let stepIndex = 0;
    let capturedAnswer = "";
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamSse({
        endpoint,
        payload,
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (event === "ready") {
            setSessionInfo(data);
            if (sessionMode === "persistent" && data?.sessionId) {
              setSessionId(data.sessionId);
            }
            return true;
          }

          if (event === "error") {
            setError(typeof data === "string" ? data : JSON.stringify(data));
            setStreamStatus("failed");
            setActiveStage("failed");
            return false;
          }

          if (event === "complete") {
            setStreamStatus("done");
            setActiveStage("completed");
            return false;
          }

          if (event !== "packet") {
            return true;
          }

          if (data?.operation === 4) {
            const detail = data?.exception?.detail;
            const errAnswer = typeof data?.answer === "string" ? data.answer : null;
            setError(detail || errAnswer || "Pipeline error");
            setStreamStatus("failed");
            setActiveStage("failed");
            return false;
          }

          if (!isUsefulPacket(data)) {
            return true;
          }

          if (typeof data?.answer === "string" && data.answer.trim()) {
            capturedAnswer = data.answer;
            setAnswer(capturedAnswer);
            setStreamStatus("done");
            setActiveStage("completed");
            return false;
          }

          if (data?.step && shouldIgnoreStep(data.step)) {
            return true;
          }

          const stage = stageFromPacket(data);

          const sources = extractPacketSources(data);
          const urls = extractChunkUrls(data);
          const docs = extractChunkDocs(data);
          const moduleName =
            data?.step?.module || data?.context?.agent || data?.context?.source || "system";
          const title =
            data?.step?.title || (data?.context ? "Context" : "Packet");

          let output = extractOutputMarkdown(data);
          if (moduleName === "rephrase") output = formatRephraseOutput(output);
          else if (moduleName === "mcp") output = formatMcpOutput(data.step);

          const reasoning = extractReasoning(data);
          const subqueryHint = extractSubqueryHint(data);
          const contextQuestion = data?.context?.question || null;
          const questionText =
            subqueryHint || moduleSubqueryHint[moduleName] || contextQuestion || question;
          const timeMs = data?.step?.timeit ? Math.round(Number(data.step.timeit) * 1000) : null;

          const rawError = data?.step?.error || data?.exception?.detail || null;
          const error = moduleName === "mcp" ? parseMcpError(rawError) : rawError;

          if (subqueryHint && moduleName) {
            setModuleSubqueryHint((prev) => ({ ...prev, [moduleName]: subqueryHint }));
          }

          stepIndex += 1;
          setActiveStage(stage);
          setTraceItems((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${stepIndex}`,
              ts: Date.now(),
              stage,
              module: moduleName,
              title,
              sources,
              questionText,
              output,
              reasoning,
              timeMs,
              tokens: {
                in: data?.step?.input_nuclia_tokens ?? null,
                out: data?.step?.output_nuclia_tokens ?? null,
              },
              error,
              urls,
              docs,
            },
          ]);

          return true;
        },
      });

      setStreamStatus((prev) => (prev === "running" ? "done" : prev));
      setActiveStage((prev) => (prev === "none" ? "completed" : prev));

      if (capturedAnswer) {
        pendingTurnRef.current = { question, answer: capturedAnswer };
        setQuestion("");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setStreamStatus("stopped");
        setActiveStage("stopped");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStreamStatus("failed");
      setActiveStage("failed");
    } finally {
      abortRef.current = null;
    }
  };

  const stopStream = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  };

  const handlePrimaryAction = () => {
    if (streamStatus === "running") {
      stopStream();
      return;
    }
    runStream();
  };

  const isRunning = streamStatus === "running";
  const hasConversation = history.length > 0 || Boolean(submittedQuestion);
  const turnsSent = sessionMode === "ephemeral" && persistHistory ? lastRequest?.interactionRequest?.chat_history?.length ?? 0 : null;

  let sessionSummary;
  if (sessionMode === "ephemeral") {
    sessionSummary = persistHistory
      ? `Ephemeral · chat_history sent from UI${lastRequest ? ` (${turnsSent} prior turn${turnsSent === 1 ? "" : "s"})` : ""}`
      : "Ephemeral · no history (each question stands alone)";
  } else {
    sessionSummary = sessionId
      ? `Persistent · session ${shortId(sessionId)} · history kept by RAO`
      : "Persistent · session will be created on first question";
  }

  return (
    <AppShell
      header={{ height: 82 }}
      footer={{ height: 236 }}
      padding="md"
      className="notion-shell"
    >
      <AppShell.Header className="sticky-header">
        <Group px="md" py="sm" h="100%" justify="space-between" wrap="nowrap">
          <Box>
            <Title order={3} className="trace-title">
              Retrieval Agent Orchestrator Demo
            </Title>
            {activeStage !== "none" && (
              <Text
                size="sm"
                className="active-stage-label"
                c={activeStage === "failed" ? "red" : activeStage === "stopped" ? "orange" : undefined}
              >
                {activeStage.charAt(0).toUpperCase() + activeStage.slice(1)}
              </Text>
            )}
          </Box>
          <Box className="session-chip" title={sessionId || ""}>
            {scenario ? `Scenario ${scenario.id} · ` : ""}
            {sessionSummary}
          </Box>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Box p="md" className="stream-container">
          {error ? (
            <Text c="red" fw={600} mb="sm">
              Error: {error}
            </Text>
          ) : null}

          {hasConversation && (
            <ScrollArea h="calc(100vh - 385px)" offsetScrollbars>
              {history.map((turn, index) => (
                <Box key={`turn-${index}`} className="history-turn">
                  <Box className="user-bubble-wrap">
                    <Box className="user-bubble">{turn.question}</Box>
                  </Box>
                  <details className="turn-answer">
                    <summary className="turn-answer-summary">Answer to turn {index + 1}</summary>
                    <MarkdownBlock text={turn.answer} />
                  </details>
                </Box>
              ))}

              {submittedQuestion && (
                <>
                  <Box className="user-bubble-wrap">
                    <Box className="user-bubble">{submittedQuestion}</Box>
                  </Box>
                  {streamStatus === "running" && traceItems.length === 0 && (
                    <Box className="thinking-row">
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                    </Box>
                  )}
                  <Accordion multiple variant="unstyled">
                    {stageBlocks.map((block) => (
                      <Accordion.Item value={block.id} key={block.id}>
                        <Accordion.Control>
                          <Box className="stage-row">
                            <Group gap="xs" className="stage-row-header">
                              <Text fw={700} tt="capitalize" className="stage-name">
                                {block.stage}
                              </Text>
                              <Text c="dimmed" size="sm" className="stage-meta">
                                {block.items.length} {block.items.length === 1 ? "step" : "steps"}
                              </Text>
                            </Group>

                            {block.stage === "retrieval" && block.sources.length > 0 ? (
                              <Group gap="xs" className="stage-source-row">
                                {block.sources.map((source) => (
                                  <Box key={source} className="stage-source-chip">
                                    {source}
                                  </Box>
                                ))}
                              </Group>
                            ) : null}
                          </Box>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Stack gap="sm">
                            {block.items.map((item) => (
                              <div key={item.id} className={`event-card ${item.stage}`}>
                                <details className="event-details" open>
                                  <summary className="event-summary">
                                    <Group justify="space-between" align="center" wrap="nowrap">
                                      <Group gap="xs" wrap="nowrap">
                                        <Text fw={700} className="event-module">
                                          {item.module}
                                        </Text>
                                        <Text size="sm" className="event-title" truncate>
                                          {item.title}
                                        </Text>
                                      </Group>
                                      <Text size="xs" c="dimmed">
                                        {new Date(item.ts).toLocaleTimeString()}
                                      </Text>
                                    </Group>
                                  </summary>

                                  {item.questionText ? (
                                    <>
                                      <Text fw={700} size="sm" mb={4} className="content-label">
                                        Sub-query
                                      </Text>
                                      <Text size="sm" className="question-copy">
                                        {item.questionText}
                                      </Text>
                                    </>
                                  ) : null}

                                  {item.output ? (
                                    <>
                                      <Text fw={700} size="sm" mt="md" mb={4} className="content-label">
                                        Output
                                      </Text>
                                      <MarkdownBlock text={item.output} />
                                    </>
                                  ) : null}

                                  {item.urls?.length > 0 ? (
                                    <Box mt="sm">
                                      <Text fw={700} size="xs" mb={4} className="content-label">
                                        Web sources
                                      </Text>
                                      <Stack gap={2}>
                                        {item.urls.slice(0, 5).map((url, i) => {
                                          let label = url;
                                          try { label = new URL(url).hostname.replace(/^www\./, ""); } catch {}
                                          return (
                                            <Text key={i} size="xs">
                                              <a href={url} target="_blank" rel="noopener noreferrer" className="source-link">
                                                {label}
                                              </a>
                                            </Text>
                                          );
                                        })}
                                        {item.urls.length > 5 ? (
                                          <Text size="xs" c="dimmed">+{item.urls.length - 5} more</Text>
                                        ) : null}
                                      </Stack>
                                    </Box>
                                  ) : null}

                                  {item.docs?.length > 0 ? (
                                    <Box mt="sm">
                                      <Text fw={700} size="xs" mb={4} className="content-label">
                                        Documents
                                      </Text>
                                      <Group gap="xs" wrap="wrap">
                                        {item.docs.map((doc, i) => (
                                          <Box key={i} className="doc-chip" title={doc}>{doc}</Box>
                                        ))}
                                      </Group>
                                    </Box>
                                  ) : null}

                                  {item.reasoning ? (
                                    <Text size="sm" mt="sm" className="reasoning-copy">
                                      {item.reasoning}
                                    </Text>
                                  ) : null}

                                  <Group gap="xs" mt="sm">
                                    {item.timeMs ? (
                                      <Box className="meta-chip">
                                        {item.timeMs >= 1000
                                          ? `${(item.timeMs / 1000).toFixed(1)} s`
                                          : `${item.timeMs} ms`}
                                      </Box>
                                    ) : null}
                                    {item.tokens.in !== null ? (
                                      <Box className="meta-chip">in: {item.tokens.in}</Box>
                                    ) : null}
                                    {item.tokens.out !== null ? (
                                      <Box className="meta-chip">out: {item.tokens.out}</Box>
                                    ) : null}
                                  </Group>

                                  {item.error ? (
                                    <Text c="red" size="sm" mt="sm" fw={600}>
                                      {item.error}
                                    </Text>
                                  ) : null}
                                </details>
                              </div>
                            ))}
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    ))}
                  </Accordion>

                  {answer ? (
                    <Box className="answer-block">
                      <Text fw={700} size="sm" mb={6} className="content-label">
                        Answer
                      </Text>
                      <MarkdownBlock text={answer} />
                    </Box>
                  ) : null}
                </>
              )}

              {lastRequest ? (
                <details className="payload-block">
                  <summary className="payload-summary">
                    Request payload sent to the relay
                    {sessionInfo?.upstream ? ` → ${sessionInfo.upstream}` : ""}
                  </summary>
                  <pre>{JSON.stringify(lastRequest, null, 2)}</pre>
                </details>
              ) : null}
            </ScrollArea>
          )}
        </Box>
      </AppShell.Main>

      <AppShell.Footer className="sticky-composer">
        <Box p="md" className="composer-wrap">
          {showSuggestions && (
            <Box className="suggestions-panel">
              {SAMPLE_QUERIES.map((q, i) => (
                <Box
                  key={i}
                  className="suggestion-item"
                  onClick={() => {
                    setQuestion(q);
                    setShowSuggestions(false);
                  }}
                >
                  {q}
                </Box>
              ))}
            </Box>
          )}
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                setShowSuggestions((prev) => !prev);
                return;
              }
              if (e.key === "Escape" && showSuggestions) {
                setShowSuggestions(false);
                return;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handlePrimaryAction();
            }}
            autosize
            minRows={2}
            maxRows={2}
            placeholder={
              history.length > 0 || pendingTurnRef.current
                ? "Ask a follow-up… (Tab for examples)"
                : "Ask a question… (Tab for examples)"
            }
            styles={composerTextareaStyles}
          />
          <Group gap="xs" align="center" mt="xs" wrap="wrap" className="scenario-row">
            <Text size="xs" c="dimmed">Scenario:</Text>
            <SegmentedControl
              size="xs"
              value={scenario ? String(scenario.id) : ""}
              onChange={applyScenario}
              disabled={isRunning}
              data={SCENARIOS.map((s) => ({ label: String(s.id), value: String(s.id) }))}
            />
            <Text size="xs" className="scenario-summary">
              {scenario ? scenario.summary : "custom"}
            </Text>
          </Group>
          <Group justify="space-between" mt="xs" align="center" wrap="wrap">
            <Group gap="md" align="center" wrap="wrap">
              <Group gap="xs" align="center">
                <Text size="xs" c="dimmed">Transport:</Text>
                <SegmentedControl
                  size="xs"
                  value={streamMode}
                  onChange={setStreamMode}
                  disabled={isRunning}
                  data={[
                    { label: "HTTP POST", value: "post" },
                    { label: "WebSocket", value: "websocket" },
                  ]}
                />
              </Group>
              <Group gap="xs" align="center">
                <Text size="xs" c="dimmed">Session:</Text>
                <SegmentedControl
                  size="xs"
                  value={sessionMode}
                  onChange={handleSessionModeChange}
                  disabled={isRunning}
                  data={[
                    { label: "Ephemeral", value: "ephemeral" },
                    { label: "Persistent", value: "persistent" },
                  ]}
                />
              </Group>
              <Switch
                size="xs"
                className="history-switch"
                checked={sessionMode === "ephemeral" ? persistHistory : true}
                disabled={sessionMode === "persistent" || isRunning}
                onChange={(e) => setPersistHistory(e.currentTarget.checked)}
                label={
                  sessionMode === "ephemeral"
                    ? "Persist history (send chat_history)"
                    : "History kept by RAO session"
                }
              />
            </Group>
            <Group gap="xs">
              <Button
                variant="default"
                className="secondary-action-btn"
                onClick={resetConversation}
                disabled={isRunning || !hasConversation}
              >
                New chat
              </Button>
              <Button
                onClick={handlePrimaryAction}
                className="primary-action-btn"
                disabled={!question.trim() && streamStatus !== "running"}
              >
                {streamStatus === "running" ? "Stop" : "Submit"}
              </Button>
            </Group>
          </Group>
        </Box>
      </AppShell.Footer>
    </AppShell>
  );
}
