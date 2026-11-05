/**
 * Conservative local overlay moderation; not a substitute for a real human moderator.
 * Do not censor religious discussion based on guessed semantics.
 */
export function createModerationPolicy({ now = () => Date.now(), commentCooldownMs = 2500 } = {}) {
  const lastCommentByUser = new Map();
  return {
    check(event) {
      if (event.type !== "comment") return { allowed: true, event };
      const key = event.user.toLocaleLowerCase("en");
      const current = now();
      const previous = lastCommentByUser.get(key);
      if (previous !== undefined && current - previous < commentCooldownMs) {
        return { allowed: false, reason: "Comment cooldown" };
      }
      const message = event.message
        .replace(/https?:\/\/\S+|www\.\S+/gi, "[link hidden]")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ").trim();
      if (!message) return { allowed: false, reason: "Empty comment" };
      if (lastCommentByUser.size > 1000) lastCommentByUser.clear();
      lastCommentByUser.set(key, current);
      return { allowed: true, event: { ...event, message } };
    }
  };
}
