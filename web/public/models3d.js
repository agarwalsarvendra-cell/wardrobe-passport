// Wardrobe Passport: original 3D models of watches, jewelry and handbags, built from simple shapes.
// Used twice: live on the landing page (the watch on the passport card), and by
// test/render-pieces.py to render the studio pictures in /seed. No brand marks are drawn.
import * as THREE from "./vendor/three.module.min.js";

const METAL = {
  steel: { color: 0xcfd4da, roughness: 0.26 },
  polished: { color: 0xe9ecef, roughness: 0.07 },
  gold: { color: 0xe2b860, roughness: 0.16 },
  rose: { color: 0xe0a488, roughness: 0.18 },
  black: { color: 0x1a1b1e, roughness: 0.38 },
  silver: { color: 0xf0f2f4, roughness: 0.1 },
};
const metal = (k, extra = {}) => new THREE.MeshStandardMaterial({ metalness: 1, envMapIntensity: 1.5, ...(METAL[k] || METAL.steel), ...extra });
const matte = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
const bright = (k) => (k === "gold" || k === "rose" || k === "black" ? k : "polished");

/** Studio surroundings for reflections: a dark room with long softboxes, which is what makes metal look like metal. */
export function studioEnv(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(20, 24, 16), new THREE.MeshBasicMaterial({ color: 0x8d8f94, side: THREE.BackSide })));
  const panel = (w, h, x, y, z, c) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m);
  };
  panel(16, 7, 0, 13, 5, 0xffffff);       // overhead softbox
  panel(3.5, 16, -11, 4, 7, 0xffffff);    // tall strip, left
  panel(3, 14, 11, 3, 5, 0xf2f6ff);       // tall strip, right
  panel(9, 2.5, 0, 2, 14, 0xfff4e6);      // front fill, warm
  panel(12, 4, 0, -11, 4, 0x1c1c1e);      // dark floor
  panel(5, 5, -7, 9, -10, 0xffe9cf);      // warm kicker behind
  panel(2, 10, 6, 6, -11, 0xdfe8f5);      // cool rim behind
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.02).texture;
  pm.dispose();
  return tex;
}

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// Small seeded random, so every render of a piece is the same.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ watches
function dialTexture(o) {
  return canvasTex(1024, 1024, (g) => {
    g.translate(512, 512);
    const grd = g.createRadialGradient(-140, -180, 30, 0, 0, 560);
    grd.addColorStop(0, o.dialLight || o.dial); grd.addColorStop(1, o.dial);
    g.fillStyle = grd; g.beginPath(); g.arc(0, 0, 512, 0, 7); g.fill();
    if (o.finish !== "matte") { // sunburst brushing
      for (let i = 0; i < 360; i++) { g.rotate(Math.PI / 180); g.globalAlpha = 0.035 + 0.03 * Math.abs(Math.sin(i * 0.9)); g.fillStyle = i % 2 ? "#fff" : "#000"; g.beginPath(); g.moveTo(0, 0); g.lineTo(512, -5); g.lineTo(512, 5); g.fill(); }
      g.globalAlpha = 1;
    }
    const ink = o.marks || "#f4f4f4";
    // chapter ring and minute track
    g.strokeStyle = ink; g.globalAlpha = 0.35; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 500, 0, 7); g.stroke(); g.globalAlpha = 1;
    for (let i = 0; i < 300; i++) {
      const five = i % 25 === 0, one = i % 5 === 0;
      if (!one && !o.chrono) continue;
      g.save(); g.rotate((i * Math.PI) / 150); g.fillStyle = ink; g.globalAlpha = five ? 0.95 : one ? 0.7 : 0.4;
      g.fillRect(five ? -3 : -1.5, -498, five ? 6 : 3, five ? 34 : one ? 22 : 12); g.restore();
    }
    if (o.chrono) {
      for (const [x, y, n] of [[-196, 0, 6], [196, 0, 6], [0, 196, 12]]) {
        const sg = g.createRadialGradient(x, y, 10, x, y, 110); sg.addColorStop(0, "rgba(0,0,0,.42)"); sg.addColorStop(1, "rgba(0,0,0,.24)");
        g.fillStyle = sg; g.beginPath(); g.arc(x, y, 108, 0, 7); g.fill();
        g.strokeStyle = ink; g.globalAlpha = 0.75; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 108, 0, 7); g.stroke();
        for (let i = 0; i < n * 5; i++) { g.save(); g.translate(x, y); g.rotate((i * Math.PI * 2) / (n * 5)); g.fillStyle = ink; g.fillRect(-1.5, -104, 3, i % 5 ? 9 : 18); g.restore(); }
        g.globalAlpha = 1;
      }
    }
    if (o.small) { // small seconds at 6
      g.fillStyle = "rgba(0,0,0,.14)"; g.beginPath(); g.arc(0, 220, 112, 0, 7); g.fill();
      g.strokeStyle = ink; g.globalAlpha = 0.6; g.lineWidth = 2.5; g.beginPath(); g.arc(0, 220, 112, 0, 7); g.stroke();
      for (let i = 0; i < 60; i++) { g.save(); g.translate(0, 220); g.rotate((i * Math.PI) / 30); g.fillStyle = ink; g.fillRect(-1.2, -108, 2.4, i % 5 ? 8 : 18); g.restore(); }
      g.globalAlpha = 1;
    }
    if (o.date) {
      g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(292, -46, 108, 92);
      g.fillStyle = "#f7f6f1"; g.fillRect(298, -40, 96, 80);
      g.fillStyle = "#1c1c1c"; g.font = "700 60px Georgia, serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("16", 346, 4);
    }
    if (o.markers === "arabic") {
      g.fillStyle = ink; g.font = "700 92px Georgia, serif"; g.textAlign = "center"; g.textBaseline = "middle";
      for (let h = 1; h <= 12; h++) { const a = (h * Math.PI) / 6; if ((o.date && h === 3) || (o.small && h === 6)) continue; g.fillText(String(h), Math.sin(a) * 356, -Math.cos(a) * 356 + 6); }
    }
    // two thin lines where a name would sit, so the dial doesn't look empty (no brand is drawn)
    g.fillStyle = ink; g.globalAlpha = 0.55; g.fillRect(-58, -238, 116, 7); g.globalAlpha = 0.3; g.fillRect(-36, -216, 72, 4); g.globalAlpha = 1;
  });
}
function bezelTexture(o) {
  return canvasTex(1024, 1024, (g) => {
    g.translate(512, 512);
    const grd = g.createLinearGradient(-512, -512, 512, 512); grd.addColorStop(0, o.bezelLight || "#3a3a3d"); grd.addColorStop(0.5, o.bezelColor || "#111"); grd.addColorStop(1, o.bezelLight || "#2a2a2d");
    g.fillStyle = grd; g.beginPath(); g.arc(0, 0, 512, 0, 7); g.fill();
    g.fillStyle = "#f2f2f2"; g.textAlign = "center"; g.textBaseline = "middle"; g.font = "700 62px Georgia, serif";
    for (let i = 0; i < 60; i++) {
      g.save(); g.rotate((i * Math.PI) / 30);
      if (o.bezel === "dive") {
        if (i === 0) { g.beginPath(); g.moveTo(0, -418); g.lineTo(-38, -494); g.lineTo(38, -494); g.fill(); g.fillStyle = "#ffe9a8"; g.beginPath(); g.arc(0, -462, 12, 0, 7); g.fill(); }
        else if (i % 10 === 0) g.fillText(String(i), 0, -452);
        else if (i % 5 === 0) g.fillRect(-7, -488, 14, 64);
        else if (i < 15) g.fillRect(-3, -488, 6, 30);
      } else {
        g.globalAlpha = 0.92;
        if (i % 5 === 0) g.fillRect(-4, -494, 8, 30); else g.fillRect(-2, -494, 4, 16);
        if (i % 10 === 5) { g.font = "700 38px Georgia, serif"; g.fillText(String(500 - i * 7), 0, -440); }
      }
      g.restore();
    }
  });
}
function lcdTexture() {
  return canvasTex(512, 320, (g) => {
    g.fillStyle = "#a9b19c"; g.fillRect(0, 0, 512, 320);
    g.fillStyle = "#1d2219"; g.font = "700 150px monospace"; g.textBaseline = "middle"; g.fillText("10:08", 26, 190);
    g.font = "700 54px monospace"; g.fillText("MO 16", 30, 56); g.fillText("36", 420, 214);
    g.fillRect(24, 96, 464, 6);
  });
}
function leatherBump(seed = 7, scale = 1) {
  const r = rng(seed);
  const t = canvasTex(256, 256, (g) => {
    g.fillStyle = "#808080"; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) { const v = 90 + r() * 80; g.fillStyle = `rgb(${v},${v},${v})`; g.beginPath(); g.arc(r() * 256, r() * 256, 1 + r() * 2.6 * scale, 0, 7); g.fill(); }
  }, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const leather = (color, o = {}) => {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness: o.rough ?? 0.55, metalness: 0, sheen: 0.5, sheenRoughness: 0.5, sheenColor: 0xffffff, clearcoat: o.coat ?? 0.15, clearcoatRoughness: 0.4, envMapIntensity: 0.9, bumpMap: leatherBump(o.seed, o.grain ?? 1), bumpScale: o.bump ?? 0.6 });
  m.bumpMap.repeat.set(o.rep ?? 3, o.rep ?? 3);
  return m;
};
function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}
const rbox = (w, h, d, r = 0.02) => { const g = new THREE.ExtrudeGeometry(roundedRect(w, h, Math.min(r * 3, w / 2.2, h / 2.2)), { depth: d - r * 2, bevelEnabled: true, bevelSize: r, bevelThickness: r, bevelSegments: 3, curveSegments: 6 }); g.translate(0, 0, -(d - r * 2) / 2); return g; };

