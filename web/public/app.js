/* Wardrobe Passport — screens (client)
 *
 * How it fits together:
 * - This file draws the screens. It holds no keys and talks to no blockchain
 *   node. It calls the app's own API (Next.js routes on Vercel):
 *     GET  /api/session  who is in the demo, their wallet addresses, chain info
 *     GET  /api/state    items, histories, partners, track records, balances
 *     POST /api/tx       every action (create, list, buy, ship, confirm, dispute…)
 *     POST /api/fund     demo money from the demo treasury
 *     GET  /api/photo/…  photos, addressed by their SHA-256 fingerprint
 * - The API signs with each person's managed wallet (Circle) and sends the
 *   call to the WardrobePassportV2 contract on Arc, which holds the money and
 *   the rules. Amounts are in dollars (Arc's native currency is USDC).
 * - People sign in by role: seller, buyer or authenticator. Each role has its
 *   own screens. A piece must be authenticated before it can be listed, and the
 *   authenticator who vouched for it settles any dispute on that sale.
 * - MetaMask is used for one setup step only: the contract's deployer approving
 *   a partner.
 * - #passport=<id> opens a public, read-only passport page anyone can verify.
 */
(() => {
  "use strict";

  const CFG = window.WP_CONFIG;
  const ABI = window.WP_ABI;
  const { ethers } = window;

  const STATUS = { OWNED: 0, LISTED: 1, PAID: 2, SHIPPED: 3, DISPUTED: 4 };
  const IN_SALE = [STATUS.PAID, STATUS.SHIPPED, STATUS.DISPUTED];
  const PERSONAS = [
    { id: "maya", name: "Maya", color: "#c9a45c" },
    { id: "alex", name: "Alex", color: "#8fb8a8" },
    { id: "shop", name: "Pawn shop", color: "#b9a3d6", partner: true, regName: "Demo Pawn Shop", city: "Atlanta" },
  ];
  // Demo sign-in: each role opens one demo account. Real accounts replace this map.
  const ROLES = {
    seller: { persona: "maya", label: "Seller", cta: "I'm selling", blurb: "Add your pieces, get them authenticated, list them and get paid.", tabs: [["home", "Dashboard"], ["pieces", "My pieces"], ["sales", "Sales"]] },
    buyer: { persona: "alex", label: "Buyer", cta: "I'm buying", blurb: "Shop authenticated pieces. Your money is held until yours arrives.", tabs: [["shop", "Marketplace"], ["orders", "My orders"], ["mine", "My purchases"]] },
    auth: { persona: "shop", label: "Authenticator", cta: "I'm an authenticator", blurb: "Inspect pieces in person, stamp their passports and settle disputes.", tabs: [["requests", "To verify"], ["disputes", "Disputes"], ["record", "My record"]] },
  };
  const LS = { role: "wp.role", tab: "wp.tab." };
  const SHIP_DAYS = 5;
  const CONFIRM_DAYS = 7;
  const DEPOSIT_BPS = 1000n;
  const FEE_BPS = 300n;
  const MAX_PHOTO_CHARS = 350000; // ~260 KB photo, stored by the API; its fingerprint goes in the passport

  const state = {
    wallets: {},
    treasury: null,
    balances: {},
    role: null,
    current: "maya",
    tab: null,
    authRequests: {},
    items: [],
    histories: {},
    partners: [],
    records: {},
    loaded: false,
    online: true,
    busy: false,
    fatal: null,
    openItemId: null,
    publicId: null,
  };

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* storage off */ } };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const isZero = (a) => !a || /^0x0{40}$/i.test(a);
  const usd = (wei) => {
    const n = Number(ethers.formatUnits(wei ?? 0n, 18));
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const usdFee = (wei) => {
    const n = Number(ethers.formatUnits(wei ?? 0n, 18));
    if (n > 0 && n < 0.0001) return "under $0.0001";
    return n > 0 && n < 0.01 ? `$${n.toFixed(4).replace(/0+$/, "")}` : usd(wei);
  };
  const toWei = (dollars) => ethers.parseUnits(String(dollars), 18);
  const depositOf = (priceWei) => (priceWei * DEPOSIT_BPS) / 10000n;
  const feeOf = (priceWei) => (priceWei * FEE_BPS) / 10000n;
  const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const now = () => Date.now() / 1000;
  const me = () => state.wallets[state.current];
  const myAddr = () => me()?.address;
  const person = (id) => PERSONAS.find((p) => p.id === id);
  const cur = () => person(state.current);
  const itemById = (id) => state.items.find((i) => i.id === id);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const explorerAddr = (a) => `${CFG.explorer}/address/${a}`;
  const explorerTx = (h) => `${CFG.explorer}/tx/${h}`;
  const passportUrl = (id) => `${location.origin}${location.pathname}#passport=${id}`;
  const pad = (id) => String(id).padStart(6, "0");

  const partnerOf = (addr) => state.partners.find((p) => same(p.addr, addr));
  const activePartners = () => state.partners.filter((p) => p.active);
  const is = (r) => state.role === r;
  const reqOf = (id) => state.authRequests[id] || null;
  // A piece is verified when a partner authenticated it after it last changed hands.
  function verified(item) {
    if (isZero(item.authBy)) return false;
    const h = state.histories[item.id] || [];
    return item.authAt >= (h.length ? h[h.length - 1].at : 0);
  }
  // Where a piece stands in the authentication stage: verified, pending, declined or none.
  function authStage(item) {
    if (verified(item)) return "verified";
    const r = reqOf(item.id);
    if (r && same(r.owner, item.owner) && (r.status === "pending" || r.status === "declined")) return r.status;
    return "none";
  }
  const shopAddr = () => state.wallets.shop?.address;
  const shopApproved = () => !!partnerOf(shopAddr());

  function nameOf(addr) {
    if (isZero(addr)) return "—";
    const p = partnerOf(addr);
    if (p) return p.name;
    for (const q of PERSONAS) if (same(state.wallets[q.id]?.address, addr)) return q.name;
    return `Member ${short(addr)}`;
  }
  // A passport stores "sha256:<fingerprint>"; the photo itself is served by the API.
  function photoSrc(u) {
    const m = /^sha256:([0-9a-f]{64})$/.exec(u || "");
    if (m) return `/api/photo/${m[1]}`;
    if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(u || "")) return u;
    return null;
  }
  const photoHash = (u) => (/^sha256:([0-9a-f]{64})$/.exec(u || "") || [])[1] || null;

  const ZERO_REC = { sold: 0, bought: 0, refundsGiven: 0, disputesWon: 0, disputesLost: 0 };
  const recOf = (addr) => state.records[(addr || "").toLowerCase()] || ZERO_REC;
  function recText(addr) {
    const r = recOf(addr);
    if (!r.sold && !r.bought && !r.refundsGiven && !r.disputesLost && !r.disputesWon) return "New here: no sales yet";
    const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    return `${r.sold} sold · ${r.bought} bought · ${s(r.refundsGiven, "refund", "refunds")} · ${s(r.disputesLost, "dispute lost", "disputes lost")}`;
  }

  // ------------------------------------------------------------------ icons
  const ICONS = {
    jacket: { label: "Jacket", tint: "#efe2c4", svg: '<path d="M22 8 10 13 6 56h10l2-26v28h28V30l2 26h10L54 13 42 8 32 30z"/><path d="M22 8l5 16-3 4 8 12 8-12-3-4 5-16"/><circle cx="32" cy="47" r="1.4"/><circle cx="32" cy="53" r="1.4"/>' },
    top: { label: "Top", tint: "#e4ebf3", svg: '<path d="M22 10 12 14 4 26l9 5 4-5v30h30V26l4 5 9-5-8-12-10-4c-2 5-6 8-10 8s-8-3-10-8z"/>' },
    dress: { label: "Dress", tint: "#f3e3e3", svg: '<path d="M26 6v8M38 6v8"/><path d="M26 14q6 4 12 0l4 12-6 4 14 28H14l14-28-6-4z"/>' },
    trousers: { label: "Trousers", tint: "#e6e9f0", svg: '<path d="M18 6h28l4 52H37L32 22l-5 36H14z"/><path d="M18 12h28"/>' },
    shoes: { label: "Shoes", tint: "#e7efe9", svg: '<path d="M6 44V34c0-4 3-6 6-6h10l8-8 8 2c2 8 8 12 16 14 4 1 6 4 6 8z"/><path d="M6 44h54v6H6z"/><path d="M28 26l4 4M32 23l4 4"/>' },
    bag: { label: "Bag", tint: "#f1e6da", svg: '<path d="M12 24h40l-4 34H16z"/><path d="M22 24c0-12 20-12 20 0"/><path d="M28 34h8"/>' },
    watch: { label: "Watch", tint: "#e9e6f2", svg: '<path d="M24 18V4h16v14M24 46v14h16V46"/><circle cx="32" cy="32" r="14"/><path d="M32 32v-8M32 32l6 3M46 30h3v4h-3"/>' },
    other: { label: "Other", tint: "#efe9df", svg: '<path d="M28 14c0-5 8-5 8 0 0 3-4 4-4 8"/><path d="M32 22 6 44h52z"/>' },
  };
  function iconKey(imageUrl) {
    const m = /^icon:(\w+)$/.exec(imageUrl || "");
    return m && ICONS[m[1]] ? m[1] : "other";
  }
  function art(item, cls = "") {
    const src = photoSrc(item.imageUrl);
    if (src) {
      return `<div class="art photo ${cls}"><img src="${esc(src)}" alt="${esc(item.name)}" loading="lazy"></div>`;
    }
    const ic = ICONS[iconKey(item.imageUrl)];
    return `<div class="art ${cls}" style="--tint:${ic.tint}"><svg viewBox="0 0 64 64" aria-hidden="true">${ic.svg}</svg></div>`;
  }

  // Sample pieces make demos fast; they're normal passports once created.
  const SAMPLES = [
    { name: "Navy wool blazer", brand: "Hugo Boss", details: "Size 40R, worn twice", kind: "jacket" },
    { name: "Steel dive watch", brand: "Seiko", details: "Box and papers, serviced 2025", kind: "watch" },
    { name: "Leather tote", brand: "Coach", details: "Tan, like new", kind: "bag" },
    { name: "White leather sneakers", brand: "Common Projects", details: "US 9, light wear", kind: "shoes" },
  ];

  // ------------------------------------------------------------- API access
  async function api(path, body) {
    const res = await withTimeout(fetch(path, body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { cache: "no-store" }), 90000);
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !data) throw Object.assign(new Error(data?.error || "Something went wrong. Please try again."), { friendly: data?.error });
    return data;
  }

  async function connect() {
    const s = await api("/api/session");
    Object.assign(CFG, s.config);
    for (const u of s.users) {
      if (u.handle === "treasury") state.treasury = { address: u.address, balance: 0n };
      else state.wallets[u.handle] = { address: u.address };
    }
  }

  function setRole(r, restoreTab = false) {
    state.role = ROLES[r] ? r : null;
    lsSet(LS.role, state.role || "");
    if (!state.role) { state.tab = null; return; }
    state.current = ROLES[r].persona;
    // Signing in lands on the role's home screen; a page reload returns to the tab you were on.
    const saved = restoreTab ? lsGet(LS.tab + r) : null;
    state.tab = ROLES[r].tabs.some(([id]) => id === saved) ? saved : ROLES[r].tabs[0][0];
  }
  function loadSession() {
    const saved = lsGet(LS.role);
    if (ROLES[saved]) setRole(saved, true);
  }

  // Overlapping refreshes (timer + after an action) must not let an older,
  // slower read overwrite newer data, so only the latest one is applied.
  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq;
    try {
      const d = await api("/api/state");
      if (seq !== refreshSeq) return; // a newer refresh is on its way
      state.items = d.items.map((i) => ({ ...i, price: BigInt(i.price), deposit: BigInt(i.deposit) }));
      state.histories = {};
      for (const [id, h] of Object.entries(d.histories)) state.histories[id] = h.map((t) => ({ ...t, price: BigInt(t.price) }));
      state.partners = d.partners;
      state.records = d.records;
      state.authRequests = d.authRequests || {};
      for (const p of PERSONAS) state.balances[p.id] = BigInt(d.balances[state.wallets[p.id].address.toLowerCase()] ?? 0);
      if (state.treasury) state.treasury.balance = BigInt(d.balances[state.treasury.address.toLowerCase()] ?? 0);
      state.loaded = true;
      state.online = true;
    } catch (e) {
      console.warn("Refresh failed", e);
      if (seq !== refreshSeq) return;
      state.online = false;
    }
    render();
  }

  // Derived facts about an item from its history
  function facts(item) {
    const h = state.histories[item.id] || [];
    const sales = h.filter((t) => !isZero(t.from));
    return { created: h[0]?.at, owners: Math.max(1, h.length), sales, lastSale: sales[sales.length - 1] };
  }

  function stats() {
    let sales = 0, volume = 0n, held = 0n, authed = 0;
    for (const it of state.items) {
      for (const t of state.histories[it.id] || []) if (!isZero(t.from)) { sales++; volume += t.price; }
      if (IN_SALE.includes(it.status)) held += it.price;
      if (!isZero(it.authBy)) authed++;
    }
    return { passports: state.items.length, sales, volume, held, authed };
  }

  // ---------------------------------------------------------- actions
  // Each action is a small request to POST /api/tx. The server checks it,
  // signs with the person's managed wallet and sends it to the contract.
  const ACTIONS = {
    createPassport: (name, brand, details, photo, icon) => ({ action: "createPassport", name, brand, details, photo, icon }),
    requestAuth: (id, partner) => ({ action: "requestAuth", id, partner }),
    cancelAuthRequest: (id) => ({ action: "cancelAuthRequest", id }),
    declineAuth: (id, reason) => ({ action: "declineAuth", id, reason }),
    listForSale: (id, priceWei) => ({ action: "list", id, price: ethers.formatUnits(priceWei, 18) }),
    cancelListing: (id) => ({ action: "unlist", id }),
    buy: (id) => ({ action: "buy", id }),
    markShipped: (id) => ({ action: "ship", id }),
    confirmDelivery: (id) => ({ action: "confirm", id }),
    sellerClaim: (id) => ({ action: "claim", id }),
    sellerCancelSale: (id) => ({ action: "sellerCancel", id }),
    buyerCancelUnshipped: (id) => ({ action: "buyerCancel", id }),
    openDispute: (id, reason) => ({ action: "dispute", id, reason }),
    authenticate: (id, note) => ({ action: "authenticate", id, note }),
    resolveDispute: (id, buyerWins) => ({ action: "resolve", id, buyerWins }),
  };

  const GENERIC = "Something went wrong. Please try again.";
  function friendlyError(e) {
    if (e?.friendly) return e.friendly;
    const msg = `${e?.shortMessage || ""} ${e?.message || ""}`.toLowerCase();
    if (msg.includes("timeout")) return "That took too long. Check your orders before trying again.";
    return GENERIC;
  }

  async function runTx({ pending, done, send }) {
    if (state.busy) return null;
    state.busy = true;
    render();
    const t = toast(pending, "pending");
    try {
      const r = await api("/api/tx", { as: state.current, ...send(ACTIONS) });
      updateToast(t, r.fee ? `${done} Network fee: ${usdFee(BigInt(r.fee))}.` : done, "ok", r.hash);
      await refresh();
      return r;
    } catch (e) {
      console.error(e);
      updateToast(t, friendlyError(e), "error");
      await refresh();
      return null;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function hasMoney(wei) {
    return (state.balances[state.current] ?? 0n) >= wei;
  }

  // ---------------------------------------------------------------- toasts
  function toast(text, kind = "ok", hash) {
    const root = $("#toast-root");
    const el = document.createElement("div");
    root.appendChild(el);
    // Keep the screen tidy: at most 2 messages at once (never drop one still in progress).
    while (root.children.length > 2) {
      const old = [...root.children].find((c) => !c.classList.contains("pending") && c !== el);
      if (!old) break;
      old.remove();
    }
    updateToast(el, text, kind, hash);
    return el;
  }
  function updateToast(el, text, kind, hash) {
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>${hash ? `<a href="${explorerTx(hash)}" target="_blank" rel="noopener">View on Arc ↗</a>` : ""}`;
    if (kind !== "pending") setTimeout(() => el.remove(), kind === "error" ? 8000 : 6000);
  }

  // ---------------------------------------------------------------- modals
  function openModal(title, bodyHtml, onMount) {
    closeModal();
    const root = $("#modal-root");
    root.innerHTML = `
      <div class="backdrop" data-close>
        <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal-head"><h3>${esc(title)}</h3><button class="x" data-close aria-label="Close">×</button></div>
          <div class="modal-body">${bodyHtml}</div>
        </div>
      </div>`;
    root.querySelector(".backdrop").addEventListener("click", (ev) => {
      if (ev.target.hasAttribute("data-close")) closeModal();
    });
    onMount && onMount(root.querySelector(".modal"));
  }
  function closeModal() { $("#modal-root").innerHTML = ""; state.openItemId = null; }
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });

  // ------------------------------------------------------------- rendering
  function chipFor(item) {
    const mineAsBuyer = same(item.buyer, myAddr());
    switch (item.status) {
      case STATUS.LISTED: return `<span class="chip listed">For sale · ${usd(item.price)}</span>`;
      case STATUS.PAID: return mineAsBuyer
        ? `<span class="chip held">Paid · waiting for seller to ship</span>`
        : `<span class="chip held">Sold · ${usd(item.price)} held · ship it</span>`;
      case STATUS.SHIPPED: return mineAsBuyer
        ? `<span class="chip held">On its way · ${usd(item.price)} held</span>`
        : `<span class="chip held">Shipped · ${usd(item.price)} held</span>`;
      case STATUS.DISPUTED: return `<span class="chip bad">Dispute open</span>`;
      default: {
        if (!is("seller") || !same(item.owner, myAddr())) return `<span class="chip owned">${same(item.owner, myAddr()) ? "Yours" : "Not for sale"}</span>`;
        const st = authStage(item);
        if (st === "verified") return `<span class="chip ok">Verified · ready to list</span>`;
        if (st === "pending") return `<span class="chip held">Waiting for ${esc(nameOf(reqOf(item.id).partner))}</span>`;
        if (st === "declined") return `<span class="chip bad">Not verified</span>`;
        return `<span class="chip owned">Needs authentication</span>`;
      }
    }
  }

  function provenance(item) {
    const f = facts(item);
    if (f.lastSale) return `Last sold ${usd(f.lastSale.price)} · ${f.owners} owners`;
    return f.created ? `Passport since ${fmtDate(f.created)}` : "";
  }

  const authBadge = (item) => (verified(item) ? `<span class="auth-badge" title="Authenticated by ${esc(nameOf(item.authBy))}">✓ Verified</span>` : "");

  function card(item, footer) {
    return `
      <button class="card" data-open="${item.id}" aria-label="Open ${esc(item.name)}">
        <div class="card-art">${art(item)}<span class="pid">Passport #${item.id}</span>${authBadge(item)}</div>
        <div class="card-body">
          <p class="card-title">${esc(item.name)}</p>
          <p class="card-brand">${esc(item.brand || "No brand")}</p>
          <p class="card-prov">${esc(provenance(item))}</p>
          <div class="card-foot">${footer ?? chipFor(item)}</div>
        </div>
      </button>`;
  }

  function renderWho() {
    const el = $("#who");
    if (!state.role || state.publicId) { el.innerHTML = ""; return; }
    const p = cur();
    el.innerHTML = `
      <div class="persona active" aria-label="Signed in">
        <span class="avatar" style="background:${p.color}">${p.name[0]}</span>
        <span><div class="p-name">${esc(p.regName || p.name)} <em>${esc(ROLES[state.role].label)}</em></div><div class="p-bal">${state.loaded ? usd(state.balances[p.id]) : "…"}</div></span>
      </div>
      <button class="addmoney" data-action="add-money">+ Add money</button>
      <button class="signout" data-action="sign-out">Sign out</button>`;
  }

  const mineSelling = () => state.items.filter((i) => IN_SALE.includes(i.status) && same(i.owner, myAddr()));
  const mineBuying = () => state.items.filter((i) => IN_SALE.includes(i.status) && same(i.buyer, myAddr()));
  const myRequests = () => state.items.filter((i) => {
    const r = reqOf(i.id);
    return r && r.status === "pending" && same(r.partner, myAddr()) && same(r.owner, i.owner) && i.status === STATUS.OWNED && !verified(i);
  });
  const myDisputes = () => state.items.filter((i) => i.status === STATUS.DISPUTED && same(i.partner, myAddr()));

  function renderTabs() {
    const nav = $("#tabs");
    if (!state.role || !state.loaded) { nav.innerHTML = ""; return; }
    const counts = {
      sales: mineSelling().length, orders: mineBuying().length,
      requests: myRequests().length, disputes: myDisputes().length,
    };
    nav.innerHTML = ROLES[state.role].tabs.map(([id, label]) =>
      `<button role="tab" data-tab="${id}" class="tab ${state.tab === id ? "active" : ""}" aria-selected="${state.tab === id}">${label}${counts[id] ? `<span class="count">${counts[id]}</span>` : ""}</button>`).join("");
  }

  function setupTip() {
    if (!state.loaded) return "";
    if (!shopApproved()) {
      return `<p class="tip">Demo setup: the pawn shop isn't an approved authenticator yet. <button class="linkish" data-action="approve-partner">Approve it with MetaMask</button> (the account that deployed the contract).</p>`;
    }
    return "";
  }
  function moneyTip() {
    if ((state.balances[state.current] ?? 0n) > 0n) return "";
    return `<p class="tip boxed">You have no test dollars yet. <button class="linkish" data-action="add-money">+ Add money</button> to cover ${is("buyer") ? "purchases" : is("seller") ? "the listing deposit and small network fees" : "small network fees"}.</p>`;
  }
  const tiles = (list) => `<div class="tiles">${list.map(([v, l]) => `<div class="tile"><strong>${v}</strong><small>${esc(l)}</small></div>`).join("")}</div>`;
  const STEPS = ["Seller asks for authentication", "Authenticator checks it in person", "Listed as verified", "Buyer pays, money is held", "Shipped: confirm or dispute", "Authenticator settles disputes"];
  const stepsHtml = () => `<ol class="steps">${STEPS.map((t, i) => `<li><span>${i + 1}</span>${t}</li>`).join("")}<li class="how-link"><button class="linkish" data-action="how">How it works on Arc</button></li></ol>`;

  function renderHero() {
    const el = $("#hero");
    if (!state.loaded || state.role) { el.innerHTML = ""; return; }
    const s = stats();
    el.innerHTML = `
      <div class="hero-copy">
        <h2>Resale you can trust.</h2>
        <p>Every piece gets a passport on Arc. A local authenticator checks it in person before it can be listed. The buyer's money is held until the piece arrives, and the same authenticator settles any dispute.</p>
        ${stepsHtml()}
        ${setupTip()}
      </div>
      <div class="hero-stats" aria-label="Live totals from Arc">
        <div class="stat"><strong>${s.passports}</strong><small>passports on Arc</small></div>
        <div class="stat"><strong>${s.authed}</strong><small>authenticated in person</small></div>
        <div class="stat"><strong>${usd(s.volume)}</strong><small>paid out in ${s.sales} sale${s.sales === 1 ? "" : "s"}</small></div>
        <div class="stat"><strong>${usd(s.held)}</strong><small>held right now</small></div>
      </div>`;
  }

  // ------------------------------------------------------------------ sign in
  function renderLogin() {
    const wallet = CFG.walletProvider === "circle" ? "Circle wallet" : "test wallet";
    return `
      <div class="section-head"><div><h2>Sign in</h2><p>Choose how you're using Wardrobe Passport today.</p></div></div>
      <div class="roles">${Object.entries(ROLES).map(([id, r]) => {
        const p = person(r.persona);
        return `
        <button class="role-card" data-role="${id}">
          <span class="avatar" style="background:${p.color}">${p.name[0]}</span>
          <span class="role-kicker">${esc(r.label)}</span>
          <h3>${esc(r.cta)}</h3>
          <p>${esc(r.blurb)}</p>
          <span class="role-as">Signs in as ${esc(p.regName ? `${p.regName}, ${p.city}` : p.name)}</span>
          <span class="role-go">Continue →</span>
        </button>`;
      }).join("")}</div>
      <p class="fine center">Demo sign-in, no password. Each account has its own ${wallet} on ${esc(CFG.chainName)}.</p>`;
  }

  // ------------------------------------------------------------------ seller
  const NEXT = {
    none: "Ask an authenticator to verify it",
    declined: "Not verified. Ask again or choose another authenticator",
    verified: "Verified. Set a price and list it",
  };
  function renderSellerHome() {
    const mine = state.items.filter((i) => same(i.owner, myAddr()));
    const owned = mine.filter((i) => i.status === STATUS.OWNED);
    const waiting = owned.filter((i) => authStage(i) === "pending");
    const listed = mine.filter((i) => i.status === STATUS.LISTED);
    const toShip = mine.filter((i) => i.status === STATUS.PAID);
    let earned = 0n;
    for (const it of state.items) for (const t of state.histories[it.id] || []) if (same(t.from, myAddr())) earned += t.price - feeOf(t.price);
    const dis = state.busy ? "disabled" : "";

    let html = `
      <div class="section-head">
        <div><h2>Welcome back, ${esc(cur().name)}</h2><p>Seller · ${esc(recText(myAddr()))}</p></div>
        <button class="btn primary" data-action="add-item" ${dis}>+ Add a piece</button>
      </div>
      ${moneyTip()}
      ${tiles([[mine.length, "pieces"], [waiting.length, "waiting for authenticator"], [listed.length, "for sale"], [toShip.length, "to ship"], [usd(earned), "earned from sales"]])}`;

    const todo = [];
    for (const i of owned) { const st = authStage(i); if (NEXT[st]) todo.push([i, NEXT[st], st === "verified" ? "List it" : "Request"]); }
    for (const i of toShip) todo.push([i, `${nameOf(i.buyer)} paid ${usd(i.price)}. Ship it and mark it as shipped`, "Ship"]);
    for (const i of mine.filter((x) => x.status === STATUS.SHIPPED && now() >= x.shippedAt + CONFIRM_DAYS * 86400)) todo.push([i, "The buyer didn't respond. You can collect the payment", "Collect"]);
    for (const i of mine.filter((x) => x.status === STATUS.DISPUTED)) todo.push([i, `Dispute open. ${nameOf(i.partner)} will decide`, "View"]);

    html += `<div class="h-label">What to do next</div>`;
    if (!mine.length) {
      html += `<div class="empty"><h3>Start with your first piece</h3><p>Add a piece and it gets a digital passport: a photo, who owned it, when, and for how much.</p><button class="btn gold" data-action="add-item" ${dis}>Add your first piece</button></div>`;
    } else if (!todo.length) {
      html += `<div class="empty slim"><p>Nothing needs you right now${waiting.length ? ". An authenticator is checking your piece" : listed.length ? ". Your listing is live in the marketplace" : ""}.</p></div>`;
    } else {
      html += `<div class="done-list">` + todo.map(([i, textLine, cta]) => `
        <button class="done" data-open="${i.id}">
          ${art(i, "mini")}
          <span><strong>${esc(i.name)}</strong><small>${esc(textLine)}</small></span>
          <span class="done-cta">${cta} →</span>
        </button>`).join("") + `</div>`;
    }
    html += `<div class="h-label">How a sale works</div><div class="panel">${stepsHtml()}</div>`;
    return html;
  }

  function renderPieces() {
    const mine = state.items.filter((i) => same(i.owner, myAddr())).reverse();
    const head = `
      <div class="section-head">
        <div><h2>My pieces</h2><p>${mine.length} piece${mine.length === 1 ? "" : "s"} · each one is authenticated before it can be listed</p></div>
        <button class="btn primary" data-action="add-item" ${state.busy ? "disabled" : ""}>+ Add a piece</button>
      </div>`;
    if (!mine.length) {
      return head + `
        <div class="empty">
          <h3>No pieces yet</h3>
          <p>Add a piece and it gets a digital passport: a photo, who owned it, when, and for how much.</p>
          <button class="btn gold" data-action="add-item" ${state.busy ? "disabled" : ""}>Add your first piece</button>
        </div>`;
    }
    return head + `<div class="grid">${mine.map((i) => card(i)).join("")}</div>`;
  }

  // ------------------------------------------------------------------- buyer
  function renderShop() {
    const forSale = state.items.filter((i) => i.status === STATUS.LISTED && !same(i.owner, myAddr())).reverse();
    const head = `
      <div class="section-head">
        <div><h2>Marketplace</h2><p>Every piece here was checked in person by an authenticator. Your money is held until it arrives.</p></div>
      </div>${moneyTip()}`;
    if (!forSale.length) {
      return head + `
        <div class="empty">
          <h3>Nothing for sale right now</h3>
          <p>Pieces appear here once an authenticator has verified them and the seller has listed them.</p>
        </div>`;
    }
    return head + `<div class="grid">${forSale.map((i) => card(i, `
      <span class="price">${usd(i.price)}</span>
      <span class="chip ok" title="${esc(recText(i.owner))}">${esc(nameOf(i.owner))} · ${recOf(i.owner).sold} sold</span>`)).join("")}</div>`;
  }

  function renderMine() {
    const mine = state.items.filter((i) => same(i.owner, myAddr()) && i.status === STATUS.OWNED).reverse();
    const head = `<div class="section-head"><div><h2>My purchases</h2><p>Pieces you own, each with its passport · ${esc(recText(myAddr()))}</p></div></div>`;
    if (!mine.length) {
      return head + `<div class="empty"><h3>Nothing here yet</h3><p>When a piece arrives and you confirm it, its passport moves to you and it shows here.</p><button class="btn ghost" data-tab-go="shop">Browse the marketplace</button></div>`;
    }
    return head + `<div class="grid">${mine.map((i) => card(i)).join("")}</div>`;
  }

  // What each side sees and can do for an item that's mid-sale
  function saleBlock(i) {
    const dis = state.busy ? "disabled" : "";
    const isBuyer = same(i.buyer, myAddr());
    const isSeller = same(i.owner, myAddr());
    const partner = nameOf(i.partner);
    const shipBy = i.paidAt + SHIP_DAYS * 86400;
    const confirmBy = i.shippedAt + CONFIRM_DAYS * 86400;
    let chip = "", note = "", actions = "";

    if (i.status === STATUS.PAID && isBuyer) {
      chip = `${usd(i.price)} held · waiting for ${esc(nameOf(i.owner))} to ship`;
      note = now() >= shipBy
        ? `It wasn't shipped in ${SHIP_DAYS} days. You can cancel and receive the seller's deposit too.`
        : `If it isn't shipped by ${fmtDate(shipBy)}, you can cancel and also receive the seller's ${usd(i.deposit)} deposit.`;
      actions = `<button class="btn gold" data-action="confirm" data-id="${i.id}" ${dis}>I received it</button>` +
        (now() >= shipBy ? `<button class="btn danger" data-action="buyer-cancel" data-id="${i.id}" ${dis}>Never shipped: cancel and refund me</button>` : "");
    } else if (i.status === STATUS.SHIPPED && isBuyer) {
      chip = `${usd(i.price)} held · shipped ${fmtDate(i.shippedAt)}`;
      note = `Confirm or open a dispute by ${fmtDate(confirmBy)}. After that, ${esc(nameOf(i.owner))} can collect the payment.`;
      actions = `<button class="btn gold" data-action="confirm" data-id="${i.id}" ${dis}>I received it</button>
        <button class="btn danger" data-action="dispute" data-id="${i.id}" ${dis}>Something's wrong</button>`;
    } else if (i.status === STATUS.DISPUTED && isBuyer) {
      chip = `Dispute open · ${usd(i.price)} held`;
      note = `${esc(partner)} is reviewing it. Your reason: “${esc(i.disputeReason)}”`;
    } else if (i.status === STATUS.PAID && isSeller) {
      chip = `${esc(nameOf(i.buyer))} paid ${usd(i.price)} · held`;
      note = `Ship it by ${fmtDate(shipBy)}, then mark it as shipped. You're paid when the buyer confirms.`;
      actions = `<button class="btn gold" data-action="ship" data-id="${i.id}" ${dis}>Mark as shipped</button>
        <button class="btn danger" data-action="seller-cancel" data-id="${i.id}" ${dis}>Can't ship? Refund the buyer</button>`;
    } else if (i.status === STATUS.SHIPPED && isSeller) {
      chip = `Shipped · ${usd(i.price)} held`;
      note = now() >= confirmBy
        ? `The buyer didn't respond in ${CONFIRM_DAYS} days. You can collect the payment now.`
        : `Waiting for ${esc(nameOf(i.buyer))} to confirm. If they say nothing, you can collect from ${fmtDate(confirmBy)}.`;
      actions = now() >= confirmBy ? `<button class="btn gold" data-action="claim" data-id="${i.id}" ${dis}>Collect payment</button>` : "";
    } else if (i.status === STATUS.DISPUTED && isSeller) {
      chip = `Dispute open · ${usd(i.price)} held`;
      note = `${esc(nameOf(i.buyer))} says: “${esc(i.disputeReason)}”. ${esc(partner)} will decide. If you lose, you lose your ${usd(i.deposit)} deposit.`;
    }
    return { chip, note, actions, bad: i.status === STATUS.DISPUTED };
  }

  function orderRow(i) {
    const b = saleBlock(i);
    const isBuyer = same(i.buyer, myAddr());
    return `
      <div class="order">
        ${art(i)}
        <div>
          <h3>${esc(i.name)}</h3>
          <p>${esc(i.brand)} · ${isBuyer ? `from ${esc(nameOf(i.owner))}` : `bought by ${esc(nameOf(i.buyer))}`} · paid ${fmtDate(i.paidAt)} · protected by ${esc(nameOf(i.partner))}</p>
          <span class="chip ${b.bad ? "bad" : "held"}">${b.chip}</span>
          <p class="fine">${b.note}</p>
          <div class="actions">${b.actions}<button class="btn ghost" data-open="${i.id}">View passport</button></div>
        </div>
      </div>`;
  }

  function renderOrders(side) {
    const buying = side === "buying";
    const open = buying ? mineBuying() : mineSelling();
    const done = [];
    for (const it of state.items) {
      for (const t of state.histories[it.id] || []) {
        if (isZero(t.from)) continue;
        if (buying && same(t.to, myAddr())) done.push({ it, t, kind: "Bought", other: t.from });
        else if (!buying && same(t.from, myAddr())) done.push({ it, t, kind: "Sold", other: t.to });
      }
    }
    done.sort((a, b) => b.t.at - a.t.at);

    let html = `
      <div class="section-head">
        <div><h2>${buying ? "My orders" : "Sales"}</h2><p>${buying ? "What you've paid for and what has arrived" : "What you've sold, what to ship and what you've been paid"} · ${esc(recText(myAddr()))}</p></div>
      </div>`;
    if (!open.length && !done.length) {
      return html + `
        <div class="empty">
          <h3>${buying ? "No orders yet" : "No sales yet"}</h3>
          <p>${buying ? "When you buy a piece, it shows here until it arrives and the sale is settled." : "When someone buys one of your pieces, it shows here until the sale is settled."}</p>
          <button class="btn ghost" data-tab-go="${buying ? "shop" : "pieces"}">${buying ? "Browse the marketplace" : "See my pieces"}</button>
        </div>`;
    }
    if (open.length) html += `<div class="h-label">${buying ? "On the way" : "In progress"}</div>` + open.map(orderRow).join("");
    if (done.length) {
      html += `<div class="h-label">Completed</div><div class="done-list">` + done.map(({ it, t, kind, other }) => `
        <button class="done" data-open="${it.id}">
          ${art(it, "mini")}
          <span><strong>${kind} ${esc(it.name)}</strong><small>${kind === "Bought" ? "from" : "to"} ${esc(nameOf(other))} · ${fmtDate(t.at)}</small></span>
          <span class="done-amt ${kind === "Sold" ? "plus" : ""}">${kind === "Sold" ? "+" : "−"}${usd(t.price)}</span>
        </button>`).join("") + `</div>`;
    }
    return html;
  }

  // ------------------------------------------------------------ partner desk
  function renderDesk() {
    const p = partnerOf(myAddr());
    const dis = state.busy ? "disabled" : "";
    if (!p) {
      return `
        <div class="empty">
          <h3>This shop isn't an approved authenticator yet</h3>
          <p>Authenticators are approved by the account that deployed the contract. Once approved, the shop can verify pieces and settle disputes.</p>
          <button class="btn gold" data-action="approve-partner">Approve “${esc(cur().regName)}” with MetaMask</button>
        </div>`;
    }
    const disputes = myDisputes();
    const requests = myRequests();
    const behind = state.items.filter((i) => same(i.partner, myAddr()) && i.status !== STATUS.DISPUTED && i.status !== STATUS.OWNED);
    const stamped = state.items.filter((i) => same(i.authBy, myAddr())).reverse();

    let html = `
      <div class="section-head">
        <div><h2>${esc(p.name)} · ${esc(p.city)}</h2>
        <p>Verified authenticator${p.active ? "" : " (paused)"} · earns ${Number(FEE_BPS) / 100}% of each sale it stands behind</p></div>
      </div>
      ${moneyTip()}
      ${tiles([[requests.length, "pieces to verify"], [disputes.length, "open disputes"], [p.authenticated, "pieces authenticated"], [p.disputesResolved, "disputes settled"], [usd(state.balances[state.current]), "balance"]])}`;

    if (state.tab === "disputes") {
      html += `<div class="h-label">Disputes to settle</div>`;
      html += disputes.length ? disputes.map((i) => `
        <div class="order">
          ${art(i)}
          <div>
            <h3>${esc(i.name)} <small class="muted">Passport #${i.id}</small></h3>
            <p>${esc(nameOf(i.buyer))} bought it from ${esc(nameOf(i.owner))} for ${usd(i.price)}. You authenticated it on ${fmtDate(i.authAt)}.</p>
            <span class="chip bad">Buyer says: “${esc(i.disputeReason)}”</span>
            <p class="fine">Buyer's record: ${esc(recText(i.buyer))}. Seller's record: ${esc(recText(i.owner))}.</p>
            <div class="actions">
              <button class="btn primary" data-action="resolve" data-win="buyer" data-id="${i.id}" ${dis}>Buyer is right: refund ${usd(i.price)}</button>
              <button class="btn ghost" data-action="resolve" data-win="seller" data-id="${i.id}" ${dis}>Seller is right: release payment</button>
              <button class="btn ghost" data-open="${i.id}">View passport</button>
            </div>
          </div>
        </div>`).join("") : `<div class="empty slim"><p>No open disputes.</p></div>`;
      return html;
    }

    if (state.tab === "record") {
      html += `<div class="h-label">Sales you stand behind</div>`;
      html += behind.length ? `<div class="done-list">` + behind.map((i) => `
        <button class="done" data-open="${i.id}">
          ${art(i, "mini")}
          <span><strong>${esc(i.name)}</strong><small>${esc(nameOf(i.owner))}${isZero(i.buyer) ? " · listed" : ` → ${esc(nameOf(i.buyer))}`} · your fee ${usd(feeOf(i.price))}</small></span>
          <span class="done-amt">${usd(i.price)}</span>
        </button>`).join("") + `</div>` : `<div class="empty slim"><p>No live sales right now.</p></div>`;
      html += `<div class="h-label">Authenticated by you</div>`;
      html += stamped.length ? `<div class="grid">${stamped.map((i) => card(i)).join("")}</div>` : `<div class="empty slim"><p>Nothing yet.</p></div>`;
      return html;
    }

    html += `<div class="h-label">Sellers waiting for you</div>`;
    html += requests.length ? requests.map((i) => `
      <div class="order">
        ${art(i)}
        <div>
          <h3>${esc(i.name)} <small class="muted">Passport #${i.id}</small></h3>
          <p>${esc(i.brand || "No brand")}${i.details ? ` · ${esc(i.details)}` : ""}</p>
          <span class="chip held">${esc(nameOf(i.owner))} asked on ${fmtDate(reqOf(i.id).createdAt)}</span>
          <p class="fine">Owner's record: ${esc(recText(i.owner))}. Inspect the piece in person before you stamp it. It can't be listed until you do.</p>
          <div class="actions">
            <button class="btn gold" data-action="auth" data-id="${i.id}" ${dis}>Authenticate</button>
            <button class="btn ghost" data-action="decline" data-id="${i.id}" ${dis}>Can't verify</button>
            <button class="btn ghost" data-open="${i.id}">View passport</button>
          </div>
        </div>
      </div>`).join("") : `<div class="empty slim"><p>Nothing waiting. Sellers' requests show up here.</p></div>`;
    return html;
  }

  function renderFoot() {
    $("#foot").innerHTML = `
      <span class="live ${state.online ? "" : "down"}">${state.online ? `Live on ${esc(CFG.chainName)}` : "Reconnecting to Arc…"}</span>
      <span>·</span>
      <a href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">Contract ${short(CFG.contractAddress)} ↗</a>
      <span>·</span>
      <button class="linkish foot-link" data-action="how">How it works</button>
      <span>·</span>
      <span>${CFG.walletProvider === "circle" ? "Wallets by Circle · " : ""}Demo: test dollars and a demo authenticator</span>`;
  }

  function render() {
    document.body.classList.toggle("public", !!state.publicId);
    renderWho();
    renderTabs();
    renderFoot();
    const view = $("#view");
    if (state.fatal) {
      $("#hero").innerHTML = "";
      view.innerHTML = `<div class="empty"><h3>Can't connect</h3><p>${esc(state.fatal)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
      return;
    }
    if (!state.loaded) {
      view.innerHTML = `<div class="loading"><div class="spinner"></div>Connecting to Arc…</div>`;
      return;
    }
    if (state.publicId) {
      $("#hero").innerHTML = "";
      view.innerHTML = renderPublic(state.publicId);
      return;
    }
    renderHero();
    document.body.classList.toggle("signed-out", !state.role);
    if (!state.role) { view.innerHTML = renderLogin(); return; }
    const VIEWS = {
      home: renderSellerHome, pieces: renderPieces, sales: () => renderOrders("selling"),
      shop: renderShop, orders: () => renderOrders("buying"), mine: renderMine,
      requests: renderDesk, disputes: renderDesk, record: renderDesk,
    };
    view.innerHTML = (VIEWS[state.tab] || VIEWS[ROLES[state.role].tabs[0][0]])();
    if (state.openItemId) refreshDetailActions();
  }

  // ------------------------------------------------- public passport page
  function qrSvg(text) {
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 0 });
    } catch (_) { return ""; }
  }

  function statusText(item) {
    switch (item.status) {
      case STATUS.LISTED: return `For sale · ${usd(item.price)}`;
      case STATUS.PAID: return "Sold · payment held, waiting to ship";
      case STATUS.SHIPPED: return "Sold · shipped, payment held";
      case STATUS.DISPUTED: return "Sale in dispute · payment held";
      default: return "In owner's wardrobe";
    }
  }

  function timelineHtml(item) {
    const h = state.histories[item.id] || [];
    const rows = h.map((t) => ({ at: t.at, html: isZero(t.from)
      ? `<li><div class="t-main">Passport issued to ${esc(nameOf(t.to))}</div><div class="t-sub">${fmtDate(t.at)}</div></li>`
      : `<li><div class="t-main">${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} for ${usd(t.price)}</div><div class="t-sub">${fmtDate(t.at)} · sale settled, payment released</div></li>` }));
    if (!isZero(item.authBy)) {
      rows.push({ at: item.authAt, html: `<li class="t-auth"><div class="t-main">Authenticated by ${esc(nameOf(item.authBy))}</div><div class="t-sub">${fmtDate(item.authAt)}${item.authNote ? ` · “${esc(item.authNote)}”` : ""}</div></li>` });
    }
    rows.sort((a, b) => a.at - b.at);
    return rows.length ? rows.map((r) => r.html).join("") : `<li><div class="t-sub">No history yet.</div></li>`;
  }

  function authLine(item) {
    if (isZero(item.authBy)) return `<div class="callout info">Not yet authenticated. It can't be listed for sale until an authenticator has checked it in person.</div>`;
    const p = partnerOf(item.authBy);
    const who = `${esc(nameOf(item.authBy))}${p ? `, ${esc(p.city)}` : ""}`;
    if (!verified(item)) return `<div class="callout info">Authenticated by ${who} on ${fmtDate(item.authAt)}, before it last changed hands. It needs a fresh check before it can be sold again.</div>`;
    return `<div class="callout ok"><strong>✓ Authenticated in person by ${who}</strong> on ${fmtDate(item.authAt)}.${item.authNote ? ` “${esc(item.authNote)}”` : ""}</div>`;
  }

  function renderPublic(id) {
    const item = itemById(id);
    if (!item) {
      return `<div class="empty"><h3>Passport #${esc(id)} not found</h3><p>Check the link, or open the app.</p><button class="btn primary" data-action="leave-public">Open the app</button></div>`;
    }
    const f = facts(item);
    const url = passportUrl(id);
    return `
      <div class="pp">
        <button class="linkish back" data-action="leave-public">← Back to the app</button>
        <article class="cert">
          <div class="cert-top">
            <span class="cert-kicker">Digital product passport</span>
            <span class="cert-no">No. ${pad(id)}</span>
          </div>
          <div class="cert-main">
            <div class="cert-photo">${art(item)}</div>
            <div class="cert-info">
              <h2>${esc(item.name)}</h2>
              <p class="cert-brand">${esc(item.brand || "No brand")}</p>
              ${item.details ? `<p class="cert-details">${esc(item.details)}</p>` : ""}
              <dl class="cert-grid">
                <div><dt>Issued</dt><dd>${f.created ? fmtDate(f.created) : "—"}</dd></div>
                <div><dt>Owners so far</dt><dd>${f.owners}</dd></div>
                <div><dt>Current owner</dt><dd>${esc(nameOf(item.owner))}</dd></div>
                <div><dt>Owner's record</dt><dd>${esc(recText(item.owner))}</dd></div>
                <div><dt>Last sale</dt><dd>${f.lastSale ? `${usd(f.lastSale.price)} · ${fmtDate(f.lastSale.at)}` : "Never sold"}</dd></div>
                <div><dt>Status</dt><dd>${esc(statusText(item))}</dd></div>
              </dl>
            </div>
          </div>
          <div class="cert-auth">${authLine(item)}</div>
          <div class="cert-bottom">
            <div class="cert-qr">${qrSvg(url)}<small>Scan to verify</small></div>
            <div class="cert-seal">
              <strong>✓ Recorded on ${esc(CFG.chainName)}</strong>
              <p>This passport lives in a smart contract. Its details can't be edited, and the owner changes only when a sale is settled.</p>
              ${photoHash(item.imageUrl) ? `<p class="fingerprint">Photo fingerprint (SHA-256): <span class="mono-inline">${photoHash(item.imageUrl).slice(0, 16)}…${photoHash(item.imageUrl).slice(-8)}</span></p>` : ""}
              <div class="row">
                <button class="btn ghost small" data-action="copy-link" data-id="${id}">Copy link</button>
                <a class="btn ghost small" href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">See the contract on Arc ↗</a>
              </div>
            </div>
          </div>
        </article>
        <div class="h-label">History</div>
        <ul class="timeline">${timelineHtml(item)}</ul>
        ${item.status === STATUS.LISTED ? `
          <div class="callout info pp-cta">
            <span>This piece is for sale for <strong>${usd(item.price)}</strong>, protected by ${esc(nameOf(item.partner))}.</span>
            <button class="btn gold" data-action="public-buy" data-id="${id}">Buy it in the app</button>
          </div>` : ""}
      </div>`;
  }

  function route() {
    document.querySelectorAll("#toast-root .toast:not(.pending)").forEach((t) => t.remove());
    const m = /^#passport=(\d+)$/.exec(location.hash);
    state.publicId = m ? Number(m[1]) : null;
    closeModal();
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  function leavePublic() {
    history.pushState("", document.title, location.pathname + location.search);
    route();
  }

  // ------------------------------------------------------------ item detail
  function openDetail(id) {
    const item = itemById(id);
    if (!item) return;
    const f = facts(item);
    openModal("Item passport", `
      ${art(item)}
      <h4 class="detail-title">${esc(item.name)}</h4>
      <p class="detail-brand">${esc(item.brand || "No brand")}${item.details ? ` · ${esc(item.details)}` : ""}</p>
      <div class="detail-links">
        <a class="verified" href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">✓ Passport #${item.id}, recorded on Arc ↗</a>
        <button class="btn ghost small" data-action="share" data-id="${item.id}">Share passport</button>
      </div>
      ${authLine(item)}
      <div class="facts">
        <div class="fact"><small>Current owner</small><strong>${esc(nameOf(item.owner))}</strong></div>
        <div class="fact"><small>Owner's record</small><strong>${esc(recText(item.owner))}</strong></div>
        <div class="fact"><small>Status</small><strong data-status></strong></div>
        <div class="fact"><small>Last sale</small><strong>${f.lastSale ? usd(f.lastSale.price) : "Never sold"}</strong></div>
      </div>
      <div data-actions></div>
      <div class="h-label">History</div>
      <ul class="timeline">${timelineHtml(item)}</ul>
    `);
    state.openItemId = id;
    refreshDetailActions();
  }

  function partnerSelect(id) {
    const list = activePartners().filter((p) => !same(p.addr, myAddr()));
    if (!list.length) return "";
    return `<select id="${id}" class="select">${list.map((p) => `<option value="${esc(p.addr)}">${esc(p.name)} · ${esc(p.city)}</option>`).join("")}</select>`;
  }
  function depositHint(priceStr) {
    const price = parseFloat(priceStr);
    if (!(price > 0)) return `You lock a 10% deposit while it's listed. It comes back when the sale completes or you take it off sale. The authenticator earns 3% of the sale.`;
    const w = toWei(price.toFixed(2));
    return `You lock a ${usd(depositOf(w))} deposit now and get it back when the sale completes. On a sale you receive ${usd(w - feeOf(w))}; the authenticator earns ${usd(feeOf(w))}.`;
  }

  function refreshDetailActions() {
    const box = $("[data-actions]");
    const statusEl = $("[data-status]");
    const item = itemById(state.openItemId);
    if (!box || !item) return;
    const isOwner = same(item.owner, myAddr());
    const isBuyer = same(item.buyer, myAddr());
    const dis = state.busy ? "disabled" : "";
    statusEl.textContent = statusText(item);

    let html = "";
    if (is("auth")) {
      const r = reqOf(item.id);
      if (r && r.status === "pending" && same(r.partner, myAddr()) && !isOwner && partnerOf(myAddr())) {
        html = `<div class="actions-col"><button class="btn gold block" data-action="auth" data-id="${item.id}" ${dis}>Authenticate this piece</button>
          <button class="btn ghost block" data-action="decline" data-id="${item.id}" ${dis}>Can't verify</button></div>`;
      }
    } else if (is("seller") && isOwner && item.status === STATUS.OWNED) {
      const st = authStage(item);
      if (st === "verified") {
        html = `
        <div class="field">
          <label for="list-price">Sell this piece</label>
          <div class="row">
            <div class="money-input"><span>$</span><input id="list-price" type="number" min="0.01" step="0.01" placeholder="Price, e.g. 8"></div>
            <button class="btn gold" data-action="list" data-id="${item.id}" ${dis}>List for sale</button>
          </div>
          <span class="hint">${esc(nameOf(item.authBy))} authenticated this piece and stands behind the sale.</span>
          <span class="hint" data-deposit-hint>${depositHint("")}</span>
        </div>`;
      } else if (st === "pending") {
        html = `
        <div class="callout held"><strong>Waiting for ${esc(nameOf(reqOf(item.id).partner))}.</strong><br>Take the piece to the shop. Once they've checked it and stamped its passport, you can list it.</div>
        <button class="btn ghost block" data-action="cancel-auth" data-id="${item.id}" ${dis}>Cancel the request</button>`;
      } else {
        const sel = partnerSelect("auth-partner");
        const r = reqOf(item.id);
        html = (st === "declined" ? `<div class="callout bad"><strong>${esc(nameOf(r.partner))} couldn't verify this piece.</strong>${r.note ? `<br>“${esc(r.note)}”` : ""}</div>` : "") + (sel ? `
        <div class="field">
          <label for="auth-partner">Step 1: get it authenticated</label>
          ${sel}
          <span class="hint">The authenticator checks the piece in person and stamps its passport. After that you can list it, and they settle any dispute on the sale.</span>
        </div>
        <button class="btn gold block" data-action="request-auth" data-id="${item.id}" ${dis}>Request authentication</button>`
          : `<div class="callout info">No authenticator is approved yet, so pieces can't be verified or listed.</div>`);
      }
    } else if (isOwner && item.status === STATUS.LISTED) {
      html = `
        <div class="callout info">Listed for <strong>${usd(item.price)}</strong>, protected by ${esc(nameOf(item.partner))}. Your ${usd(item.deposit)} deposit is locked.</div>
        <button class="btn ghost block" data-action="unlist" data-id="${item.id}" ${dis}>Take it off sale and get the deposit back</button>`;
    } else if ((isOwner || isBuyer) && IN_SALE.includes(item.status)) {
      const b = saleBlock(item);
      html = `<div class="callout ${b.bad ? "bad" : "held"}"><strong>${b.chip}</strong><br>${b.note}</div><div class="actions-col">${b.actions.replace(/class="btn /g, 'class="btn block ')}</div>`;
    } else if (is("buyer") && item.status === STATUS.LISTED) {
      html = `<button class="btn gold block" data-action="buy" data-id="${item.id}" ${dis}>Buy for ${usd(item.price)}</button>`;
    } else if (is("buyer") && isOwner) {
      html = `<div class="callout ok">This piece is yours. Its passport now names you as the owner.</div>`;
    } else if (IN_SALE.includes(item.status)) {
      html = `<div class="callout info">Someone has already paid for this piece.</div>`;
    }
    if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
  }

  document.addEventListener("input", (ev) => {
    if (ev.target.id === "list-price") {
      const hint = document.querySelector("[data-deposit-hint]");
      if (hint) hint.textContent = depositHint(ev.target.value);
    }
  });

  // ------------------------------------------------------------ photos
  // Crops to 4:3 and shrinks the photo before upload.
  async function compressPhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("unreadable"));
        i.src = url;
      });
      const W = img.naturalWidth, H = img.naturalHeight;
      let sw = W, sh = Math.round(W * 3 / 4);
      if (sh > H) { sh = H; sw = Math.round(H * 4 / 3); }
      const sx = Math.round((W - sw) / 2), sy = Math.round((H - sh) / 2);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      for (const [w, q] of [[1000, 0.82], [800, 0.78], [640, 0.72], [480, 0.66]]) {
        canvas.width = w;
        canvas.height = Math.round(w * 3 / 4);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        if (w > sw) { canvas.width = sw; canvas.height = sh; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, sw, sh); ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh); }
        const data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= MAX_PHOTO_CHARS) return data;
      }
      throw new Error("too detailed");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // -------------------------------------------------------------- add item
  function openAddItem() {
    const picks = Object.entries(ICONS).map(([k, v], idx) => `
      <div><input type="radio" name="kind" id="kind-${k}" value="${k}" ${idx === 0 ? "checked" : ""}>
      <label for="kind-${k}"><svg viewBox="0 0 64 64">${v.svg}</svg>${v.label}</label></div>`).join("");
    const samples = SAMPLES.map((s, i) => `<button type="button" class="sample" data-sample="${i}">${esc(s.name)}</button>`).join("");
    const sel = partnerSelect("f-partner");
    let photoData = "";
    openModal("Add a piece", `
      <form id="add-form" novalidate>
        <div class="samples"><span>Quick fill:</span>${samples}</div>
        <div class="field"><label for="f-name">What is it?</label><input id="f-name" type="text" maxlength="60" placeholder="e.g. Navy wool blazer" required></div>
        <div class="row">
          <div class="field"><label for="f-brand">Brand</label><input id="f-brand" type="text" maxlength="40" placeholder="e.g. Hugo Boss"></div>
          <div class="field"><label for="f-details">Details</label><input id="f-details" type="text" maxlength="80" placeholder="Size, condition, serial no."></div>
        </div>
        <div class="field">
          <label>Photo</label>
          <div class="photo-pick">
            <div class="photo-prev" id="f-prev"><span>No photo</span></div>
            <div>
              <label class="btn ghost small" for="f-photo">Take or choose a photo</label>
              <input id="f-photo" type="file" accept="image/*" hidden>
              <button type="button" class="linkish" id="f-photo-clear" hidden>Remove photo</button>
              <p class="hint" id="f-photo-hint">Every future buyer sees this photo. Its fingerprint goes into the passport on Arc.</p>
            </div>
          </div>
        </div>
        <div class="field" id="f-kind-wrap"><label>Or pick an icon</label><div class="icon-pick">${picks}</div></div>
        ${sel ? `
        <label class="check"><input id="f-sell" type="checkbox" checked> Ask an authenticator to verify it now</label>
        <div class="field" id="f-price-wrap">
          <label for="f-partner" class="sub-label">Authenticator</label>
          ${sel}
          <span class="hint">They check the piece in person. Once it's stamped, you can list it for sale.</span>
        </div>` : ""}
        <p class="hint" id="f-error" style="color:var(--err);min-height:1em;margin:0 0 8px"></p>
        <button class="btn primary block" type="submit" ${state.busy ? "disabled" : ""}>Create passport</button>
      </form>`, (m) => {
      const sell = $("#f-sell", m);
      const err = $("#f-error", m);
      if (sell) sell.addEventListener("change", () => ($("#f-price-wrap", m).hidden = !sell.checked));
      $("#f-name", m).focus();

      m.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", () => {
        const s = SAMPLES[Number(b.dataset.sample)];
        $("#f-name", m).value = s.name;
        $("#f-brand", m).value = s.brand;
        $("#f-details", m).value = s.details;
        const r = $(`#kind-${s.kind}`, m); if (r) r.checked = true;
      }));

      const setPhoto = (data) => {
        photoData = data;
        $("#f-prev", m).innerHTML = data ? `<img src="${data}" alt="Photo preview">` : "<span>No photo</span>";
        $("#f-photo-clear", m).hidden = !data;
        $("#f-kind-wrap", m).hidden = !!data;
        $("#f-photo-hint", m).textContent = data
          ? "The photo's fingerprint is written into the passport on Arc, so anyone can check it hasn't been swapped."
          : "Every future buyer sees this photo. Its fingerprint goes into the passport on Arc.";
      };
      $("#f-photo", m).addEventListener("change", async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        err.textContent = "";
        try { setPhoto(await compressPhoto(file)); }
        catch (_) { setPhoto(""); err.textContent = "Couldn't use that photo. Try a JPG or PNG."; }
        ev.target.value = "";
      });
      $("#f-photo-clear", m).addEventListener("click", () => setPhoto(""));

      $("#add-form", m).addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const name = $("#f-name", m).value.trim();
        const brand = $("#f-brand", m).value.trim();
        const details = $("#f-details", m).value.trim();
        const kind = m.querySelector('input[name="kind"]:checked')?.value || "other";
        const asking = !!(sell && sell.checked);
        const partner = asking ? $("#f-partner", m).value : null;
        if (!name) { err.textContent = "Please give the piece a name."; return; }
        const need = toWei("0.02");
        if (!(await hasMoney(need))) { err.textContent = `You need a few cents for the network fee. Tap “Add money”.`; return; }
        closeModal();
        const rc = await runTx({
          pending: `Creating the passport for “${name}”…`,
          done: `“${name}” now has its passport.`,
          send: (c) => c.createPassport(name, brand, details, photoData || null, kind),
        });
        if (rc && asking && rc.id) {
          const id = rc.id;
          await runTx({
            pending: `Asking ${nameOf(partner)} to authenticate “${name}”…`,
            done: `Request sent. ${nameOf(partner)} will check “${name}” in person.`,
            send: (c) => c.requestAuth(id, partner),
          });
        }
      });
    });
  }

  // ------------------------------------------------------------------- buy
  function openBuy(id) {
    const item = itemById(id);
    if (!item) return;
    const bal = state.balances[state.current] ?? 0n;
    const enough = bal >= item.price + toWei("0.01");
    openModal("Buy this piece", `
      ${art(item)}
      <h4 class="detail-title">${esc(item.name)}</h4>
      <p class="detail-brand">${esc(item.brand)} · sold by ${esc(nameOf(item.owner))} (${esc(recText(item.owner))})</p>
      ${authLine(item)}
      <div class="callout held">
        <strong>${usd(item.price)} is held, not sent to the seller.</strong>
        <ul class="plain">
          <li>${esc(nameOf(item.owner))} has locked a ${usd(item.deposit)} deposit and must ship within ${SHIP_DAYS} days.</li>
          <li>After it ships, you have ${CONFIRM_DAYS} days to confirm or open a dispute.</li>
          <li>${esc(nameOf(item.partner))} settles any dispute.</li>
        </ul>
      </div>
      <div class="facts">
        <div class="fact"><small>Price</small><strong>${usd(item.price)}</strong></div>
        <div class="fact"><small>Your balance</small><strong>${usd(bal)}</strong></div>
      </div>
      ${enough
        ? `<button class="btn gold block" data-action="pay" data-id="${item.id}" ${state.busy ? "disabled" : ""}>Pay ${usd(item.price)}</button>`
        : `<div class="callout info">You need ${usd(item.price)} plus a cent for the network fee.</div><button class="btn primary block" data-action="add-money">Add money</button>`}
    `);
  }

  // ------------------------------------------------------- dispute / authenticate
  function openDispute(id) {
    const item = itemById(id);
    if (!item) return;
    const reasons = ["It never arrived", "It's not as described", "I don't think it's genuine"];
    openModal("Something's wrong", `
      <p style="margin-top:0">Your ${usd(item.price)} stays held. <strong>${esc(nameOf(item.partner))}</strong> will review and decide. If they agree with you, you get your money back plus most of the seller's deposit.</p>
      <div class="field">
        <label>What happened?</label>
        ${reasons.map((r, i) => `<label class="radio"><input type="radio" name="reason" value="${esc(r)}" ${i === 1 ? "checked" : ""}> ${esc(r)}</label>`).join("")}
      </div>
      <div class="field"><label for="d-note">Details (optional)</label><input id="d-note" type="text" maxlength="100" placeholder="e.g. Strap is a replacement"></div>
      <button class="btn primary block" data-action="dispute-send" data-id="${id}">Open dispute</button>
    `);
  }

  function openAuth(id) {
    const item = itemById(id);
    if (!item) return;
    openModal("Authenticate this piece", `
      ${art(item)}
      <h4 class="detail-title">${esc(item.name)}</h4>
      <p class="detail-brand">${esc(item.brand || "No brand")}${item.details ? ` · ${esc(item.details)}` : ""} · owner ${esc(nameOf(item.owner))}</p>
      <p>Only stamp a piece you have inspected in person. Your shop's name goes on its passport for every future buyer to see.</p>
      <div class="field"><label for="a-note">What you checked</label><input id="a-note" type="text" maxlength="120" value="Inspected in store: brand marks, serial and condition match."></div>
      <button class="btn gold block" data-action="auth-send" data-id="${id}">Stamp passport as authenticated</button>
    `);
  }

  function openDecline(id) {
    const item = itemById(id);
    if (!item) return;
    openModal("Can't verify this piece", `
      <p style="margin-top:0">Tell ${esc(nameOf(item.owner))} why. The piece stays unlisted, and nothing is written to its passport.</p>
      <div class="field"><label for="x-note">Reason</label><input id="x-note" type="text" maxlength="120" value="Could not confirm it is genuine."></div>
      <button class="btn primary block" data-action="decline-send" data-id="${id}">Send to the owner</button>
    `);
  }

  // ------------------------------------------------------------ how it works
  function openHow() {
    openModal("How it works on Arc", `
      <ol class="how-list">
        <li><strong>Every piece gets a passport.</strong> Its name, brand, details, photo, owner and history are stored in a smart contract on Arc. The details can't be edited after the passport is issued.</li>
        <li><strong>Authentication comes first.</strong> The seller asks an approved local authenticator, such as a pawn shop, to check the piece in person. The authenticator stamps its passport. A piece can't be listed until then.</li>
        <li><strong>Payment is held, not sent.</strong> The buyer's dollars go into the contract. The seller also locks a 10% deposit when listing.</li>
        <li><strong>Ship, then confirm or dispute.</strong> The seller marks it shipped. The buyer has ${CONFIRM_DAYS} days to confirm or open a dispute. If the buyer says nothing, the seller can collect.</li>
        <li><strong>The same authenticator settles disputes.</strong> They vouched for the piece, so they decide. If the seller loses, the buyer is refunded and the seller loses the deposit. Authenticators earn 3% of each sale they stand behind.</li>
        <li><strong>Track records can't be faked.</strong> The contract counts each person's sales, refunds and disputes.</li>
        <li><strong>Why Arc.</strong> USDC (digital dollars) is the native currency, so there's no separate token to buy for fees. Most actions cost about a cent or less.</li>
      </ol>
      <div class="row" style="margin-top:6px">
        <a class="btn ghost" href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">See the contract on Arc ↗</a>
        <button class="btn primary" data-close>Got it</button>
      </div>
    `);
  }

  // ------------------------------------------------------------- add money
  function openAddMoney() {
    const w = me();
    const hasMM = !!window.ethereum;
    openModal(`Add test dollars for ${cur().name}`, `
      <p style="margin-top:0">This demo runs on Arc's test network, so the dollars are free test USDC. In a real launch, people would add money with a card or bank transfer.</p>
      <div class="facts">
        <div class="fact"><small>${esc(cur().name)}'s balance</small><strong>${usd(state.balances[state.current])}</strong></div>
        <div class="fact"><small>Network fee per action</small><strong>under $0.01</strong></div>
      </div>
      <div class="h-label">Fastest: from the demo treasury</div>
      <div class="row">
        <button class="btn gold" data-action="fund" data-amount="1">Get $1</button>
        <button class="btn gold" data-action="fund" data-amount="5">Get $5</button>
        <button class="btn gold" data-action="fund" data-amount="10">Get $10</button>
      </div>
      <p class="hint" style="margin:6px 0 0">The demo treasury holds ${usd(state.treasury?.balance ?? 0n)}. To refill it, send faucet USDC to <span class="mono-inline">${esc(state.treasury?.address ?? "")}</span>.</p>
      ${hasMM ? `
        <div class="h-label">Or send from your MetaMask</div>
        <div class="row">
          <button class="btn gold" data-action="topup" data-amount="1">Send $1</button>
          <button class="btn gold" data-action="topup" data-amount="5">Send $5</button>
          <button class="btn gold" data-action="topup" data-amount="10">Send $10</button>
        </div>` : ""}
      <div class="h-label">Or use Circle's free faucet</div>
      <p style="margin:0 0 8px;font-size:14px">Pick <strong>Arc Testnet</strong> and <strong>USDC</strong>, then paste this account number:</p>
      <div class="mono" id="addr">${esc(w.address)}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn ghost" data-action="copy-addr">Copy account number</button>
        <a class="btn ghost" href="${CFG.faucet}" target="_blank" rel="noopener">Open faucet ↗</a>
      </div>
    `);
  }

  // MetaMask is used only for demo setup: topping up demo people and approving the partner.
  async function metamaskSigner() {
    const eth = window.ethereum;
    if (!eth) throw Object.assign(new Error("no metamask"), { code: "NO_MM" });
    await eth.request({ method: "eth_requestAccounts" });
    const hex = "0x" + CFG.chainId.toString(16);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e?.code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hex, chainName: CFG.chainName, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [CFG.rpcUrls[0]], blockExplorerUrls: [CFG.explorer] }],
        });
      } else throw e;
    }
    return new ethers.BrowserProvider(eth).getSigner();
  }
  const mmCancelled = (e) => e?.code === 4001 || e?.code === "ACTION_REJECTED";

  async function topUp(amount) {
    const to = myAddr();
    const who = cur().name;
    const t = toast(`Sending $${amount} from MetaMask to ${who}…`, "pending");
    try {
      const signer = await metamaskSigner();
      const tx = await signer.sendTransaction({ to, value: toWei(amount) });
      const rc = await tx.wait();
      updateToast(t, `${who} received $${amount}.`, "ok", rc.hash);
      closeModal();
      await refresh();
    } catch (e) {
      console.error(e);
      updateToast(t, mmCancelled(e) ? "Cancelled in MetaMask." : "Couldn't send from MetaMask. Is it on Arc Testnet with some USDC?", "error");
    }
  }

  async function fundFromTreasury(dollars) {
    const who = cur().name;
    const t = toast(`Sending $${dollars} from the demo treasury to ${who}…`, "pending");
    try {
      const r = await api("/api/fund", { as: state.current, dollars });
      updateToast(t, `${who} received $${dollars}.`, "ok", r.hash);
      closeModal();
      await refresh();
    } catch (e) {
      console.error(e);
      updateToast(t, friendlyError(e), "error");
    }
  }

  async function approvePartner() {
    const shop = person("shop");
    const t = toast(`Approving “${shop.regName}” as a partner. Confirm in MetaMask…`, "pending");
    try {
      const signer = await metamaskSigner();
      const tx = await new ethers.Contract(CFG.contractAddress, ABI, signer).addPartner(shopAddr(), shop.regName, shop.city);
      const rc = await tx.wait();
      updateToast(t, `“${shop.regName}” is now an approved partner.`, "ok", rc.hash);
      await refresh();
    } catch (e) {
      console.error(e);
      const msg = e?.code === "NO_MM" ? "Open the app in Chrome with MetaMask to approve the partner."
        : mmCancelled(e) ? "Cancelled in MetaMask."
        : "Couldn't approve. Use the MetaMask account that deployed the contract.";
      updateToast(t, msg, "error");
    }
  }

  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch (_) { toast("Couldn't copy. Select it and copy it by hand.", "error"); }
  }

  const clearToasts = () => document.querySelectorAll("#toast-root .toast:not(.pending)").forEach((t) => t.remove());
  const goTab = (tab) => { state.tab = tab; if (state.role) lsSet(LS.tab + state.role, tab); render(); };

  // ---------------------------------------------------------------- events
  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-role],[data-tab],[data-tab-go],[data-open],[data-action]");
    if (!el) return;

    if (el.dataset.role) {
      clearToasts();
      setRole(el.dataset.role);
      closeModal();
      render();
      window.scrollTo(0, 0);
      return;
    }
    if (el.dataset.tab || el.dataset.tabGo) {
      closeModal();
      goTab(el.dataset.tab || el.dataset.tabGo);
      return;
    }
    if (el.dataset.open) { openDetail(Number(el.dataset.open)); return; }

    const id = Number(el.dataset.id);
    const item = itemById(id);
    switch (el.dataset.action) {
      case "sign-out": clearToasts(); setRole(null); closeModal(); render(); window.scrollTo(0, 0); break;
      case "add-item": openAddItem(); break;
      case "how": openHow(); break;
      case "add-money": openAddMoney(); break;
      case "approve-partner": approvePartner(); break;
      case "copy-addr": copy(myAddr(), "Account number copied."); break;
      case "copy-link": copy(passportUrl(id), "Passport link copied."); break;
      case "share": closeModal(); location.hash = `passport=${id}`; break;
      case "leave-public": leavePublic(); break;
      case "public-buy":
        leavePublic();
        setRole("buyer");
        goTab("shop");
        if (item && !same(item.owner, myAddr())) openBuy(id);
        break;
      case "topup": topUp(el.dataset.amount); break;
      case "fund": fundFromTreasury(Number(el.dataset.amount)); break;
      case "buy": openBuy(id); break;
      case "pay":
        closeModal();
        if (await runTx({
          pending: `Paying ${usd(item.price)}. The money will be held…`,
          done: `Paid! ${usd(item.price)} is held until you confirm “${item.name}” arrived.`,
          send: (c) => c.buy(id),
        })) goTab("orders");
        break;
      case "list": {
        const price = parseFloat($("#list-price")?.value);
        if (!(price > 0)) { toast("Please enter a price above $0.", "error"); return; }
        const w = toWei(price.toFixed(2));
        if (!(await hasMoney(depositOf(w) + toWei("0.01")))) { toast(`You need ${usd(depositOf(w))} for the deposit. Tap “Add money”.`, "error"); return; }
        await runTx({
          pending: `Listing “${item.name}” for ${usd(w)} and locking your ${usd(depositOf(w))} deposit…`,
          done: `“${item.name}” is now for sale.`,
          send: (c) => c.listForSale(id, w),
        });
        break;
      }
      case "unlist":
        await runTx({ pending: "Taking it off sale…", done: `“${item.name}” is back in your wardrobe and your deposit is returned.`, send: (c) => c.cancelListing(id) });
        break;
      case "ship":
        closeModal();
        await runTx({ pending: "Marking it as shipped…", done: `Marked as shipped. ${nameOf(item.buyer)} has ${CONFIRM_DAYS} days to confirm or dispute.`, send: (c) => c.markShipped(id) });
        break;
      case "confirm":
        closeModal();
        if (await runTx({
          pending: `Releasing the payment to ${nameOf(item.owner)} and moving the passport to you…`,
          done: `Done! ${nameOf(item.owner)} was paid, and “${item.name}” is now in your wardrobe.`,
          send: (c) => c.confirmDelivery(id),
        })) goTab("mine");
        break;
      case "claim":
        closeModal();
        await runTx({ pending: "Collecting the payment…", done: `You've been paid for “${item.name}”.`, send: (c) => c.sellerClaim(id) });
        break;
      case "seller-cancel":
        closeModal();
        await runTx({ pending: "Refunding the buyer…", done: "The buyer got their money back. The piece is listed again.", send: (c) => c.sellerCancelSale(id) });
        break;
      case "buyer-cancel":
        closeModal();
        await runTx({ pending: "Cancelling and refunding you…", done: "Your money is back, plus the seller's deposit.", send: (c) => c.buyerCancelUnshipped(id) });
        break;
      case "dispute": openDispute(id); break;
      case "dispute-send": {
        const reason = document.querySelector('input[name="reason"]:checked')?.value || "Something's wrong";
        const note = $("#d-note")?.value.trim();
        const partnerName = nameOf(item.partner);
        closeModal();
        await runTx({
          pending: "Opening the dispute…",
          done: `Dispute opened. ${partnerName} will decide. Your money stays held.`,
          send: (c) => c.openDispute(id, note ? `${reason}: ${note}` : reason),
        });
        break;
      }
      case "request-auth": {
        const partner = $("#auth-partner")?.value;
        if (!partner) return;
        await runTx({
          pending: `Asking ${nameOf(partner)} to authenticate “${item.name}”…`,
          done: `Request sent. ${nameOf(partner)} will check “${item.name}” in person.`,
          send: (c) => c.requestAuth(id, partner),
        });
        break;
      }
      case "cancel-auth":
        await runTx({ pending: "Cancelling the request…", done: "Request cancelled.", send: (c) => c.cancelAuthRequest(id) });
        break;
      case "decline": openDecline(id); break;
      case "decline-send": {
        const reason = $("#x-note")?.value.trim() || "Could not be verified.";
        closeModal();
        await runTx({ pending: "Letting the owner know…", done: `${nameOf(item.owner)} has been told “${item.name}” couldn't be verified.`, send: (c) => c.declineAuth(id, reason) });
        break;
      }
      case "auth": openAuth(id); break;
      case "auth-send": {
        const note = $("#a-note")?.value.trim() || "Inspected in store.";
        closeModal();
        await runTx({ pending: `Stamping the passport of “${item.name}”…`, done: `“${item.name}” is now authenticated by your shop. ${nameOf(item.owner)} can list it.`, send: (c) => c.authenticate(id, note) });
        break;
      }
      case "resolve": {
        const buyerWins = el.dataset.win === "buyer";
        closeModal();
        await runTx({
          pending: buyerWins ? `Refunding ${nameOf(item.buyer)}…` : `Releasing the payment to ${nameOf(item.owner)}…`,
          done: buyerWins
            ? `Settled for the buyer: ${nameOf(item.buyer)} is refunded and ${nameOf(item.owner)} loses the deposit. Your fee: ${usd(feeOf(item.price))}.`
            : `Settled for the seller: ${nameOf(item.owner)} is paid and the passport moves to ${nameOf(item.buyer)}. Your fee: ${usd(feeOf(item.price))}.`,
          send: (c) => c.resolveDispute(id, buyerWins),
        });
        break;
      }
    }
  });

  // ------------------------------------------------------------------ start
  async function start() {
    const m = /^#passport=(\d+)$/.exec(location.hash);
    state.publicId = m ? Number(m[1]) : null;
    render();
    try {
      await connect();
      loadSession();
      await refresh();
      setInterval(() => { if (!state.busy && !document.hidden) refresh(); }, CFG.refreshMs);
    } catch (e) {
      state.fatal = e.message || String(e);
      render();
    }
  }

  // Small hook for automated tests and debugging (no secrets exposed).
  window.WP = { state, refresh, setRole: (r) => { setRole(r); render(); }, addresses: () => Object.fromEntries(PERSONAS.map((p) => [p.id, state.wallets[p.id]?.address])) };

  start();
})();
