/** Semantic roles inspired by agent-toggle's theme. */
export const roles = {
  live: "green",
  parked: "yellow",
  pending: "cyan",
  muted: "gray",
  title: "whiteBright",
  cursor: "whiteBright",
  skill: "magenta",
  mcp: "blue",
  harness: {
    cursor: "white",
    claude: "yellow",
    codex: "cyan",
    pi: "green",
    omp: "magenta",
  } as const,
} as const;

export const glyphs = {
  live: "●",
  parked: "○",
  pointer: "›",
  stagedOn: "+",
  stagedOff: "-",
} as const;