/** Short straight strap halves, for the watch lying on the passport card. */
function strapFlat(o, dir, len) {
  const g = new THREE.Group();
  const bracelet = o.strap === "bracelet";
  const mat = bracelet ? metal(o.case === "gold" ? "gold" : o.case === "black" ? "black" : "steel") : o.strap === "resin" ? matte(o.strapColor || 0x18191b, 0.6) : leather(o.strapColor || 0x5b3a26);
  const n = bracelet ? 7 : 22, step = len / n;
  let y = 0.98, z = -0.02, ang = 0;
  for (let i = 0; i < n; i++) {
    const w = (o.strapWidth || 1.08) * (1 - (bracelet ? 0.012 : 0.02) * i);
    ang += (bracelet ? 0.13 : 0.042) * (o.strapCurve ?? 1);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, step * (bracelet ? 0.9 : 1.12), bracelet ? 0.13 : 0.1), mat);
    y += Math.cos(ang) * step; z -= Math.sin(ang) * step;
    seg.position.set(0, dir * (y - (Math.cos(ang) * step) / 2), z + (Math.sin(ang) * step) / 2); seg.rotation.x = -dir * ang;
    g.add(seg);
  }
  return g;
}
/** A closed strap: runs from the top lugs, round the back and up to the bottom lugs, so the watch stands like on a display. */
function strapLoop(o) {
  const g = new THREE.Group();
  const kind = o.strap || "leather";
  const a = 1.42, c = 1.08, f0 = Math.asin(0.97 / a), zc = -0.06 - c * Math.cos(f0);
  const at = (f) => ({ y: a * Math.sin(f), z: zc + c * Math.cos(f), rot: Math.atan2(-c * Math.sin(f), a * Math.cos(f)) });
  const W = o.strapWidth || 1.06;
  if (kind === "bracelet") {
    const n = 30, body = metal(o.case === "gold" ? "gold" : o.case === "black" ? "black" : "steel"), shine = metal(bright(o.case));
    for (let i = 0; i < n; i++) {
      const f = f0 + ((i + 0.5) / n) * (Math.PI * 2 - 2 * f0), p = at(f);
      const taper = 1 - 0.16 * Math.sin(((i + 0.5) / n) * Math.PI);
      const len = ((Math.PI * 2 - 2 * f0) / n) * Math.hypot(a * Math.cos(f), c * Math.sin(f)) * 0.9;
      const link = new THREE.Group();
      for (const x of [-0.345, 0.345]) { const m = new THREE.Mesh(rbox(W * taper * 0.3, len, 0.13, 0.022), body); m.position.x = x * W * taper; link.add(m); }
      const mid = new THREE.Mesh(rbox(W * taper * 0.36, len * 1.02, 0.15, 0.024), o.midLinks === false ? body : shine); link.add(mid);
      link.position.set(0, p.y, p.z); link.rotation.x = p.rot; g.add(link);
    }
    return g;
  }
  const mat = kind === "resin" ? matte(o.strapColor || 0x18191b, 0.55) : leather(o.strapColor || 0x5b3a26, { rep: 1.2, bump: 0.5 });
  const stitch = matte(o.stitch || 0xd9cdb8, 0.9);
  const n = 110;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, f = f0 + t * (Math.PI * 2 - 2 * f0), p = at(f);
    const taper = 1 - 0.2 * Math.sin(t * Math.PI);
    const len = ((Math.PI * 2 - 2 * f0) / n) * Math.hypot(a * Math.cos(f), c * Math.sin(f)) * 1.25;
    const pad = kind === "resin" ? 0.15 : 0.085 + 0.06 * Math.max(0, 1 - Math.abs(t - 0.5) * 4.2 < 0 ? Math.min(1, Math.min(t, 1 - t) * 9) : 0.2);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(W * taper, len, pad), mat);
    seg.position.set(0, p.y, p.z); seg.rotation.x = p.rot; g.add(seg);
    if (kind === "leather" && i % 2 === 0) {
      for (const x of [-1, 1]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.018, len * 0.55, 0.012), stitch); s.position.set(x * (W * taper * 0.5 - 0.07), 0, pad / 2 + 0.003); seg.add(s); }
    }
    if (kind === "resin" && i % 3 === 0 && t > 0.2 && t < 0.8) { const rib = new THREE.Mesh(new THREE.BoxGeometry(W * taper * 0.7, len * 0.5, 0.03), mat); rib.position.z = pad / 2; seg.add(rib); }
  }
  // buckle at the back
  const pb = at(Math.PI), buckle = new THREE.Group(), bm = metal(bright(o.case));
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 10, 4), bm); frame.rotation.z = Math.PI / 4; frame.scale.set(1.5, 0.8, 1); buckle.add(frame);
  const tongue = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), bm); buckle.add(tongue);
  buckle.position.set(0, pb.y, pb.z - 0.1); buckle.rotation.x = pb.rot + Math.PI; g.add(buckle);
  return g;
}

