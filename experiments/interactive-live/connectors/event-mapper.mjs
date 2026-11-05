const asText = (v) => String(v ?? "");
const actor = (data) => data?.user?.uniqueId || data?.user?.nickname || "Guest";
const eventId = (data) => asText(data?.msgId || data?.common?.msgId || "").slice(0, 120);
const positiveInt = (value, fallback = 1) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

export function fromTikTokEvent(type, data = {}) {
  if (!data || typeof data !== "object") return null;
  const user = actor(data), id = eventId(data);
  switch (type) {
    case "chat":
      return { type: "comment", id, user, message: asText(data.comment) };
    case "like":
      return { type: "like", id, user, count: positiveInt(data.likeCount) };
    case "follow":
      return { type: "follow", id, user };
    case "gift": {
      // TikTok sends intermediate updates for streak gifts. Only final result is billable-like.
      if (Number(data.giftDetails?.giftType) === 1 && !data.repeatEnd) return null;
      const count = positiveInt(data.repeatCount);
      return {
        type: "gift", id: id ? id + ":gift:" + count : "",
        user, gift: data.giftDetails?.giftName || asText(data.giftId || "Gift"), count
      };
    }
    default: return null;
  }
}
