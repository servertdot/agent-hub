/** Keep cursor visible inside a fixed-height window (agent-toggle style). */

export function pageSize(termRows: number, chromeRows: number): number {
  // title + filter + header + footer ≈ chromeRows; leave at least 5 list lines
  return Math.max(5, termRows - chromeRows);
}

export function scrollToKeepCursor(
  cursor: number,
  scrollTop: number,
  page: number,
  total: number,
): number {
  if (total <= 0 || page <= 0) return 0;
  const maxTop = Math.max(0, total - page);
  let top = Math.min(Math.max(0, scrollTop), maxTop);
  if (cursor < top) top = cursor;
  else if (cursor >= top + page) top = cursor - page + 1;
  return Math.min(Math.max(0, top), maxTop);
}

export function windowSlice<T>(
  items: T[],
  scrollTop: number,
  page: number,
): { slice: T[]; start: number; end: number } {
  const start = Math.max(0, Math.min(scrollTop, Math.max(0, items.length - 1)));
  const end = Math.min(items.length, start + page);
  return { slice: items.slice(start, end), start, end };
}