/**
 * A wristwatch. o: { case, dial, dialLight, marks, finish, bezel: "plain"|"dive"|"tachy", bezelColor,
 * strap: "bracelet"|"leather"|"resin", strapColor, shape: "round"|"square", chrono, date, small, markers,
 * hands: "baton"|"dauphine"|"sword", layout: "loop"|"flat" }
 */
export function buildWatch(o = {}) {
  const w = new THREE.Group();
  const caseMat = metal(o.case || "steel"), shine = metal(bright(o.case));
  const strap = () => (o.layout === "flat" ? [strapFlat(o, 1, o.strapLen || 1.45), strapFlat(o, -1, o.strapLen || 1.45)] : [strapLoop(o)]);
  if (o.shape === "square") {
    const resin = matte(0x17181a, 0.5);
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(roundedRect(2.05, 2.15, 0.42), { depth: 0.36, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 5 }), resin);
    body.position.z = -0.2; w.add(body);
    const guard = new THREE.Mesh(new THREE.ExtrudeGeometry(roundedRect(1.86, 1.76, 0.3), { depth: 0.06, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 3 }), matte(0x222326, 0.45));
    guard.position.z = 0.24; w.add(guard);
    const inner = new THREE.Mesh(new THREE.ExtrudeGeometry(roundedRect(1.56, 1.42, 0.16), { depth: 0.03, bevelEnabled: false }), matte(0x0b0b0c, 0.3));
    inner.position.z = 0.31; w.add(inner);
    const lcd = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.75), new THREE.MeshStandardMaterial({ map: lcdTexture(), roughness: 0.2 }));
    lcd.position.z = 0.345; w.add(lcd);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.36), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, roughness: 0, clearcoat: 1, envMapIntensity: 1.5 }));
    glass.position.z = 0.36; w.add(glass);
    for (const [x, y] of [[-1.1, 0.5], [-1.1, -0.5], [1.1, 0.5], [1.1, -0.5]]) { const b = new THREE.Mesh(rbox(0.16, 0.36, 0.2, 0.03), metal("steel")); b.position.set(x, y, 0); w.add(b); }
    const so = { ...o, strap: "resin", strapWidth: 1.5 };
    w.add(...(o.layout === "flat" ? [strapFlat(so, 1, 1.5), strapFlat(so, -1, 1.5)] : [strapLoop(so)]));
    return w;
  }
  const diver = o.bezel && o.bezel !== "plain";
  // case: turned profile (back, flank, chamfer, bezel seat)
  const prof = [[0.0, -0.21], [0.72, -0.21], [0.8, -0.17], [0.97, -0.13], [1.0, -0.04], [1.0, 0.07], [0.975, 0.13], [0.93, 0.16], [0.0, 0.16]].map(([r, z]) => new THREE.Vector2(r, z));
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 96), caseMat); body.rotation.x = Math.PI / 2; w.add(body);
  // lugs: four horns sweeping down to the strap
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const l = new THREE.Mesh(rbox(0.17, 0.4, 0.17, 0.04), caseMat);
    l.position.set(sx * 0.63, sy * 0.83, -0.08); l.rotation.x = sy * 0.42; l.rotation.z = -sx * sy * 0.08; w.add(l);
  }
  const dialR = diver ? 0.75 : 0.85;
  if (diver) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(dialR, 0.985, 128), new THREE.MeshStandardMaterial({ map: bezelTexture(o), roughness: 0.22, metalness: 0.55, envMapIntensity: 1.2 }));
    const pos = ring.geometry.attributes.position, uv = [];
    for (let i = 0; i < pos.count; i++) uv.push(pos.getX(i) / 2 + 0.5, pos.getY(i) / 2 + 0.5);
    ring.geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    ring.position.z = 0.205; w.add(ring);
    const seatProf = [[dialR, 0.158], [1.0, 0.158], [1.0, 0.2], [dialR, 0.2]].map(([r, z]) => new THREE.Vector2(r, z));
    const seat = new THREE.Mesh(new THREE.LatheGeometry(seatProf, 96), shine); seat.rotation.x = Math.PI / 2; w.add(seat);
    for (let i = 0; i < 60; i++) { // coin edge
      const a = (i * Math.PI) / 30, k = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.05), shine);
      k.position.set(Math.cos(a) * 1.005, Math.sin(a) * 1.005, 0.18); k.rotation.z = a; w.add(k);
    }
    const lip = new THREE.Mesh(new THREE.TorusGeometry(dialR, 0.018, 10, 96), shine); lip.position.z = 0.207; w.add(lip);
  } else {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.915, 0.07, 20, 128), shine); rim.position.z = 0.165; w.add(rim);
    const step = new THREE.Mesh(new THREE.TorusGeometry(dialR, 0.02, 10, 96), shine); step.position.z = 0.185; w.add(step);
  }
  const dz = diver ? 0.172 : 0.166;
  const dial = new THREE.Mesh(new THREE.CircleGeometry(dialR, 128), new THREE.MeshStandardMaterial({ map: dialTexture(o), roughness: o.finish === "matte" ? 0.7 : 0.34, metalness: o.finish === "matte" ? 0.05 : 0.45, envMapIntensity: 0.9 }));
  dial.position.z = dz; w.add(dial);
  // applied hour markers, with a luminous inlay on sports watches
  const markMat = metal(o.case === "gold" || o.case === "rose" ? "gold" : "silver", { roughness: 0.08 });
  const lume = matte(o.lume || 0xf3f1e4, 0.5);
  if (o.markers !== "arabic") {
    for (let h = 0; h < 12; h++) {
      if ((o.date && h === 3) || (o.small && h === 6) || (o.chrono && h % 3 === 0 && h !== 0)) continue;
      const ang = (h * Math.PI) / 6, r = dialR * 0.81, big = h === 0;
      const holder = new THREE.Group();
      if (o.markers === "dots" && h % 3 !== 0) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 24), markMat); ring.rotation.x = Math.PI / 2; holder.add(ring);
        const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.024, 24), lume); dot.rotation.x = Math.PI / 2; holder.add(dot);
      } else {
        const wd = big ? 0.085 : 0.05, ht = o.markers === "dots" ? 0.19 : 0.2;
        holder.add(new THREE.Mesh(rbox(wd, ht, 0.026, 0.008), markMat));
        if (o.markers === "dots" || o.lumeBars) { const in1 = new THREE.Mesh(new THREE.BoxGeometry(wd * 0.55, ht * 0.8, 0.03), lume); holder.add(in1); }
        if (big && !diver) { const twin = new THREE.Mesh(rbox(wd, ht, 0.026, 0.008), markMat); twin.position.x = 0.11; holder.children[0].position.x = -0.055; twin.position.x = 0.055; holder.add(twin); }
      }
      holder.position.set(Math.sin(ang) * r, Math.cos(ang) * r, dz + 0.014); holder.rotation.z = -ang; w.add(holder);
    }
  }
  // hands at 10:08
  const handK = o.handColor || (o.case === "gold" || o.case === "rose" ? "gold" : "silver");
  const handMat = metal(handK, { roughness: 0.08 });
  const hand = (len, wid, ang, z, style) => {
    const s = new THREE.Shape();
    if (style === "dauphine") { s.moveTo(0, -0.1); s.lineTo(wid * 0.9, 0.06); s.lineTo(0, len); s.lineTo(-wid * 0.9, 0.06); }
    else if (style === "sword") { s.moveTo(-wid * 0.35, -0.1); s.lineTo(wid * 0.35, -0.1); s.lineTo(wid * 0.75, len * 0.72); s.lineTo(0, len); s.lineTo(-wid * 0.75, len * 0.72); }
    else { s.moveTo(-wid / 2, -0.1); s.lineTo(wid / 2, -0.1); s.lineTo(wid / 2, len - 0.02); s.lineTo(0, len); s.lineTo(-wid / 2, len - 0.02); }
    const h = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.008, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 1 }), handMat);
    h.rotation.z = -ang; h.position.z = z; w.add(h);
    if (style !== "dauphine" && (o.markers === "dots" || o.lumeBars)) { const l = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.5, len * 0.55, 0.004), lume); l.position.set(0, len * 0.55, 0.016); h.add(l); }
  };
  const hs = o.hands || "baton";
  hand(dialR * 0.52, hs === "dauphine" ? 0.085 : 0.075, (10.13 / 12) * Math.PI * 2, dz + 0.03, hs);
  hand(dialR * 0.82, hs === "dauphine" ? 0.07 : 0.055, (8 / 60) * Math.PI * 2, dz + 0.046, hs);
  const sec = new THREE.MeshStandardMaterial({ color: o.seconds ?? 0xc8372f, roughness: 0.35, metalness: 0.2 });
  if (!o.small) {
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.012, dialR * 1.12, 0.008), sec); sh.geometry.translate(0, dialR * 0.3, 0); sh.rotation.z = -(36 / 60) * Math.PI * 2; sh.position.z = dz + 0.062; w.add(sh);
    const cw = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 16), sec); cw.rotation.x = Math.PI / 2; cw.position.z = dz + 0.062; w.add(cw);
  } else {
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.01, dialR * 0.2, 0.006), handMat); sh.geometry.translate(0, dialR * 0.07, 0); sh.position.set(0, -dialR * 0.43, dz + 0.02); sh.rotation.z = 2.2; w.add(sh);
  }
  if (o.chrono) for (const [x, y, a2] of [[-0.287, 0, 0.7], [0.287, 0, 2.4], [0, -0.287, 4.4]]) {
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.012, dialR * 0.2, 0.006), handMat); sh.geometry.translate(0, dialR * 0.07, 0); sh.position.set(x * (dialR / 0.75), y * (dialR / 0.75), dz + 0.02); sh.rotation.z = a2; w.add(sh);
  }
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.085, 24), handMat); pin.rotation.x = Math.PI / 2; pin.position.z = dz + 0.04; w.add(pin);
  // domed crystal
  const R = o.dome ? 1.25 : 2.2, cr = dialR + (diver ? 0.0 : 0.045), cap = Math.asin(Math.min(0.99, cr / R));
  const glass = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 20, 0, Math.PI * 2, 0, cap),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, roughness: 0, metalness: 0, clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 2.0, depthWrite: false }));
  glass.rotation.x = Math.PI / 2; glass.position.z = dz + 0.075 - R * Math.cos(cap); w.add(glass);
  // crown (fluted) and pushers
  const crown = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 16), caseMat); stem.position.y = -0.06; crown.add(stem);
  const cap2 = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.15, 18), new THREE.MeshStandardMaterial({ ...METAL[bright(o.case)], metalness: 1, flatShading: true, envMapIntensity: 1.5 })); cap2.position.y = 0.045; crown.add(cap2);
  crown.rotation.z = -Math.PI / 2; crown.position.set(1.05, 0, -0.02); w.add(crown);
  if (diver && !o.chrono) for (const y of [0.2, -0.2]) { const gd = new THREE.Mesh(rbox(0.12, 0.16, 0.16, 0.03), caseMat); gd.position.set(1.0, y, -0.02); w.add(gd); }
  if (o.chrono) for (const y of [0.5, -0.5]) {
    const p = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 16), caseMat); p.add(tube);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 20), shine); head.position.y = 0.08; p.add(head);
    p.rotation.z = -Math.PI / 2 + (y > 0 ? 0.5 : -0.5); p.position.set(0.9, y, -0.02); w.add(p);
  }
  w.add(...strap());
  return w;
}

