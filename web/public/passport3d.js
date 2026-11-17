// Wardrobe Passport: 3D passport showcase on the landing page.
// A passport card you can drag to spin, with the benefits of joining orbiting it.
// The card is a three.js object; the badges are HTML placed over it each frame,
// so their text stays sharp and readable. Mounted by app.js via the "wp:stage" event.
import * as THREE from "./vendor/three.module.min.js";
import { buildWatch, studioEnv, PIECES } from "./models3d.js";

const BENEFITS = [
  { icon: "people", title: "Vouched-for members", line: "Invite-only, and every ID is checked in person." },
  { icon: "shield", title: "Checked by a specialist", line: "A watch or jewelry specialist authenticates every piece in person." },
  { icon: "lock", title: "Your money is held", line: "The seller is paid only after you confirm it arrived." },
  { icon: "scale", title: "Fair disputes", line: "Five random members vote. The contract pays out." },
  { icon: "history", title: "History adds value", line: "Every owner and price stays with the piece forever." },
  { icon: "gift", title: "Bond-backed stamps", line: "Authenticators stake money. If they're wrong, they pay." },
];
const ICON = {
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.7-3.4 3-5.2 6-5.2s5.3 1.8 6 5.2"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.6c2.6.2 4.4 1.9 5 5.4"/>',
  shield: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  scale: '<path d="M12 4v16M5 8h14M7 8l-3 6h6zM17 8l-3 6h6z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  gift: '<rect x="3" y="9" width="18" height="12" rx="2"/><path d="M12 9v12M3 13h18M12 9c-2-4-7-4-6-1s6 1 6 1 5 2 6-1-4-3-6 1"/>',
};

const HOUSE = document.documentElement.dataset.look === "house";
const ROSE = HOUSE ? "#7C5E2A" : "#F0435A", ROSE2 = HOUSE ? "#111315" : "#D70466", INK = HOUSE ? "#111315" : "#222222", MUTED = HOUSE ? "#4B525C" : "#6A6A6A";
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const FONT = (w, px) => `${w} ${px}px ${getComputedStyle(document.body).fontFamily}`;

// Card faces are drawn on 2D canvases and used as textures.
const S = 2; // draw faces at 2048 x 2800 so text stays sharp when the card turns
let MAX_ANISO = 8;
function texture(c) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  return t;
}
function frontTexture() {
  const c = document.createElement("canvas"); c.width = 1024 * S; c.height = 1400 * S;
  const g = c.getContext("2d"); g.scale(S, S);
  g.fillStyle = "#fff"; g.fillRect(0, 0, 1024, 1400);
  const band = g.createLinearGradient(0, 0, 1024, 0); band.addColorStop(0, HOUSE ? "#111315" : ROSE); band.addColorStop(1, ROSE2);
  g.fillStyle = band; g.fillRect(0, 0, 1024, 190);
  g.fillStyle = "#fff"; g.font = FONT(800, 70); g.fillText("Passport", 70, 122);
  g.font = FONT(700, 46); g.textAlign = "right"; g.fillText("No. 4", 954, 120); g.textAlign = "left";
  roundRect(g, 70, 250, 884, 600, 40); g.fillStyle = "#F3EDE4"; g.fill();
  g.fillStyle = INK; g.font = FONT(800, 84); g.fillText("Seamaster (1968)", 70, 990);
  g.fillStyle = MUTED; g.font = FONT(600, 52); g.fillText("Omega · calibre 565", 70, 1066);
  g.fillStyle = INK; g.font = FONT(800, 56); g.fillText("$9.00", 70, 1230);
  g.fillStyle = MUTED; g.font = FONT(600, 40); g.fillText("2 owners", 70, 1290);
  g.save(); g.translate(790, 1210); g.rotate(-0.2);
  g.strokeStyle = ROSE; g.lineWidth = 12; g.beginPath(); g.arc(0, 0, 140, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 120, 0, Math.PI * 2); g.stroke();
  g.fillStyle = ROSE; g.textAlign = "center"; g.font = FONT(800, 54); g.fillText("VERIFIED", 0, 10);
  g.font = FONT(800, 36); g.fillText("✓", 0, 62);
  g.restore();
  return texture(c);
}
function backTexture() {
  const c = document.createElement("canvas"); c.width = 1024 * S; c.height = 1400 * S;
  const g = c.getContext("2d"); g.scale(S, S);
  g.fillStyle = "#FFF7F8"; g.fillRect(0, 0, 1024, 1400);
  g.fillStyle = INK; g.font = FONT(800, 74); g.fillText("History", 70, 160);
  const rows = ["Passport issued", "Checked by a specialist", "Listed for $9", "Money held", "Protected 90 days"];
  rows.forEach((a, i) => {
    const y = 330 + i * 220;
    g.fillStyle = i < 2 ? ROSE : INK; g.beginPath(); g.arc(104, y - 18, 22, 0, Math.PI * 2); g.fill();
    if (i < rows.length - 1) { g.fillStyle = "#E7D9DC"; g.fillRect(100, y + 14, 8, 180); }
    g.fillStyle = INK; g.font = FONT(700, 58); g.fillText(a, 160, y);
  });
  return texture(c);
}

