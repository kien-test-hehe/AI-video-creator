export function setupStudio({ notify }) {
  const select = document.getElementById("slot-select");
  const title = document.getElementById("world-title");
  const grid = document.getElementById("world-grid");
  const likeThreshold = document.getElementById("like-threshold");
  const giftAction = document.getElementById("gift-action");
  const followAction = document.getElementById("follow-action");
  const commentAction = document.getElementById("comment-action");
  const assetInfo = document.getElementById("selected-asset");
  const fileInput = document.getElementById("glb-file");
  const output = document.getElementById("studio-status");
  let world = null;
  const token = () => document.getElementById("event-token").value;
  const headers = (contentType) => ({ ...(contentType ? { "content-type": contentType } : {}), ...(token() ? { "x-event-token": token() } : {}) });
  const setStatus = (value, error = false) => {
    output.textContent = value;
    output.style.color = error ? "#ffaaa4" : "#a3e3ca";
  };
  function selectedSlot() { return world?.slots.find((v) => v.id === select.value); }
  function showSlot() {
    const slot = selectedSlot();
    if (!slot) return;
    document.getElementById("slot-enabled").checked = slot.enabled;
    for (const [index, axis] of ["x", "y", "z"].entries()) document.getElementById("axis-" + axis).value = slot.position[index];
    document.getElementById("slot-yaw").value = slot.rotationY;
    document.getElementById("slot-scale").value = slot.scale;
    void refreshAssetInfo();
  }
  function setWorld(next) {
    const previous = select.value;
    world = next;
    select.replaceChildren();
    for (const slot of world.slots) {
      const option = document.createElement("option");
      option.value = slot.id;
      option.textContent = slot.id;
      select.appendChild(option);
    }
    if (previous && world.slots.some((s) => s.id === previous)) select.value = previous;
    title.value = world.title;
    grid.checked = world.showGrid;
    likeThreshold.value = world.interactions.likeThreshold;
    giftAction.value = world.interactions.giftAction;
    followAction.value = world.interactions.followAction;
    commentAction.value = world.interactions.commentAction;
    showSlot();
  }
  function updateFromInputs() {
    const slot = selectedSlot();
    if (!slot) throw Error("No slot selected");
    const n = (id) => Number(document.getElementById(id).value);
    slot.position = ["axis-x", "axis-y", "axis-z"].map(n);
    slot.scale = n("slot-scale");
    slot.rotationY = n("slot-yaw");
    slot.enabled = document.getElementById("slot-enabled").checked;
    world.title = title.value;
    world.showGrid = grid.checked;
    world.interactions = {
      likeThreshold: n("like-threshold"),
      giftAction: giftAction.value, followAction: followAction.value, commentAction: commentAction.value
    };
  }
  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok) throw Error(body.error || "Request failed (" + response.status + ")");
    return body;
  }
  async function refreshAssetInfo() {
    try {
      const all = await request("/api/assets");
      const current = all.find((v) => v.id === select.value);
      assetInfo.textContent = current?.present ? "Uploaded GLB · " + (current.size / 1024 / 1024).toFixed(2) + " MB" : "No GLB uploaded — procedural/empty fallback";
    } catch (error) { assetInfo.textContent = error.message; }
  }
  select.addEventListener("change", showSlot);
  document.getElementById("save-world").addEventListener("click", async () => {
    try {
      updateFromInputs();
      setWorld(await request("/api/world", { method: "PUT", headers: headers("application/json"), body: JSON.stringify(world) }));
      setStatus("World and rules saved");
    } catch (error) { setStatus(error.message, true); }
  });
  document.getElementById("upload-glb").addEventListener("click", async () => {
    try {
      const file = fileInput.files[0];
      if (!file || !file.name.toLowerCase().endsWith(".glb")) throw Error("Select a .glb file");
      if (file.size > 30 * 1024 * 1024) throw Error("GLB too large (30 MB max)");
      await request("/api/assets/" + select.value, {
        method: "POST", headers: headers("model/gltf-binary"), body: file
      });
      await refreshAssetInfo();
      setStatus("Uploaded " + file.name + " to " + select.value);
    } catch (error) { setStatus(error.message, true); }
  });
  document.getElementById("delete-glb").addEventListener("click", async () => {
    if (!confirm("Remove custom GLB from slot " + select.value + "?")) return;
    try {
      await request("/api/assets/" + select.value, { method: "DELETE", headers: headers() });
      await refreshAssetInfo();
      setStatus("Custom GLB removed; fallback restored");
    } catch (error) { setStatus(error.message, true); }
  });
  document.getElementById("export-world").addEventListener("click", () => {
    if (!world) return;
    updateFromInputs();
    const blob = new Blob([JSON.stringify(world, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "interactive-world.json";
    anchor.click();
    URL.revokeObjectURL(url);
  });
  document.getElementById("import-world").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 20000) throw Error("World JSON too large");
      const next = JSON.parse(await file.text());
      setWorld(await request("/api/world", { method: "PUT", headers: headers("application/json"), body: JSON.stringify(next) }));
      setStatus("World config imported");
    } catch (error) { setStatus(error.message, true); }
    event.target.value = "";
  });
  async function updateMetrics() {
    try {
      const v = await request("/api/metrics");
      document.getElementById("studio-metrics").textContent =
        "Processed " + v.accepted + " · duplicates " + v.duplicate + " · blocked " + v.rejected + " · viewers " + v.clients;
    } catch { document.getElementById("studio-metrics").textContent = "Backend disconnected"; }
  }
  const refreshId = setInterval(() => void updateMetrics(), 4000);
  window.addEventListener("beforeunload", () => clearInterval(refreshId), { once: true });
  void request("/api/world").then(setWorld).catch((error) => setStatus(error.message, true));
  void updateMetrics();
  return { setWorld, notify };
}
