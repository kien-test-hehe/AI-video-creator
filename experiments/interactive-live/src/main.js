import * as THREE from "three";
import { createWorldLayer } from "./world.js";
import { setupStudio } from "./studio.js";
import "./style.css";

const overlay = new URLSearchParams(location.search).get("view") === "overlay";
if (overlay) document.body.classList.add("overlay");
document.querySelector("#obs-url").textContent = location.origin + "/?view=overlay";

const mount = document.querySelector("#scene");
const scene = new THREE.Scene();
scene.background = new THREE.Color("#101c32");
scene.fog = new THREE.Fog("#101c32", 19, 48);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 90);
camera.position.set(10, 11, 24);
camera.lookAt(0, 3.3, 0);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
mount.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xa5d9ff, 0x473b35, 2.3));
const moonlight = new THREE.DirectionalLight(0xffe7b7, 3);
moonlight.position.set(-6, 14, 11);
moonlight.castShadow = true;
moonlight.shadow.mapSize.set(1024, 1024);
scene.add(moonlight);
const materials = {
  stone: new THREE.MeshStandardMaterial({ color: 0x9fa49d, roughness: 0.92 }),
  terracotta: new THREE.MeshStandardMaterial({ color: 0xa64e43, roughness: 0.8 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x254c59, roughness: 0.7 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7b4638, roughness: 0.85 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xe8bd6f, metalness: 0.4, roughness: 0.38 }),
  grass: new THREE.MeshStandardMaterial({ color: 0x294f48, roughness: 1 }),
  water: new THREE.MeshStandardMaterial({ color: 0x28667e, roughness: 0.3, metalness: 0.15 })
};
const meshes = [];
function object(geometry, material, position, parent = scene) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  meshes.push(mesh);
  return mesh;
}
const cube = (w, h, d, mat, pos, parent) => object(new THREE.BoxGeometry(w, h, d), mat, pos, parent);
const sphere = (r, mat, pos, parent) => object(new THREE.SphereGeometry(r, 14, 12), mat, pos, parent);
const cyl = (top, bottom, h, mat, pos, parent) => object(new THREE.CylinderGeometry(top, bottom, h, 12), mat, pos, parent);

cube(28, 0.6, 26, materials.grass, [0, -0.4, 0]);
cube(17, 0.7, 9, materials.stone, [0, 0.35, -4]);
cube(14, 5, 7, materials.wood, [0, 3.1, -5]);
cube(15.5, 0.5, 8, materials.gold, [0, 5.65, -5]);
const roof1 = object(new THREE.ConeGeometry(10.6, 3, 4), materials.roof, [0, 7.2, -5]);
roof1.rotation.y = Math.PI / 4;
cube(10, 0.4, 5.5, materials.gold, [0, 8.7, -5]);
const roof2 = object(new THREE.ConeGeometry(6.7, 2.4, 4), materials.roof, [0, 10, -5]);
roof2.rotation.y = Math.PI / 4;
cyl(0.15, 0.25, 1.5, materials.gold, [0, 11.8, -5]);
for (const x of [-5.5, -2.75, 2.75, 5.5]) cyl(0.26, 0.26, 4.5, materials.gold, [x, 3.4, -1.65]);
for (const x of [-3.6, 3.6]) cube(2.8, 3.3, 0.15, new THREE.MeshStandardMaterial({ color: 0x42342d }), [x, 3.0, -1.46]);
cube(3.4, 4, 0.12, new THREE.MeshStandardMaterial({ color: 0x161f28 }), [0, 3.0, -1.42]);
for (let i = 0; i < 5; i++) cube(12 - i, 0.24, 0.75, materials.stone, [0, 0.12 - i * 0.22, 0.7 + i * 0.7]);

const proceduralTemple = meshes.slice(1);
const pond = cyl(4, 4, 0.15, materials.water, [7, -0.07, 5]);
pond.scale.z = 0.62;
const lotuses = [];
function addLotus(angle) {
  const x = 7 + 2.7 * Math.cos(angle), z = 5 + 1.7 * Math.sin(angle);
  const group = new THREE.Group();
  group.position.set(x, 0.17, z);
  scene.add(group);
  const petalMat = new THREE.MeshStandardMaterial({ color: 0xffb5bd, emissive: 0x481622, emissiveIntensity: 0.3, side: THREE.DoubleSide });
  for (let i = 0; i < 7; i++) {
    const petal = sphere(0.27, petalMat, [Math.cos(i * Math.PI * 2 / 7) * 0.28, 0.05, Math.sin(i * Math.PI * 2 / 7) * 0.28], group);
    petal.scale.set(0.7, 0.26, 1.55);
    petal.rotation.y = i * Math.PI * 2 / 7;
  }
  sphere(0.15, materials.gold, [0, 0.1, 0], group);
  group.scale.setScalar(0.0001);
  lotuses.push(group);
}
for (let i = 0; i < 6; i++) addLotus(i * 2.399);
let activeLotus = 0;
function lantern(x, z) {
  const pole = cyl(0.13, 0.18, 4.6, materials.wood, [x, 2.3, z]);
  const lanternMesh = sphere(0.44, new THREE.MeshStandardMaterial({ color: 0xffa656, emissive: 0xff5f18, emissiveIntensity: 0.9 }), [x, 4.4, z]);
  const light = new THREE.PointLight(0xffa24c, 0, 7);
  light.position.set(x, 4.5, z);
  scene.add(light);
  return { pole, mesh: lanternMesh, light };
}
const lanterns = [lantern(-8, 3), lantern(8, 1), lantern(-7, -6), lantern(7, -8)];
let activeLanterns = 0;
function monk(x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  scene.add(group);
  cyl(0.27, 0.5, 1.6, new THREE.MeshStandardMaterial({ color: 0xc78b50 }), [0, 0.95, 0], group);
  sphere(0.36, new THREE.MeshStandardMaterial({ color: 0xe8b697 }), [0, 2.0, 0], group);
  return group;
}
const monks = [monk(-3.7, 4.0), monk(-1.8, 4.3), monk(1.8, 4.3), monk(3.7, 4.0)];
let bowUntil = 0;
const stars = [];
for (let i = 0; i < 65; i++) {
  const x = Math.sin(i * 13.3) * 24, y = 12 + ((i * 13) % 17), z = -15 - ((i * 7) % 20);
  stars.push(sphere(i % 5 === 0 ? 0.07 : 0.035, new THREE.MeshBasicMaterial({ color: 0xf8ead2 }), [x, y, z]));
}