// ------------------------------------------------------------------ jewelry
const gemMat = (color = 0xffffff) => new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness: 0.0, flatShading: true, envMapIntensity: 3.2, emissive: 0xcfe0ff, emissiveIntensity: 0.22, iridescence: 1, iridescenceIOR: 2.1, iridescenceThicknessRange: [120, 620] });
/** A brilliant-cut stone: table, crown, girdle and pavilion, with flat facets. Table faces +y. */
function gem(r = 0.3, color, facets = 16) {
  const pts = [[0, -0.66], [0.52, -0.3], [1, 0], [1, 0.035], [0.8, 0.16], [0.56, 0.26], [0, 0.26]].map(([x, y]) => new THREE.Vector2(x * r, y * r));
  const geo = new THREE.LatheGeometry(pts, facets).toNonIndexed(), n = geo.attributes.position.count, col = new Float32Array(n * 3), rnd = rng(facets * 131 + Math.round(r * 1000));
  const tones = [[1, 1, 1], [1, 1, 1], [0.9, 0.95, 1], [0.74, 0.84, 0.98], [0.56, 0.68, 0.88], [1, 0.96, 0.9]];
  for (let i = 0; i < n; i += 3) { const t = tones[Math.floor(rnd() * tones.length)]; for (let j = 0; j < 3; j++) col.set(t, (i + j) * 3); }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); geo.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ color: color ?? 0xffffff, vertexColors: true, flatShading: true, metalness: 0.55, roughness: 0.04, envMapIntensity: 2.2, emissive: 0xffffff, emissiveIntensity: 0.3 });
  return new THREE.Mesh(geo, m);
}
function claws(r, k = "gold", n = 4) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const a = (i * Math.PI * 2) / n + Math.PI / n;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.07, r * 0.09, r * 1.05, 10), metal(k));
    p.position.set(Math.cos(a) * r * 0.96, -r * 0.2, Math.sin(a) * r * 0.96); p.rotation.set(Math.sin(a) * 0.22, 0, -Math.cos(a) * 0.22); g.add(p);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(r * 0.09, 10, 8), metal(k)); tip.position.set(Math.cos(a) * r * 0.9, r * 0.3, Math.sin(a) * r * 0.9); g.add(tip);
  }
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.3, r * 0.5, 24, 1, true), metal(k, { side: THREE.DoubleSide })); basket.position.y = -r * 0.62; g.add(basket);
  return g;
}
/** A cable chain along a closed or open path of points: oval links, each turned a quarter from the last. */
function chainAlong(points, k, size = 0.075) {
  const g = new THREE.Group(), m = metal(k, { roughness: 0.12 });
  const geo = new THREE.TorusGeometry(size, size * 0.3, 10, 20); geo.scale(1.35, 1, 1);
  const up = new THREE.Vector3(0, 0, 1), q = new THREE.Quaternion(), x = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], d = b.clone().sub(a).normalize();
    const l = new THREE.Mesh(geo, m); l.position.copy(a).add(b).multiplyScalar(0.5);
    q.setFromUnitVectors(x, d); l.quaternion.copy(q); l.rotateX(i % 2 ? Math.PI / 2 : 0.25);
    g.add(l);
  }
  void up;
  return g;
}
/** A necklace laid out as an open teardrop, clasp at the back, lowest point at the front. */
function necklacePoints(n = 78, w = 1.55, d = 2.3) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 - Math.PI / 2; // start at the front
    const narrow = 0.62 + 0.38 * (0.5 - 0.5 * Math.sin(t));
    pts.push(new THREE.Vector3(Math.cos(t) * w * narrow, 0.04 * Math.sin(t * 6), -Math.sin(t) * d * 0.5 - d * 0.5));
  }
  return pts;
}