// A thin card with rounded corners: extruded rounded rectangle.
function cardGeometry(w, h, r, depth) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 3, curveSegments: 12 });
  geo.translate(0, 0, -depth / 2);
  return geo;
}
// Face planes slightly above the card surfaces, with the same rounded corners.
function faceGeometry(w, h, r) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geo = new THREE.ShapeGeometry(s, 12);
  // UVs from position so the texture covers the face exactly
  const pos = geo.attributes.position, uv = [];
  for (let i = 0; i < pos.count; i++) uv.push((pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

function mount(stage) {
  if (stage.dataset.mounted) return;
  stage.dataset.mounted = "1";
  const canvas = stage.querySelector("canvas");
  const labels = stage.querySelector(".orbit");
  let gl;
  try { gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch { stage.classList.add("no3d"); return; } // no WebGL: the list fallback stays visible
  gl.setPixelRatio(Math.min(devicePixelRatio, 2));
  MAX_ANISO = gl.capabilities.getMaxAnisotropy();
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(29, 1, 0.1, 50);
  camera.position.set(0, 0.15, 6.2);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xf3d9de, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffc2cf, 1.2); rim.position.set(-4, 1, -3); scene.add(rim);

  const W = 1.9, H = 2.6, R = 0.14, D = 0.06;
  const card = new THREE.Group();
  const body = new THREE.Mesh(cardGeometry(W, H, R, D), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.05 }));
  const faceMat = (map) => new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.75, roughness: 0.6 });
  const front = new THREE.Mesh(faceGeometry(W - 0.02, H - 0.02, R), faceMat(frontTexture()));
  front.position.z = D / 2 + 0.017;
  const back = new THREE.Mesh(faceGeometry(W - 0.02, H - 0.02, R), faceMat(backTexture()));
  back.position.z = -D / 2 - 0.017; back.rotation.y = Math.PI;
  card.add(body, front, back);
  // The piece itself: a 3D watch sitting on the passport's picture panel.
  scene.environment = studioEnv(gl);
  body.material.envMapIntensity = 0.25; front.material.envMapIntensity = back.material.envMapIntensity = 0;
  const watch = buildWatch({ ...PIECES["seamaster.jpg"], strapLen: 0.95, strapCurve: 0.3, layout: "flat" });
  watch.scale.setScalar(0.34); watch.position.set(0, 0.36, D / 2 + 0.13); watch.rotation.z = -0.12;
  card.add(watch);
  scene.add(card);

  // Soft shadow under the card
  const sh = document.createElement("canvas"); sh.width = sh.height = 128;
  const sg = sh.getContext("2d"); const grd = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, "rgba(80,20,40,.28)"); grd.addColorStop(1, "rgba(80,20,40,0)"); sg.fillStyle = grd; sg.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.7), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -H / 2 - 0.35; scene.add(shadow);

  // Benefit badges: HTML, positioned on an orbit around the card each frame
  labels.innerHTML = BENEFITS.map((b, i) => `
    <button class="orb" data-i="${i}" aria-label="${b.title}: ${b.line}">
      <span class="orb-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[b.icon]}</svg></span>
      <span class="orb-text"><b>${b.title}</b><small>${b.line}</small></span>
    </button>`).join("");
  const orbs = [...labels.querySelectorAll(".orb")];
  let active = -1;
  orbs.forEach((o, i) => {
    o.addEventListener("pointerenter", () => { active = i; });
    o.addEventListener("pointerleave", () => { if (active === i) active = -1; });
    o.addEventListener("focus", () => { active = i; });
    o.addEventListener("blur", () => { if (active === i) active = -1; });
  });

  // Drag to spin, with gentle inertia; idle auto-rotation unless reduced motion
  let rotY = -0.35, rotX = -0.06, velY = 0, dragging = false, lastX = 0, lastY = 0, idle = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); stage.classList.add("grabbing"); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
    velY = dx * 0.012; rotY += velY; rotX = Math.max(-0.5, Math.min(0.5, rotX + dy * 0.006)); idle = 0;
  });
  const end = () => { dragging = false; stage.classList.remove("grabbing"); };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  // Keyboard: arrows spin the card
  stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { rotY -= 0.35; e.preventDefault(); }
    if (e.key === "ArrowRight") { rotY += 0.35; e.preventDefault(); }
  });

  function resize() {
    const r = canvas.getBoundingClientRect();
    gl.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.position.z = r.width < 520 ? 5.9 : 6.2;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) loop(); }).observe(stage);

  const v = new THREE.Vector3();
  let t0 = performance.now(), running = false;
  function frame(now) {
    const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
    const still = reduceMotion();
    if (!dragging) {
      idle += dt;
      velY *= 0.94;
      rotY += velY + (still || idle < 1.2 ? 0 : dt * 0.35);
    }
    card.rotation.y += (rotY - card.rotation.y) * 0.18;
    card.rotation.x += (rotX - card.rotation.x) * 0.12;
    card.position.y = still ? 0 : Math.sin(now / 1400) * 0.06;
    shadow.scale.x = 1 - card.position.y * 0.6;

    // Badges float beside the card (three left, three right) so they never cover it.
    const r = canvas.getBoundingClientRect();
    const narrow = stage.getBoundingClientRect().width < 600 || matchMedia("(max-width: 640px)").matches;
    const SPOTS = [[-1, 0.95], [1, 0.75], [-1, -0.05], [1, -0.25], [-1, -1.0], [1, -1.15]];
    orbs.forEach((o, i) => {
      if (narrow) { o.style.transform = ""; return; }
      const [side, yy] = SPOTS[i];
      const bob = still ? 0 : Math.sin(now / 1100 + i * 1.7) * 0.05;
      v.set(side * 1.9, yy + bob, 0.2).project(camera);
      const w = o.offsetWidth, h = o.offsetHeight;
      // anchor the badge's inner edge next to the card, and keep it inside the stage
      let x = (v.x * 0.5 + 0.5) * r.width + (side < 0 ? -w : 0);
      let y = (-v.y * 0.5 + 0.5) * r.height - h / 2;
      x = Math.max(6, Math.min(r.width - w - 6, x));
      y = Math.max(6, Math.min(r.height - h - 6, y));
      o.style.transform = `translate(${x}px, ${y}px) scale(${i === active ? 1.04 : 1})`;
      o.style.zIndex = String(i === active ? 50 : 20);
      o.classList.toggle("on", i === active);
    });
    gl.render(scene, camera);
  }
  function loop() {
    if (running) return;
    running = true;
    const step = (now) => { if (!visible || !stage.isConnected) { running = false; return; } frame(now); requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  // Wait for the brand font so the card text is drawn in it
  (document.fonts?.ready ?? Promise.resolve()).then(() => {
    front.material.map = front.material.emissiveMap = frontTexture(); back.material.map = back.material.emissiveMap = backTexture();
    front.material.needsUpdate = back.material.needsUpdate = true;
  });
  loop();
}

window.addEventListener("wp:stage", () => document.querySelectorAll(".stage3d").forEach(mount));
document.querySelectorAll(".stage3d").forEach(mount);