const worldLayer = createWorldLayer({
  scene, proceduralTemple, monks, pond, lanterns,
  assetStatus: document.getElementById("asset-status")
});
const studio = overlay ? null : setupStudio({});
void worldLayer.refreshAssets();

const ids = ["likes", "gifts", "follows"];
function setState(state) {
  for (const id of ids) document.getElementById(id).textContent = Number(state[id]).toLocaleString("en-US");
}
const log = document.getElementById("log");
function action(a) {
  if (a.kind === "lantern") {
    const item = lanterns[activeLanterns % lanterns.length];
    item.light.intensity = 5;
    item.mesh.material.emissiveIntensity = 2.2;
    activeLanterns++;
  }
  if (a.kind === "lotus") { lotuses[activeLotus % lotuses.length].scale.setScalar(1); activeLotus++; }
  if (a.kind === "bow") bowUntil = performance.now() + 1600;
  document.getElementById("message").textContent = a.label;
  const entry = document.createElement("div");
  entry.textContent = a.kind.toUpperCase() + " · " + a.label;
  log.prepend(entry);
  while (log.children.length > 8) log.lastChild.remove();
}
const connectionLabel = document.getElementById("connection");
const source = new EventSource("/events");
source.addEventListener("state", (event) => setState(JSON.parse(event.data)));
source.addEventListener("action", (event) => action(JSON.parse(event.data)));
source.addEventListener("world", (event) => {
  const next = JSON.parse(event.data);
  worldLayer.setWorld(next);
  studio?.setWorld(next);
});
source.addEventListener("asset", () => { void worldLayer.refreshAssets(); });
const speechQueue = [];
let speaking = false;
async function playQueuedSpeech() {
  if (speaking) return;
  speaking = true;
  try {
    while (speechQueue.length) {
      const url = speechQueue.shift();
      try {
        const audio = new Audio(url);
        audio.preload = "auto";
        await audio.play();
        await new Promise((resolve) => {
          audio.addEventListener("ended", resolve, { once: true });
          audio.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 30000);
        });
      } catch (error) { console.warn("Browser Source audio playback unavailable:", error.message); }
    }
  } finally { speaking = false; }
}
source.addEventListener("narration", (event) => action({ kind: "narration", label: JSON.parse(event.data).text }));
source.addEventListener("speech", (event) => {
  const url = JSON.parse(event.data).url;
  if (!/^\/audio\/speech-[a-f0-9-]{36}\.wav$/.test(url)) return;
  if (speechQueue.length < 3) speechQueue.push(url);
  void playQueuedSpeech();
});
source.onopen = () => { connectionLabel.textContent = "CONNECTED"; };
source.onerror = () => { connectionLabel.textContent = "RECONNECTING"; };

async function dispatch(payload) {
  const headers = { "content-type": "application/json" };
  const token = document.getElementById("event-token").value;
  if (token) headers["x-event-token"] = token;
  const response = await fetch("/api/events", { method: "POST", headers, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error((await response.json()).error || "Request failed");
}
document.querySelectorAll("[data-type]").forEach((button) => {
  button.addEventListener("click", async () => {
    const type = button.dataset.type;
    try { await dispatch({ type, user: "Demo viewer", count: type === "like" ? 100 : 1, gift: "Rose" }); }
    catch (e) { alert(e.message); }
  });
});
document.getElementById("comment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("comment-input");
  try { await dispatch({ type: "comment", user: "Demo viewer", message: input.value }); input.value = ""; }
  catch (error) { alert(error.message); }
});
function resize() {
  const w = mount.clientWidth, h = mount.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(mount);
resize();
let previous = performance.now();
function animate(now) {
  const elapsed = Math.min((now - previous) / 1000, 0.1); previous = now;
  const t = now / 1000;
  worldLayer.tick(elapsed);
  for (const m of monks) m.rotation.x = now < bowUntil ? Math.sin((bowUntil - now) / 1600 * Math.PI) * 0.38 : 0;
  for (const l of lanterns) {
    l.light.intensity = Math.max(0, l.light.intensity - elapsed * 0.27);
    l.mesh.material.emissiveIntensity = 0.9 + l.light.intensity / 4;
  }
  for (let i = 0; i < lotuses.length; i++) if (lotuses[i].scale.x > 0.001) lotuses[i].position.y = 0.17 + Math.sin(t * 1.3 + i) * 0.06;
  camera.position.x = 10 + Math.sin(t * 0.10) * 0.6;
  camera.lookAt(0, 3.3, -1);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);
