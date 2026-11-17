// Wardrobe Passport: the 3D piece on the landing page.
// One large watch (or whichever piece app.js features) that turns slowly and can be dragged,
// with three promises beside it. The promises are HTML placed over the canvas each frame,
// so their text stays sharp. Mounted by app.js via the "wp:stage" event; app.js can swap
// the piece with a "wp:hero-piece" event carrying a file name from PIECES.
import * as THREE from "./vendor/three.module.min.js";
import { buildPiece, studioEnv, PIECES } from "./models3d.js";

const BENEFITS = [
  { icon: "shield", title: "Checked in person", line: "A watch or jewelry specialist inspects every piece and stakes money on it." },
  { icon: "lock", title: "Money held until it arrives", line: "The seller is paid only after you confirm the piece arrived." },
  { icon: "refund", title: "Refunded if it's fake", line: "A second specialist decides. The bond and the members' pool pay you back." },
];
const ICON = {
  shield: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  refund: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M14.6 9.6c-.5-.8-1.4-1.2-2.5-1.2-1.3 0-2.3.7-2.3 1.8 0 2.3 4.9 1.1 4.9 3.6 0 1.1-1 1.8-2.4 1.8-1.2 0-2.1-.4-2.7-1.3M12 7v10"/>',
};
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEFAULT_PIECE = "seamaster.jpg";

function mount(stage) {
  if (stage.dataset.mounted) return;
  stage.dataset.mounted = "1";
  const canvas = stage.querySelector("canvas");
  const labels = stage.querySelector(".orbit");
  // The promises are useful with or without 3D, so write them first.
  labels.innerHTML = BENEFITS.map((b, i) => `
    <button class="orb" data-i="${i}" aria-label="${b.title}: ${b.line}">
      <span class="orb-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[b.icon]}</svg></span>
      <span class="orb-text"><b>${b.title}</b><small>${b.line}</small></span>
    </button>`).join("");
  let gl;
  try { gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch { stage.classList.add("no3d"); return; } // no WebGL: the promises stay as a list
  gl.setPixelRatio(Math.min(devicePixelRatio, 2));
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.environment = studioEnv(gl);
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 60);
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(-3, 7, 6); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffd9df, 0.9); rim.position.set(5, 3, -4); scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  // The piece stands on an invisible floor at y = 0, centred, inside a group we turn.
  const turn = new THREE.Group(); scene.add(turn);
  let size = new THREE.Vector3(2.2, 2.9, 2.2), current = "";
  function setPiece(file) {
    const spec = PIECES[file] || PIECES[DEFAULT_PIECE];
    if (file === current) return;
    current = file;
    turn.clear();
    const piece = buildPiece(spec);
    const hold = new THREE.Group(); hold.add(piece); turn.add(hold);
    turn.rotation.set(0, 0, 0); turn.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(hold, true), mid = box.getCenter(new THREE.Vector3());
    size = box.getSize(new THREE.Vector3());
    hold.position.set(-mid.x, -box.min.y, -mid.z);
    resize();
  }

  // Soft shadow on the floor
  const sh = document.createElement("canvas"); sh.width = sh.height = 128;
  const sg = sh.getContext("2d"); const grd = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, "rgba(60,20,30,.34)"); grd.addColorStop(0.6, "rgba(60,20,30,.10)"); grd.addColorStop(1, "rgba(60,20,30,0)"); sg.fillStyle = grd; sg.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.002; scene.add(shadow);

  const orbs = [...labels.querySelectorAll(".orb")];
  let active = -1;
  orbs.forEach((o, i) => {
    o.addEventListener("pointerenter", () => { active = i; });
    o.addEventListener("pointerleave", () => { if (active === i) active = -1; });
    o.addEventListener("focus", () => { active = i; });
    o.addEventListener("blur", () => { if (active === i) active = -1; });
  });

  // Drag to turn, with gentle inertia. Left alone, the piece sways so its face is always in view.
  let drag = 0, tilt = 0, vel = 0, dragging = false, lastX = 0, lastY = 0, idle = 9, sway = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); stage.classList.add("grabbing"); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
    vel = dx * 0.011; drag += vel; tilt = Math.max(-0.25, Math.min(0.3, tilt + dy * 0.004)); idle = 0;
  });
  const end = () => { dragging = false; stage.classList.remove("grabbing"); };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { drag -= 0.35; idle = 0; e.preventDefault(); }
    if (e.key === "ArrowRight") { drag += 0.35; idle = 0; e.preventDefault(); }
  });

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    gl.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    // Fit the piece's height (and its width as it turns) with room for the labels beside it.
    const across = Math.max(size.x, size.z) * 1.05, half = (camera.fov * Math.PI) / 360;
    const dist = Math.max((size.y * 1.28) / (2 * Math.tan(half)), (across * (r.width < 520 ? 1.5 : 2.3)) / (2 * Math.tan(half) * camera.aspect));
    const pitch = 0.17, look = size.y * 0.47;
    camera.position.set(0, look + Math.sin(pitch) * dist, Math.cos(pitch) * dist); camera.lookAt(0, look, 0);
    camera.updateProjectionMatrix();
    shadow.scale.set(across * 1.7, across * 1.1, 1);
  }
  new ResizeObserver(resize).observe(stage);
  setPiece(stage.dataset.piece || DEFAULT_PIECE);
  window.addEventListener("wp:hero-piece", (e) => { if (stage.isConnected) setPiece(e.detail); });

  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) loop(); }).observe(stage);

  const v = new THREE.Vector3();
  let t0 = performance.now(), running = false;
  function frame(now) {
    const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
    const still = reduceMotion();
    if (!dragging) {
      idle += dt; vel *= 0.93; drag += vel;
      if (idle > 2.5) drag += (0 - drag) * Math.min(1, dt * 1.2); // ease back to face the viewer
      if (!still) sway += dt;
    }
    const target = -0.42 + drag + (still ? 0 : Math.sin(sway * 0.5) * 0.38);
    turn.rotation.y += (target - turn.rotation.y) * 0.14;
    turn.rotation.x += (tilt - turn.rotation.x) * 0.12;

    // Labels sit beside the piece (left, right, left) and never cover it.
    const r = canvas.getBoundingClientRect();
    const narrow = stage.getBoundingClientRect().width < 600 || matchMedia("(max-width: 640px)").matches;
    const reach = Math.max(size.x, size.z) * 0.62;
    const SPOTS = [[-1, 0.86], [1, 0.52], [-1, 0.16]];
    orbs.forEach((o, i) => {
      if (narrow) { o.style.transform = ""; return; }
      const [side, at] = SPOTS[i];
      const bob = still ? 0 : Math.sin(now / 1200 + i * 1.9) * 0.03;
      v.set(side * reach, size.y * at + bob, 0).project(camera);
      const w = o.offsetWidth, h = o.offsetHeight;
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
  loop();
}

window.addEventListener("wp:stage", () => document.querySelectorAll(".stage3d").forEach(mount));
document.querySelectorAll(".stage3d").forEach(mount);