/** Jewelry. o: { kind: "signet"|"solitaire"|"bangle"|"chain"|"pendant"|"pearls"|"studs"|"hoops"|"tennis", metal } */
export function buildJewel(o = {}) {
  const g = new THREE.Group(), k = o.metal || "gold";
  switch (o.kind) {
    case "signet": {
      // band that swells into a flat oval face
      const band = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 28, 128), metal(k)); band.scale.z = 1.7; g.add(band);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.47, 0.22, 64), metal(k)); head.scale.z = 1.22; head.position.y = 1.1; g.add(head);
      const face = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.012, 64), metal(k, { roughness: 0.3 })); face.scale.z = 1.22; face.position.y = 1.213; g.add(face);
      const groove = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.012, 8, 64), metal(k, { roughness: 0.05 })); groove.rotation.x = Math.PI / 2; groove.scale.y = 1.22; groove.position.y = 1.222; g.add(groove);
      g.rotation.set(0, 0.55, 0);
      break;
    }
    case "bangle": {
      const b = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.085, 28, 160), metal(k, { roughness: 0.07 })); b.scale.z = 2.2; g.add(b);
      for (const z of [-0.2, 0.2]) { const r = new THREE.Mesh(new THREE.TorusGeometry(1.385, 0.014, 8, 160), metal(k, { roughness: 0.2 })); r.position.z = z * 0.55; g.add(r); }
      g.rotation.set(0, 0.7, 0);
      break;
    }
    case "chain": case "pendant": {
      const pts = necklacePoints(), size = 0.058;
      g.add(chainAlong(pts, k, size));
      // clasp at the back
      const back = pts[Math.round(pts.length / 2)];
      const clasp = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.03, 10, 24), metal(k)); clasp.position.copy(back).add(new THREE.Vector3(0, 0.02, 0)); clasp.rotation.x = Math.PI / 2; g.add(clasp);
      if (o.kind === "pendant") {
        const front = pts[0];
        const s = gem(0.3); s.position.copy(front).add(new THREE.Vector3(0, 0.16, 0.42)); g.add(s);
        const set = claws(0.3, k, 4); set.position.copy(s.position); g.add(set);
        const bail = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.028, 10, 24), metal(k)); bail.position.copy(front).add(new THREE.Vector3(0, 0.05, 0.08)); bail.rotation.y = Math.PI / 2; g.add(bail);
      }
      g.rotation.set(0, 0.25, 0);
      break;
    }
    case "pearls": case "studs": {
      const pearl = new THREE.MeshPhysicalMaterial({ color: 0xf7f0e6, roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, sheen: 1, sheenColor: 0xffdbe8, sheenRoughness: 0.3, iridescence: 0.45, iridescenceIOR: 1.5, envMapIntensity: 1.25 });
      [[-0.6, 0, 0, 0.3], [0.62, 0, 0.25, -0.35]].forEach(([x, y, z, ry]) => {
        const e = new THREE.Group();
        if (o.kind === "pearls") {
          e.add(new THREE.Mesh(new THREE.SphereGeometry(0.46, 64, 48), pearl));
          const cup = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), metal(k)); cup.rotation.x = -Math.PI / 2; cup.position.z = -0.37; e.add(cup);
        } else {
          const s = gem(0.36, 0xffffff, 16); s.rotation.x = Math.PI / 2; e.add(s);
          const c = claws(0.36, k, 4); c.rotation.x = Math.PI / 2; e.add(c);
        }
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.4, 8), metal(k)); post.rotation.x = Math.PI / 2; post.position.z = -0.5; e.add(post);
        const backing = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 20), metal(k)); backing.rotation.x = Math.PI / 2; backing.position.z = -0.66; e.add(backing);
        e.position.set(x, y, z); e.rotation.y = ry; g.add(e);
      });
      g.rotation.set(0.12, 0, 0);
      break;
    }
    case "hoops": {
      for (const [x, ry, z] of [[-0.62, 0.55, 0], [0.7, -0.4, 0.25]]) {
        const h = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.07, 28, 128, Math.PI * 1.9), metal(k, { roughness: 0.07 }));
        h.position.set(x, 0, z); h.rotation.set(0.1, ry, Math.PI / 2 + 0.16); g.add(h);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 8), metal(k)); post.position.set(x, 0.72, z); post.rotation.z = Math.PI / 2; post.rotation.y = ry; g.add(post);
      }
      break;
    }
    case "tennis": {
      const n = 36, R = 1.32;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const cell = new THREE.Group();
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.085, 0.07, 4), metal(k, { roughness: 0.12 })); cup.rotation.x = Math.PI / 2; cup.rotation.y = Math.PI / 4; cup.position.z = -0.02; cell.add(cup);
        const s = gem(0.092, 0xffffff, 12); s.rotation.x = Math.PI / 2; s.position.z = 0.03; cell.add(s);
        for (const [cx, cy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), metal(k)); b.position.set(cx * 0.075, cy * 0.075, 0.05); cell.add(b); }
        cell.position.set(Math.cos(a) * R, 0, Math.sin(a) * R); cell.lookAt(Math.cos(a) * R * 2, 0, Math.sin(a) * R * 2);
        g.add(cell);
      }
      g.rotation.set(0, 0.3, 0);
      break;
    }
    default: { // solitaire ring
      const band = new THREE.Mesh(new THREE.TorusGeometry(1, 0.075, 24, 128), metal(k)); band.scale.z = 1.25; g.add(band);
      const s = gem(0.36); s.position.y = 1.36; g.add(s);
      const pr = claws(0.36, k, 6); pr.position.y = 1.36; g.add(pr);
      g.rotation.set(0.25, 0.7, 0.1);
    }
  }
  return g;
}

