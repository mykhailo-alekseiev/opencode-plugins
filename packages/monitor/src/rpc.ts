import { Rpc } from "@opencode/plugin/rpc";

export type MonitorSummary = {
  id: string;
  sessionID: string;
  description: string;
  command: string;
  startedAt: number;
  expiresAt: number;
};

const summary = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionID: { type: "string" },
    description: { type: "string" },
    command: { type: "string" },
    startedAt: { type: "number" },
    expiresAt: { type: "number" },
  },
  required: ["id", "sessionID", "description", "command", "startedAt", "expiresAt"],
  additionalProperties: false,
} as const;

function isSummary(value: unknown): value is MonitorSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.sessionID === "string" &&
    typeof item.description === "string" &&
    typeof item.command === "string" &&
    typeof item.startedAt === "number" &&
    typeof item.expiresAt === "number"
  );
}

export function readMonitors(output: unknown): MonitorSummary[] {
  const monitors = output && typeof output === "object" ? (output as Record<string, unknown>).monitors : undefined;
  return Array.isArray(monitors) ? monitors.filter(isSummary) : [];
}

export function readStopped(output: unknown) {
  return Boolean(output && typeof output === "object" && (output as Record<string, unknown>).stopped === true);
}

export const MonitorRpc = Rpc.define({
  id: "mykhailo-monitor",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionIDs: { type: "array", items: { type: "string" } } },
        required: ["sessionIDs"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { monitors: { type: "array", items: summary } },
        required: ["monitors"],
        additionalProperties: false,
      },
    },
    stop: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { stopped: { type: "boolean" } },
        required: ["stopped"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
