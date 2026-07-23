// Use U+25CF instead of U+23FA to avoid emoji/fallback rendering in terminals.
export const STATUS_BULLET = '● ';

// Thinking blocks get a hollow marker so they read distinctly from assistant
// messages at a glance (both used to share STATUS_BULLET and differed only by
// dim coloring). Same width family as STATUS_BULLET to keep wrapping stable.
export const THINKING_BULLET = '○ ';

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const USER_MESSAGE_BULLET = '✨ ';
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';

// Shared selector markers — keep every list picker visually consistent.
// SELECT_POINTER marks the highlighted row; CURRENT_MARK is appended to the
// row that is the currently-active value. See .agents/skills/write-tui/DESIGN.md.
export const SELECT_POINTER = '❯';
export const CURRENT_MARK = '← current';