// ------------------------------------------------------------------ handbags
function quiltBump() {
  const t = canvasTex(256, 256, (g) => {
    g.fillStyle = "#b0b0b0"; g.fillRect(0, 0, 256, 256);
    // pillowed diamonds: bright centres, dark stitched seams
    for (let y = -1; y < 3; y++) for (let x = -1; x < 3; x++) for (const off of [0, 64]) {
      const cx = x * 128 + off, cy = y * 128 + off;
      const grd = g.createRadialGradient(cx, cy, 4, cx, cy, 88); grd.addColorStop(0, "#f2f2f2"); grd.addColorStop(1, "rgba(120,120,120,0)");
      g.fillStyle = grd; g.beginPath(); g.moveTo(cx, cy - 64); g.lineTo(cx + 64, cy); g.lineTo(cx, cy + 64); g.lineTo(cx - 64, cy); g.fill();
    }
    g.strokeStyle = "#303030"; g.lineWidth = 5;
    for (let i = -4; i < 8; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64 + 256, 256); g.stroke(); g.beginPath(); g.moveTo(i * 64, 256); g.lineTo(i * 64 + 256, 0); g.stroke(); }
  }, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
/** Front-view outline of a bag body: slightly wider at the base, rounded corners. */
function bagShape(wTop, wBot, h, r) {
  const s = new THREE.Shape();
  s.moveTo(-wBot / 2 + r, 0); s.lineTo(wBot / 2 - r, 0); s.quadraticCurveTo(wBot / 2, 0, wBot / 2 - (wBot - wTop) * 0.02, r);
  s.lineTo(wTop / 2, h - r); s.quadraticCurveTo(wTop / 2, h, wTop / 2 - r, h); s.lineTo(-wTop / 2 + r, h);
  s.quadraticCurveTo(-wTop / 2, h, -wTop / 2, h - r); s.lineTo(-wBot / 2 + (wBot - wTop) * 0.02, r); s.quadraticCurveTo(-wBot / 2, 0, -wBot / 2 + r, 0);
  return s;
}
function flapShape(w, drop, r, curve) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, -drop + r + curve);
  s.quadraticCurveTo(w / 2, -drop + curve, w / 2 - r, -drop + curve * 0.8);
  s.quadraticCurveTo(0, -drop - curve * 0.35, -w / 2 + r, -drop + curve * 0.8);
  s.quadraticCurveTo(-w / 2, -drop + curve, -w / 2, -drop + r + curve);
  return s;
}
const strapTube = (pts, radius, mat, flat = 0.45) => { const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 90, radius, 10), mat); m.userData.flat = flat; return m; };

