const TYPES = new Set(["like", "gift", "follow", "comment"]);

function text(value, max = 90) {
  return String(value ?? "").trim().slice(0, max);
}

export function normalizeEvent(input) {
  if (!input || typeof input !== "object" || !TYPES.has(input.type)) {
    throw new Error("Unsupported event type");
  }
  const type = input.type;
  const id = text(input.id, 120);
  const user = text(input.user || "Guest", 40);
  if (type === "like") {
    return { type, id, user, count: Math.min(500, Math.max(1, Number.isFinite(input.count) ? Math.trunc(input.count) : 1)) };
  }
  if (type === "gift") {
    return { type, id, user, gift: text(input.gift || "Gift", 60), count: Math.min(50, Math.max(1, Number.isFinite(input.count) ? Math.trunc(input.count) : 1)) };
  }
  if (type === "comment") {
    const message = text(input.message, 140);
    if (!message) throw new Error("Empty comment");
    return { type, id, user, message };
  }
  return { type, id, user };
}

export function createEngine() {
  const state = {
    likes: 0, gifts: 0, follows: 0, wishes: 0, lastMessage: "",
    lastAction: "The garden is peaceful", sequence: 0
  };
  const seen = new Set();

  function receive(raw) {
    const event = normalizeEvent(raw);
    if (event.id && seen.has(event.id)) return { duplicate: true, state: { ...state }, actions: [] };
    if (event.id) {
      seen.add(event.id);
      if (seen.size > 2000) seen.delete(seen.values().next().value);
    }
    const actions = [];
    if (event.type === "like") {
      const before = Math.floor(state.likes / 100);
      state.likes += event.count;
      if (Math.floor(state.likes / 100) > before) {
        actions.push({ kind: "lotus", label: "The lotus pond blooms" });
      }
    } else if (event.type === "gift") {
      state.gifts += event.count;
      actions.push({ kind: "lantern", label: event.user + " lit a lantern" });
    } else if (event.type === "follow") {
      state.follows++;
      actions.push({ kind: "bow", label: "Welcome " + event.user });
    } else if (event.type === "comment") {
      state.wishes++;
      state.lastMessage = event.user + ": " + event.message;
      actions.push({ kind: "wish", label: state.lastMessage });
    }
    state.sequence++;
    if (actions.length) state.lastAction = actions[actions.length - 1].label;
    return { duplicate: false, state: { ...state }, actions, event };
  }
  return { receive, snapshot: () => ({ ...state }) };
}
