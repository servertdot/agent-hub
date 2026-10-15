import type { McpServer } from "./types.ts";

const SENSITIVE_KEY =
  /(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|private[_-]?key)/i;

/** Values that look like pasted secrets (not $ENV refs). */
const SECRET_VALUE =
  /^(figd_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}(?:\.[A-Za-z0-9_-]+)?)$/i;

const ARG_SECRET_FLAG =
  /^--?(?:figma-api-key|api-key|api_key|token|access-token|auth-token|secret)=(.*)$/i;

export function isEnvRef(value: string): boolean {
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

export function looksLikeSecretValue(value: string): boolean {
  if (!value || isEnvRef(value)) return false;
  if (SECRET_VALUE.test(value.trim())) return true;
  // Long opaque tokens without spaces / URLs
  if (
    value.length >= 24 &&
    !/\s/.test(value) &&
    !/^https?:\/\//i.test(value) &&
    /^[A-Za-z0-9._+/=-]+$/.test(value) &&
    /[0-9]/.test(value)
  ) {
    return true;
  }
  return false;
}

export function envRefForKey(key: string): string {
  const normalized = key
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `$${normalized || "SECRET"}`;
}

export type ScrubHit = {
  path: string;
  from: string;
  to: string;
};

function redactPreview(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function scrubArg(name: string, arg: string, index: number): {
  arg: string;
  hit?: ScrubHit;
} {
  const m = arg.match(ARG_SECRET_FLAG);
  if (!m) return { arg };
  const raw = m[1] ?? "";
  if (isEnvRef(raw)) return { arg };
  const eq = arg.indexOf("=");
  const flag = arg.slice(0, eq + 1);
  const envName = /figma/i.test(flag)
    ? "$FIGMA_API_KEY"
    : envRefForKey(flag.replace(/^--?/, "").replace(/=$/, ""));
  return {
    arg: `${flag}${envName}`,
    hit: {
      path: `${name}.args[${index}]`,
      from: redactPreview(raw),
      to: envName,
    },
  };
}

/**
 * Replace pasted secrets with $ENV refs in an MCP server definition.
 * Leaves non-secret config (URLs, space ids, paths) alone.
 */
export function scrubMcpServer(
  name: string,
  server: McpServer,
): { server: McpServer; hits: ScrubHit[] } {
  const hits: ScrubHit[] = [];
  const next: McpServer = { ...server };

  if (server.args) {
    next.args = server.args.map((arg, i) => {
      const { arg: scrubbed, hit } = scrubArg(name, arg, i);
      if (hit) hits.push(hit);
      return scrubbed;
    });
  }

  if (server.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) {
      if (isEnvRef(v)) {
        env[k] = v;
        continue;
      }
      if (SENSITIVE_KEY.test(k) || looksLikeSecretValue(v)) {
        const ref = envRefForKey(k);
        hits.push({
          path: `${name}.env.${k}`,
          from: redactPreview(v),
          to: ref,
        });
        env[k] = ref;
      } else {
        env[k] = v;
      }
    }
    next.env = env;
  }

  if (server.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.headers)) {
      if (isEnvRef(v)) {
        headers[k] = v;
        continue;
      }
      if (SENSITIVE_KEY.test(k) || looksLikeSecretValue(v)) {
        const ref = envRefForKey(k);
        hits.push({
          path: `${name}.headers.${k}`,
          from: redactPreview(v),
          to: ref,
        });
        headers[k] = ref;
      } else {
        headers[k] = v;
      }
    }
    next.headers = headers;
  }

  return { server: next, hits };
}

export function scrubMcpCatalog(servers: Record<string, McpServer>): {
  servers: Record<string, McpServer>;
  hits: ScrubHit[];
} {
  const out: Record<string, McpServer> = {};
  const hits: ScrubHit[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const scrubbed = scrubMcpServer(name, server);
    out[name] = scrubbed.server;
    hits.push(...scrubbed.hits);
  }
  return { servers: out, hits };
}