/** A handbag. o: { kind: "flap"|"quilted"|"crossbody"|"tote", color, hardware } */
export function buildBag(o = {}) {
  const g = new THREE.Group(), hw = metal(o.hardware || "gold", { roughness: 0.1 });
  const kind = o.kind || "flap";
  const dims = { flap: [2.5, 2.7, 1.75, 0.8], quilted: [2.5, 2.6, 1.6, 0.75], crossbody: [2.0, 2.15, 1.5, 0.6], tote: [3.1, 2.5, 2.3, 1.0] }[kind];
  const [wTop, wBot, h, d] = dims;
  const skin = kind === "quilted" ? (() => { const m = leather(o.color ?? 0x121214, { rough: 0.42, coat: 0.3, bump: 0 }); m.bumpMap = quiltBump(); m.bumpMap.repeat.set(1.6, 1.6); m.bumpScale = 3.2; return m; })()
    : leather(o.color ?? 0x15151a, { rough: o.rough ?? 0.5, grain: o.grain ?? 1.2, bump: o.pebble ?? 0.9, rep: 4 });
  const edge = leather(o.edge ?? o.color ?? 0x15151a, { rough: 0.5, bump: 0.2 });
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(bagShape(wTop, wBot, h, 0.16), { depth: d - 0.2, bevelEnabled: true, bevelSize: 0.1, bevelThickness: 0.1, bevelSegments: 6, curveSegments: 10 }), skin);
  body.position.z = -(d - 0.2) / 2; g.add(body);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.05, 16), hw); foot.position.set(x * (wBot / 2 - 0.3), -0.115, z * (d / 2 - 0.2)); g.add(foot); }
  if (kind === "tote") {
    // open top with a rolled edge and two handles
    const lip = new THREE.Mesh(new THREE.ExtrudeGeometry(roundedRect(wTop + 0.04, d + 0.02, 0.2), { depth: 0.07, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 }), edge);
    lip.rotation.x = -Math.PI / 2; lip.position.y = h + 0.02; g.add(lip);
    const inside = new THREE.Mesh(new THREE.PlaneGeometry(wTop - 0.25, d - 0.3), matte(0x2a211b, 0.9)); inside.rotation.x = -Math.PI / 2; inside.position.y = h + 0.115; g.add(inside);
    for (const z of [d / 2 - 0.02, -d / 2 + 0.02]) {
      const pts = [[-0.72, h - 0.5], [-0.74, h + 0.25], [-0.5, h + 1.15], [0, h + 1.42], [0.5, h + 1.15], [0.74, h + 0.25], [0.72, h - 0.5]].map(([x, y]) => new THREE.Vector3(x, y, z + (z > 0 ? 0.06 : -0.06)));
      g.add(strapTube(pts, 0.065, edge));
      for (const x of [-0.72, 0.72]) { const tab = new THREE.Mesh(rbox(0.3, 0.42, 0.04, 0.012), edge); tab.position.set(x, h - 0.42, z + (z > 0 ? 0.08 : -0.08)); g.add(tab); const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), hw); rivet.position.set(x, h - 0.5, z + (z > 0 ? 0.11 : -0.11)); g.add(rivet); }
    }
    const charm = new THREE.Mesh(rbox(0.34, 0.5, 0.03, 0.01), edge); charm.position.set(-0.95, h - 0.75, d / 2 + 0.07); charm.rotation.z = 0.12; g.add(charm);
    g.rotation.y = -0.5;
    return g;
  }
  // flap over the front
  const drop = kind === "crossbody" ? h * 0.62 : h * 0.56;
  const flap = new THREE.Mesh(new THREE.ExtrudeGeometry(flapShape(wTop + 0.06, drop, 0.3, kind === "quilted" ? 0.1 : 0.22), { depth: 0.05, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 4, curveSegments: 16 }), skin);
  flap.position.set(0, h + 0.03, d / 2 + 0.03); flap.rotation.x = 0.045; g.add(flap);
  const top = new THREE.Mesh(rbox(wTop + 0.06, 0.1, d + 0.12, 0.04), skin); top.position.set(0, h + 0.04, 0); g.add(top);
  // clasp: a plain turn-lock or a bar, no logo
  const cy = h - drop + (kind === "quilted" ? 0.28 : 0.3), cz = d / 2 + 0.13;
  if (kind === "quilted") {
    const plate = new THREE.Mesh(rbox(0.5, 0.34, 0.035, 0.012), hw); plate.position.set(0, cy, cz); g.add(plate);
    const knob = new THREE.Mesh(rbox(0.26, 0.1, 0.07, 0.02), hw); knob.position.set(0, cy, cz + 0.045); g.add(knob);
  } else if (kind === "crossbody") {
    const tabL = new THREE.Mesh(rbox(0.32, 0.62, 0.04, 0.012), edge); tabL.position.set(0, cy + 0.1, cz - 0.04); g.add(tabL);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 10, 4), hw); ring.rotation.z = Math.PI / 4; ring.scale.set(1.4, 1, 1); ring.position.set(0, cy - 0.2, cz); g.add(ring);
  } else {
    const bar = new THREE.Mesh(rbox(0.7, 0.2, 0.05, 0.015), hw); bar.position.set(0, cy, cz); g.add(bar);
    const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 20), hw); stud.rotation.x = Math.PI / 2; stud.position.set(0, cy, cz + 0.04); g.add(stud);
  }
  // strap: chain for the quilted bag, leather otherwise; D-rings at the top corners
  const sx = wTop / 2 - 0.08;
  for (const x of [-sx, sx]) { const dr = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.026, 10, 24), hw); dr.position.set(x, h + 0.12, 0); dr.rotation.y = Math.PI / 2; g.add(dr); }
  const rise = kind === "crossbody" ? 1.9 : kind === "quilted" ? 1.9 : 1.25;
  const arc = [];
  for (let i = 0; i <= 44; i++) { const t = i / 44, a = Math.PI * t; arc.push(new THREE.Vector3(-Math.cos(a) * sx * (1 - 0.12 * Math.sin(a)), h + 0.2 + Math.sin(a) * rise, -0.22 * Math.sin(a))); }
  if (kind === "quilted") {
    g.add(chainAlong(arc, o.hardware || "gold", 0.062));
    const pad = strapTube(arc.slice(17, 28), 0.05, edge); g.add(pad);
  } else {
    g.add(strapTube(arc, kind === "crossbody" ? 0.045 : 0.062, edge));
  }
  g.rotation.y = -0.5;
  return g;
}

