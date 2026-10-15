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
  const v = value.trim();
  // Paths and URLs are config, not secrets
  if (
    /^https?:\/\//i.test(v) ||
    v.startsWith("/") ||
    v.startsWith("~/") ||
    v.startsWith("./") ||
    v.startsWith("../")
  ) {
    return false;
  }
  if (SECRET_VALUE.test(v)) return true;
  // Long opaque tokens without spaces
  if (
    v.length >= 24 &&
    !/\s/.test(v) &&
    /^[A-Za-z0-9._+=-]+$/.test(v) &&
    /[0-9]/.test(v)
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

/** Full secret → $ENV for in-file rewrite. Never log `secret`. */
export type ScrubReplacement = {
  path: string;
  secret: string;
  ref: string;
  /** When set, replace this full arg/assignment string, not only the secret. */
  whole?: string;
  wholeTo?: string;
};

function redactPreview(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function scrubArg(
  name: string,
  arg: string,
  index: number,
): {
  arg: string;
  hit?: ScrubHit;
  replacement?: ScrubReplacement;
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
  const next = `${flag}${envName}`;
  return {
    arg: next,
    hit: {
      path: `${name}.args[${index}]`,
      from: redactPreview(raw),
      to: envName,
    },
    replacement: {
      path: `${name}.args[${index}]`,
      secret: raw,
      ref: envName,
      whole: arg,
      wholeTo: next,
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
): {
  server: McpServer;
  hits: ScrubHit[];
  replacements: ScrubReplacement[];
} {
  const hits: ScrubHit[] = [];
  const replacements: ScrubReplacement[] = [];
  const next: McpServer = { ...server };

  if (server.args) {
    next.args = server.args.map((arg, i) => {
      const { arg: scrubbed, hit, replacement } = scrubArg(name, arg, i);
      if (hit) hits.push(hit);
      if (replacement) replacements.push(replacement);
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
        replacements.push({ path: `${name}.env.${k}`, secret: v, ref });
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
        replacements.push({ path: `${name}.headers.${k}`, secret: v, ref });
        headers[k] = ref;
      } else {
        headers[k] = v;
      }
    }
    next.headers = headers;
  }

  return { server: next, hits, replacements };
}

/**
 * Apply secret→$ENV replacements to raw file text (preserves JSONC comments).
 * Prefers whole-string replaces for CLI args; otherwise replaces secret substrings.
 */
export function applyReplacementsToText(
  raw: string,
  replacements: ScrubReplacement[],
): { text: string; applied: number } {
  let text = raw;
  let applied = 0;
  const ordered = [...replacements].sort(
    (a, b) =>
      (b.whole?.length ?? b.secret.length) - (a.whole?.length ?? a.secret.length),
  );
  for (const r of ordered) {
    if (r.whole && r.wholeTo && text.includes(r.whole)) {
      text = text.split(r.whole).join(r.wholeTo);
      applied++;
      continue;
    }
    if (r.secret.length >= 8 && text.includes(r.secret)) {
      text = text.split(r.secret).join(r.ref);
      applied++;
    }
  }
  return { text, applied };
}

export function scrubMcpCatalog(servers: Record<string, McpServer>): {
  servers: Record<string, McpServer>;
  hits: ScrubHit[];
  replacements: ScrubReplacement[];
} {
  const out: Record<string, McpServer> = {};
  const hits: ScrubHit[] = [];
  const replacements: ScrubReplacement[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const scrubbed = scrubMcpServer(name, server);
    out[name] = scrubbed.server;
    hits.push(...scrubbed.hits);
    replacements.push(...scrubbed.replacements);
  }
  return { servers: out, hits, replacements };
}

/** Collect replacements from a loose MCP server JSON object (extra fields ok). */
export function collectReplacementsFromRawServer(
  name: string,
  raw: Record<string, unknown>,
): { hits: ScrubHit[]; replacements: ScrubReplacement[] } {
  const server: McpServer = {};
  if (typeof raw.command === "string") server.command = raw.command;
  if (Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string")) {
    server.args = raw.args as string[];
  }
  if (raw.env && typeof raw.env === "object") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
    server.env = env;
  }
  if (raw.headers && typeof raw.headers === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      raw.headers as Record<string, unknown>,
    )) {
      if (typeof v === "string") headers[k] = v;
    }
    server.headers = headers;
  }
  const { hits, replacements } = scrubMcpServer(name, server);
  return { hits, replacements };
}
