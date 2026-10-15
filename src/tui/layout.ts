/** Shared TUI geometry for sidebar + main matrix. */

/** Profile sidebar width (includes trailing gutter). */
export const SIDEBAR_WIDTH = 18;

/** Full-width rows above the body: title. */
export const TITLE_ROWS = 1;

/** Full-width rows below the body: footer. */
export const FOOTER_ROWS = 1;

/**
 * Inside the main column, rows before the scrollable list:
 * kind tabs + column header.
 */
export const MAIN_LIST_CHROME = 2;

/** Reserved inside the list pane for optional ↑ / ↓ scroll markers. */
export const LIST_SCROLL_CHROME = 2;

/** Sidebar header row ("Profiles") sits on the same row as kind tabs. */
export const SIDEBAR_HEADER_ROWS = 1;

/** First terminal row of the body (sidebar + main). */
export const BODY_TOP = TITLE_ROWS;

/** First terminal row where profile names are listed. */
export const PROFILE_LIST_TOP = BODY_TOP + SIDEBAR_HEADER_ROWS;

export function bodyHeight(termRows: number): number {
  return Math.max(5, termRows - TITLE_ROWS - FOOTER_ROWS);
}

export function mainListPage(termRows: number): number {
  return Math.max(
    5,
    bodyHeight(termRows) - MAIN_LIST_CHROME - LIST_SCROLL_CHROME,
  );
}