/** The catalogue: one spec per picture in /seed. */
export const PIECES = {
  // watches
  "seiko.jpg": { t: "watch", case: "steel", dial: "#16233d", dialLight: "#33507f", markers: "arabic", strap: "leather", strapColor: 0x23272f, date: true, hands: "sword", lumeBars: true },
  "khaki-field.jpg": { t: "watch", case: "steel", dial: "#14150e", dialLight: "#2c2e1b", finish: "matte", markers: "arabic", marks: "#e9e2c6", strap: "leather", strapColor: 0x6b5a3a, stitch: 0xcdbf9a, hands: "sword", lumeBars: true, lume: 0xe9e2c6 },
  "seamaster.jpg": { t: "watch", case: "steel", dial: "#d6cfbc", dialLight: "#f4efe1", marks: "#3a352b", strap: "leather", strapColor: 0x4a2a1a, date: true, hands: "dauphine", handColor: "polished", dome: true, seconds: 0x2b2b2b },
  "prx.jpg": { t: "watch", case: "steel", dial: "#0f2c57", dialLight: "#2f62ad", strap: "bracelet", midLinks: false, date: true, hands: "baton" },
  "conquest.jpg": { t: "watch", case: "gold", dial: "#e9dfc4", dialLight: "#fbf6e4", marks: "#4a3d22", strap: "leather", strapColor: 0x17171a, stitch: 0x2a2a2e, date: true, hands: "dauphine", dome: true, seconds: 0x3a2f18 },
  "timex.jpg": { t: "watch", case: "black", dial: "#1c2017", dialLight: "#363d2a", finish: "matte", markers: "arabic", marks: "#e6e0c8", strap: "leather", strapColor: 0x4a5334, stitch: 0x8f9a72, hands: "sword", lumeBars: true },
  "promaster.jpg": { t: "watch", case: "steel", dial: "#0a2240", dialLight: "#1d4a7a", bezel: "dive", bezelColor: "#0c2746", bezelLight: "#1f4877", markers: "dots", strap: "resin", strapColor: 0x121418, date: true, hands: "sword" },
  "gshock.jpg": { t: "watch", shape: "square" },
  "speedmaster.jpg": { t: "watch", case: "steel", dial: "#0d0d0f", dialLight: "#202024", finish: "matte", bezel: "tachy", bezelColor: "#0a0a0b", bezelLight: "#2c2c30", chrono: true, strap: "bracelet", seconds: 0xf2f2f2, hands: "baton", lumeBars: true },
  "diver.jpg": { t: "watch", case: "steel", dial: "#0a0a0b", dialLight: "#1d1d21", bezel: "dive", bezelColor: "#0a0a0b", bezelLight: "#2e2e33", markers: "dots", strap: "bracelet", date: true, hands: "sword" },
  "presage.jpg": { t: "watch", case: "steel", dial: "#176a88", dialLight: "#7fd0e3", strap: "leather", strapColor: 0x27180f, date: true, hands: "dauphine", handColor: "polished", dome: true, seconds: 0x1b2a33 },
  "constellation.jpg": { t: "watch", case: "rose", dial: "#2a2622", dialLight: "#5a5048", marks: "#f0dcc4", strap: "leather", strapColor: 0x3a1d14, small: true, hands: "dauphine", dome: true },
  // jewelry
  "bangle.jpg": { t: "jewel", kind: "bangle", metal: "silver", pose: { pitch: 0.3, fill: 0.6 } },
  "pearls.jpg": { t: "jewel", kind: "pearls", metal: "gold" },
  "studs.jpg": { t: "jewel", kind: "studs", metal: "silver" },
  "chain.jpg": { t: "jewel", kind: "chain", metal: "gold", pose: { pitch: 0.95, fill: 0.7 } },
  "pendant.jpg": { t: "jewel", kind: "pendant", metal: "silver", pose: { pitch: 0.95, fill: 0.7 } },
  "signet.jpg": { t: "jewel", kind: "signet", metal: "gold", pose: { pitch: 0.5, fill: 0.5 } },
  "bracelet.jpg": { t: "jewel", kind: "tennis", metal: "silver", pose: { pitch: 0.62, fill: 0.72 } },
  "hoops.jpg": { t: "jewel", kind: "hoops", metal: "gold" },
  "solitaire.jpg": { t: "jewel", kind: "solitaire", metal: "gold", pose: { pitch: 0.3, fill: 0.6 } },
  // handbags
  "tabby.jpg": { t: "bag", kind: "flap", color: 0x141416, hardware: "gold" },
  "crossbody.jpg": { t: "bag", kind: "crossbody", color: 0xa9713f, edge: 0x7c4f29, hardware: "gold", pebble: 0.5 },
  "quilted.jpg": { t: "bag", kind: "quilted", color: 0x101012, hardware: "gold" },
  "tote.jpg": { t: "bag", kind: "tote", color: 0xb98a5a, edge: 0x6f4526, pebble: 0.45 },
};
export const buildPiece = (spec) => (spec.t === "jewel" ? buildJewel(spec) : spec.t === "bag" ? buildBag(spec) : buildWatch(spec));
export { THREE };
