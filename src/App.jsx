import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Accordion,
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";

const BACKEND_URL = "http://127.0.0.1:3001";
const DEFAULT_SESSION_ID = "77e3e4168b314452b68ac57c6859bb4b";
const SAMPLE_QUESTION =
  "What are the major equity investment trends in the US and globally in early 2025, what are the top 5 holdings by weight in each of our portfolios as of 31 Jan 2025, and how do our current exposures align or diverge from those trends?";

const MODULE_TO_STAGE = {
  rephrase: "preprocessing",
  mcp: "retrieval",
  advanced_ask: "retrieval",
  perplexity: "retrieval",
  summarize: "generation",
  remi: "evaluation",
};

function stageFromPacket(packet) {
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

export default function App() {
  const [question, setQuestion] = useState(SAMPLE_QUESTION);
  const [streamStatus, setStreamStatus] = useState("idle");
  const [activeStage, setActiveStage] = useState("none");
  const [error, setError] = useState("");
  const [traceItems, setTraceItems] = useState([]);
  const [moduleSubqueryHint, setModuleSubqueryHint] = useState({});
  const abortRef = useRef(null);

  const stageBlocks = useMemo(() => {
    const blocks = [];
    let current = null;
    for (const item of traceItems) {
      if (!current || current.stage !== item.stage) {
        current = {
          id: `${item.id}-block`,
          stage: item.stage,
          items: [],
        };
        blocks.push(current);
      }
      current.items.push(item);
    }
    return blocks;
  }, [traceItems]);

  const defaultOpen = useMemo(() => stageBlocks.map((b) => b.id), [stageBlocks]);

  const runStream = async () => {
    if (!question.trim()) return;

    setStreamStatus("running");
    setError("");
    setTraceItems([]);
    setModuleSubqueryHint({});
    setActiveStage("none");

    const endpoint = `${BACKEND_URL}/api/interactions/stream`;
    const payload = {
      sessionId: DEFAULT_SESSION_ID,
      interactionRequest: {
        question,
        operation: 0,
        headers: {},
      },
    };

    let stepIndex = 0;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamSse({
        endpoint,
        payload,
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (event === "error") {
            setError(typeof data === "string" ? data : JSON.stringify(data));
            setStreamStatus("failed");
            setActiveStage("none");
            return false;
          }

          if (event === "complete") {
            setStreamStatus("done");
            setActiveStage("none");
            return false;
          }

          if (event !== "packet" || !isUsefulPacket(data)) {
            return true;
          }

          if (typeof data?.answer === "string" && data.answer.trim()) {
            setStreamStatus("done");
            setActiveStage("none");
            return false;
          }

          if (data?.step && shouldIgnoreStep(data.step)) {
            return true;
          }

          const stage = stageFromPacket(data);
          if (data?.possible_answer?.answer) {
            return true;
          }

          const moduleName = data?.step?.module || "system";
          const title =
            data?.step?.title || (data?.context ? "Context" : "Packet");
          const output = extractOutputMarkdown(data);
          const reasoning = extractReasoning(data);
          const subqueryHint = extractSubqueryHint(data);
          const contextQuestion = data?.context?.question || null;
          const questionText =
            subqueryHint || moduleSubqueryHint[moduleName] || contextQuestion || question;
          const timeMs = data?.step?.timeit ? Math.round(Number(data.step.timeit) * 1000) : null;

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
              questionText,
              output,
              reasoning,
              timeMs,
              tokens: {
                in: data?.step?.input_nuclia_tokens ?? null,
                out: data?.step?.output_nuclia_tokens ?? null,
              },
              error: data?.step?.error || data?.exception?.detail || null,
            },
          ]);

          return true;
        },
      });

      setStreamStatus((prev) => (prev === "running" ? "done" : prev));
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setStreamStatus("stopped");
        setActiveStage("none");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStreamStatus("failed");
      setActiveStage("none");
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

  return (
    <AppShell
      header={{ height: 82 }}
      footer={{ height: 170 }}
      padding="md"
      className="notion-shell"
    >
      <AppShell.Header className="sticky-header">
        <Group justify="space-between" px="md" py="sm" h="100%">
          <Box>
            <Title order={3} className="trace-title">
              RAO Trace Chat
            </Title>
            <Text size="sm" className="active-stage-label">
              Active stage: {activeStage}
            </Text>
          </Box>
          <Badge
            variant="light"
            color={
              streamStatus === "failed"
                ? "red"
                : streamStatus === "done"
                  ? "green"
                  : streamStatus === "stopped"
                    ? "yellow"
                    : "blue"
            }
          >
            {streamStatus}
          </Badge>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Box p="md" className="stream-container">
          {error ? (
            <Text c="red" fw={600} mb="sm">
              Error: {error}
            </Text>
          ) : null}

          {traceItems.length === 0 ? (
            <Text c="dimmed">Submit a prompt to begin streaming trace events.</Text>
          ) : (
            <ScrollArea h="calc(100vh - 320px)" offsetScrollbars>
              <Box className="user-bubble-wrap">
                <Box className="user-bubble">{question}</Box>
              </Box>
              <Accordion multiple defaultValue={defaultOpen} variant="unstyled">
                {stageBlocks.map((block, idx) => (
                  <Accordion.Item value={block.id} key={block.id}>
                    <Accordion.Control>
                      <Group gap="xs" className="stage-row">
                        <Text fw={700} tt="capitalize" className="stage-name">
                          {block.stage}
                        </Text>
                        <Text c="dimmed" size="sm" className="stage-meta">
                          block {idx + 1} ({block.items.length} events)
                        </Text>
                      </Group>
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

                              <Text fw={700} size="sm" mb={4} className="content-label">
                                Question
                              </Text>
                              <Text size="sm" className="question-copy">
                                {item.questionText}
                              </Text>

                              {item.output ? (
                                <>
                                  <Text fw={700} size="sm" mt="md" mb={4} className="content-label">
                                    Output
                                  </Text>
                                  <MarkdownBlock text={item.output} />
                                </>
                              ) : null}

                              {item.reasoning ? (
                                <Text size="sm" mt="sm" className="reasoning-copy">
                                  {item.reasoning}
                                </Text>
                              ) : null}

                              <Group gap="xs" mt="sm">
                                {item.timeMs ? (
                                  <Badge variant="light" color="gray">
                                    {item.timeMs} ms
                                  </Badge>
                                ) : null}
                                {item.tokens.in !== null ? (
                                  <Badge variant="light" color="gray">
                                    in: {item.tokens.in}
                                  </Badge>
                                ) : null}
                                {item.tokens.out !== null ? (
                                  <Badge variant="light" color="gray">
                                    out: {item.tokens.out}
                                  </Badge>
                                ) : null}
                              </Group>

                              {item.error ? (
                                <Text c="red" size="sm" mt="sm" fw={600}>
                                  Module error: {item.error}
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
            </ScrollArea>
          )}
        </Box>
      </AppShell.Main>

      <AppShell.Footer className="sticky-composer">
        <Box p="md" className="composer-wrap">
          <Group align="flex-end" wrap="nowrap" gap="sm">
            <Box style={{ flex: 1 }}>
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                autosize
                minRows={2}
                maxRows={5}
                placeholder="Ask a question..."
                styles={composerTextareaStyles}
              />
            </Box>
            <Button
              onClick={handlePrimaryAction}
              className="primary-action-btn"
              disabled={!question.trim() && streamStatus !== "running"}
            >
              {streamStatus === "running" ? "Stop" : "Submit"}
            </Button>
          </Group>
        </Box>
      </AppShell.Footer>
    </AppShell>
  );
}
