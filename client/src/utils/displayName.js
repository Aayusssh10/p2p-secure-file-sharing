export const MAX_NAME_LENGTH = 20;
export const DEFAULT_DISPLAY_NAME = "Anonymous Peer";

// Small, non-exhaustive blocklist — enough to demonstrate basic profanity
// filtering without trying to be a comprehensive moderation system.
const BLOCKED_WORDS = ["fuck", "shit", "bitch", "asshole", "bastard", "dick", "cunt"];

// Trims, strips angle brackets (the only characters that could ever form a
// tag when interpolated as text — React already escapes JSX text nodes, this
// is belt-and-suspenders), caps length, and falls back to a safe default for
// empty or blocklisted input.
export function sanitizeDisplayName(raw) {
  if (typeof raw !== "string") return DEFAULT_DISPLAY_NAME;

  const cleaned = raw.replace(/[<>]/g, "").trim().slice(0, MAX_NAME_LENGTH);
  if (!cleaned) return DEFAULT_DISPLAY_NAME;

  const lower = cleaned.toLowerCase();
  if (BLOCKED_WORDS.some((word) => lower.includes(word))) return DEFAULT_DISPLAY_NAME;

  return cleaned;
}
