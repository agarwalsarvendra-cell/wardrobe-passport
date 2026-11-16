/* Wardrobe Passport — screens (client)
 *
 * How it fits together:
 * - This file draws the screens. It holds no keys and talks to no blockchain
 *   node. It calls the app's own API (Next.js routes on Vercel):
 *     GET  /api/session  who is signed in, the member directory, chain info
 *     GET  /api/state    items, members, disputes and records read from Arc, plus the ledger
 *     POST /api/auth     join with an invite, email code, demo accounts, admin (MetaMask)
 *     POST /api/tx       every action, signed by the member's managed wallet
 *     POST /api/invites  create an invite link
 *     POST /api/fund     demo money from the platform treasury
 *     POST /api/admin    admin setup (demo accounts, seeded community)
 * - The contract (WardrobePassportV3 on Arc) holds the money and the rules:
 *   only invited members trade, only members whose ID an authenticator checked
 *   can sell, and disputes are decided by a panel of members.
 * - WardrobeProtection (when PROTECTION_ADDRESS is set) adds bonded
 *   authentication and 90-day protection priced from the records.
 * - One membership, separate views: Sell, Buy, Community, Shop desk (pawn
 *   shops) and Admin. The admin can view the app as any member, read-only.
 * - #passport=<id> is a public, read-only passport page. #invite=<code> joins.
 */
(() => {
  "use strict";

  const CFG = window.WP_CONFIG;
  const ABI = window.WP_ABI;
  const { ethers } = window;

  const STATUS = { OWNED: 0, LISTED: 1, PAID: 2, SHIPPED: 3, DISPUTED: 4 };
  const IN_SALE = [STATUS.PAID, STATUS.SHIPPED, STATUS.DISPUTED];
  const VIEWS = {
    sell: { label: "Sell", tabs: [["home", "Dashboard"], ["pieces", "My pieces"], ["sales", "Sales"]] },
    buy: { label: "Buy", tabs: [["shop", "Marketplace"], ["orders", "My orders"], ["mine", "My purchases"]] },
    desk: { label: "Shop desk", tabs: [["front", "Front desk"], ["requests", "To verify"], ["opinions", "Second opinions", "p"], ["bond", "Bond", "p"], ["sdisputes", "Disputes"], ["record", "Record"]] },
    community: { label: "Community", tabs: [["ledger", "Ledger"], ["feed", "Chain feed", "s"], ["people", "Members"], ["protection", "Protection", "p"], ["disputes", "Disputes"], ["invite", "Invites & credits"]] },
    admin: { label: "Admin", tabs: [["overview", "Overview"], ["side", "Side by side"], ["members", "Members"], ["specialists", "Specialists"], ["setup", "Setup"]] },
  };
  // Tabs marked "p" exist only when the protection contract is set.
  // Tabs marked "s" appear once the QuickNode Streams feed has delivered events.
  const tabsOf = (v) => VIEWS[v].tabs.filter((t) => (t[2] !== "p" || !!state.protection) && (t[2] !== "s" || !!state.streamStatus));
  const LS = { view: "wp.view", tab: "wp.tab." };
  const SHIP_DAYS = 5;
  const CONFIRM_DAYS = 7;
  const DEPOSIT_BPS = 1000n;
  const BOND_BPS = 500n;
  const FEE_BPS = 300n;
  const PANEL_FEE_BPS = 200n;
  const MIN_PANEL = 3;
  const QUORUM = 3;
  const NEW_MEMBER_CAP = 50n * 10n ** 18n;
  const MAX_PHOTO_CHARS = 350000;

  const state = {
    me: null, isAdmin: false, adminAddress: null, directory: [], demo: [], seeded: [],
    viewAs: null, view: null, tab: null,
    admin: null, items: [], histories: {}, partners: [], members: {}, disputes: [], records: {},
    balances: {}, authRequests: {}, flags: {}, ledger: [], protection: null, categories: {}, streamed: {}, streamStatus: null, chainFeed: [],
    loaded: false, online: true, busy: false, fatal: null,
    openItemId: null, publicId: null, inviteCode: null, invite: null,
    signin: { email: "", sent: false, demoCode: null },
    q: "", cat: "all",
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
  const pct = (w, bps) => (w * bps) / 10000n;
  const depositOf = (w) => pct(w, DEPOSIT_BPS);
  const bondOf = (w) => pct(w, BOND_BPS);
  const feeOf = (w) => pct(w, FEE_BPS);
  const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const fmtWhen = (ts) => new Date(Number(ts) * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const now = () => Date.now() / 1000;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const explorerAddr = (a) => `${CFG.explorer}/address/${a}`;
  const explorerTx = (h) => `${CFG.explorer}/tx/${h}`;
  const passportUrl = (id) => `${location.origin}${location.pathname}#passport=${id}`;
  const inviteUrl = (code) => `${location.origin}${location.pathname}#invite=${code}`;
  const pad = (id) => String(id).padStart(6, "0");
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const itemById = (id) => state.items.find((i) => i.id === id);

  // Who the screens are for: the signed-in member, or the member the admin is viewing as.
  const dirBy = (handle) => state.directory.find((u) => u.handle === handle) || null;
  const dirByAddr = (a) => state.directory.find((u) => same(u.address, a)) || null;
  const viewer = () => (state.isAdmin ? (state.viewAs ? dirBy(state.viewAs) : null) : state.me);
  const myAddr = () => viewer()?.address;
  const readOnly = () => state.isAdmin;
  const signedIn = () => !!state.me || state.isAdmin;

  const partnerOf = (addr) => state.partners.find((p) => same(p.addr, addr));
  const activePartners = () => state.partners.filter((p) => p.active);
  const memberOf = (addr) => state.members[(addr || "").toLowerCase()] || null;
  const isVerified = (addr) => { const m = memberOf(addr); return !!(m && m.active && m.verifiedBy); };
  const balanceOf = (addr) => BigInt(state.balances[(addr || "").toLowerCase()] ?? 0);
  const myBalance = () => balanceOf(myAddr());
  const reqOf = (id) => state.authRequests[id] || null;
  const flagsOf = (id) => state.flags[id] || { count: 0, mine: false, reasons: [] };
  const paused = (item) => flagsOf(item.id).count >= (CFG.rules?.flagsToPause ?? 3);
  const disputeOf = (item) => state.disputes.find((d) => d.id === item.disputeId) || null;
  const openDisputes = () => state.disputes.filter((d) => !d.resolved);

  // -------------------------------------------------------------- protection
  const prot = () => state.protection;
  const lc = (a) => (a || "").toLowerCase();
  const catName = (k) => (CFG.categories || []).find((c) => c.key === k)?.name || prot()?.categories?.find((c) => c.key === k)?.name || "";
  /** The category a piece was certified in (on-chain), or the one it was added under. */
  const catOf = (item) => prot()?.categoryOf?.[item.id] || state.categories[item.id] || null;
  const certified = (item) => !!prot()?.categoryOf?.[item.id];
  const specIn = (addr, cat) => prot()?.specialists?.[lc(addr)]?.[cat] || null;
  const specialtiesOf = (addr) => Object.keys(prot()?.specialists?.[lc(addr)] || {});
  const shopStatsOf = (addr) => prot()?.shops?.[lc(addr)] || null;
  const quoteOf = (item) => {
    const q = prot()?.quote?.[item.id];
    return q ? { ...q, fee: BigInt(q.fee) } : null;
  };
  const coversOf = (item) => (prot()?.covers || []).filter((c) => c.itemId === item.id);
  /** The cover on the current (or last) sale of a piece to this buyer. */
  const coverFor = (item, buyer) => coversOf(item).filter((c) => same(c.buyer, buyer)).sort((a, b) => b.id - a.id)[0] || null;
  const bondBacked = (item) => item.status === STATUS.LISTED && !!quoteOf(item)?.available;
  const COVER_DAYS = 90;
  const CLAIM_DEPOSIT_BPS = 500n;
  const pctTxt = (bps) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  const signedPct = (bps) => `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${pctTxt(Math.abs(bps))}`;
  const memberProt = (addr) => prot()?.members?.[lc(addr)] || null;

  function verified(item) {
    if (isZero(item.authBy)) return false;
    const h = state.histories[item.id] || [];
    return item.authAt >= (h.length ? h[h.length - 1].at : 0);
  }
  function authStage(item) {
    if (verified(item)) return "verified";
    const r = reqOf(item.id);
    if (r && same(r.owner, item.owner) && (r.status === "pending" || r.status === "declined")) return r.status;
    return "none";
  }

  function nameOf(addr) {
    if (isZero(addr)) return "—";
    const p = partnerOf(addr);
    if (p) return p.name;
    const u = dirByAddr(addr);
    if (u) return u.name;
    if (same(addr, state.admin)) return "Platform admin";
    return signedIn() ? `Member ${short(addr)}` : "A verified member";
  }
  const COLORS = ["#D1FAE5", "#E7E5E4", "#FEF3C7", "#E0E7FF", "#FCE7F3", "#CFFAFE", "#ECFCCB", "#F5F5F4"];
  const colorOf = (s) => COLORS[[...String(s || "")].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  const avatar = (name, key, cls = "avatar") => `<span class="${cls}" style="background:${colorOf(key || name)}">${esc((name || "?")[0])}</span>`;

  function levelOf(addr) {
    if (partnerOf(addr)) return { key: "partner", label: "Partner authenticator" };
    const m = memberOf(addr);
    if (!m) return { key: "none", label: "Not on-chain yet" };
    if (!m.active) return { key: "suspended", label: "Suspended" };
    return m.verifiedBy ? { key: "verified", label: "Verified member" } : { key: "member", label: "Member, ID not checked yet" };
  }

  function photoSrc(u) {
    const m = /^sha256:([0-9a-f]{64})/.exec(u || "");
    if (m) return `/api/photo/${m[1]}`;
    if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(u || "")) return u;
    return null;
  }
  const photoHash = (u) => (/^sha256:([0-9a-f]{64})/.exec(u || "") || [])[1] || null;

  const ZERO_REC = { sold: 0, bought: 0, refundsGiven: 0, disputesWon: 0, disputesLost: 0, votesCast: 0, votesWithMajority: 0, inviteesDisputesLost: 0 };
  const recOf = (addr) => state.records[(addr || "").toLowerCase()] || ZERO_REC;
  function recText(addr) {
    const r = recOf(addr);
    if (!r.sold && !r.bought && !r.refundsGiven && !r.disputesLost && !r.disputesWon) return "New here: no sales yet";
    return `${r.sold} sold · ${r.bought} bought · ${plural(r.refundsGiven, "refund", "refunds")} · ${plural(r.disputesLost, "dispute lost", "disputes lost")}`;
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
    ring: { label: "Jewelry", tint: "#f2ead8", svg: '<circle cx="32" cy="40" r="16"/><path d="M24 14h16l-8 10z"/><path d="M24 14l8 10 8-10"/>' },
    other: { label: "Other", tint: "#efe9df", svg: '<path d="M28 14c0-5 8-5 8 0 0 3-4 4-4 8"/><path d="M32 22 6 44h52z"/>' },
  };
  function iconKey(imageUrl) {
    const m = /(?:^icon:|;kind=)(\w+)$/.exec(imageUrl || "");
    return m && ICONS[m[1]] ? m[1] : "other";
  }
  function art(item, cls = "") {
    const src = photoSrc(item.imageUrl);
    if (src) return `<div class="art photo ${cls}"><img src="${esc(src)}" alt="${esc(item.name)}" loading="lazy"></div>`;
    const k = iconKey(item.imageUrl);
    const ic = ICONS[k];
    return `<div class="art illus ${cls}" data-kind="${k}"><svg viewBox="0 0 64 64" aria-hidden="true">${ic.svg}</svg></div>`;
  }

  const SAMPLES = [
    { name: "Steel dive watch", brand: "Seiko", details: "SKX007, box and papers", kind: "watch", category: "watches" },
    { name: "Constellation (1966)", brand: "Omega", details: "Pie-pan dial, calibre 561", kind: "watch", category: "vintage-watches" },
    { name: "Diamond stud earrings", brand: "Blue Nile", details: "0.5 ct total, with report", kind: "ring", category: "jewelry" },
    { name: "Gold signet ring", brand: "Mejuri", details: "14k, size 7", kind: "ring", category: "jewelry" },
  ];

  // ------------------------------------------------------------- API access
  async function api(path, body) {
    const res = await withTimeout(fetch(path, body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { cache: "no-store" }), 120000);
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !data) throw Object.assign(new Error(data?.error || "Something went wrong. Please try again."), { friendly: data?.error });
    return data;
  }

  async function connect() {
    const s = await api("/api/session");
    Object.assign(CFG, s.config);
    state.me = s.me;
    state.isAdmin = s.isAdmin;
    state.adminAddress = s.adminAddress;
    state.directory = s.directory || [];
    state.demo = s.demo || [];
    state.seeded = s.seeded || [];
    if (!state.isAdmin) state.viewAs = null;
    pickView(true);
  }

  // Which views this person can open.
  function viewsFor() {
    if (state.isAdmin && !state.viewAs) return ["admin", "community"];
    const v = viewer();
    if (!v) return [];
    const base = v.role === "partner" ? ["desk", "community"] : ["buy", "sell", "community"];
    return state.isAdmin ? [...base, "admin"] : base;
  }
  function pickView(restore = false) {
    const list = viewsFor();
    if (!list.length) { state.view = null; state.tab = null; return; }
    const saved = restore ? lsGet(LS.view) : null;
    if (!list.includes(state.view)) state.view = list.includes(saved) ? saved : list[0];
    const tabs = tabsOf(state.view);
    const savedTab = restore ? lsGet(LS.tab + state.view) : null;
    if (!tabs.some(([id]) => id === state.tab)) state.tab = tabs.some(([id]) => id === savedTab) ? savedTab : tabs[0][0];
  }
  function goView(v) {
    if (v === "admin" && state.viewAs) state.viewAs = null;
    state.view = v; state.tab = null; lsSet(LS.view, v);
    pickView(true);
    render();
  }
  const goTab = (tab) => {
    const owner = Object.keys(VIEWS).find((k) => tabsOf(k).some(([id]) => id === tab));
    if (owner && owner !== state.view && viewsFor().includes(owner)) state.view = owner;
    state.tab = tab; lsSet(LS.view, state.view); lsSet(LS.tab + state.view, tab); render();
  };

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq;
    try {
      const d = await api("/api/state");
      if (seq !== refreshSeq) return;
      state.admin = d.admin;
      state.items = d.items.map((i) => ({ ...i, price: BigInt(i.price), deposit: BigInt(i.deposit) }));
      state.histories = {};
      for (const [id, h] of Object.entries(d.histories)) state.histories[id] = h.map((t) => ({ ...t, price: BigInt(t.price) }));
      state.partners = d.partners;
      state.members = {};
      for (const m of d.members) state.members[m.addr.toLowerCase()] = m;
      state.disputes = d.disputes.map((x) => ({ ...x, bond: BigInt(x.bond) }));
      state.records = d.records;
      state.balances = d.balances || {};
      state.authRequests = d.authRequests || {};
      state.flags = d.flags || {};
      state.ledger = d.ledger || [];
      state.protection = d.protection || null;
      state.categories = d.categories || {};
      state.streamed = d.streamed || {};
      state.streamStatus = d.streamStatus || null;
      state.chainFeed = d.chainFeed || [];
      state.loaded = true;
      state.online = true;
    } catch (e) {
      console.warn("Refresh failed", e);
      if (seq !== refreshSeq) return;
      state.online = false;
    }
    render();
  }

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
    const members = Object.values(state.members);
    return { passports: state.items.length, sales, volume, held, authed, members: members.length, verified: members.filter((m) => m.verifiedBy).length, disputes: state.disputes.length, open: openDisputes().length };
  }

  // ---------------------------------------------------------- actions
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
    verifyMember: (member) => ({ action: "verifyMember", member }),
    vote: (did, buyerWins) => ({ action: "vote", did, buyerWins }),
    report: (did, report) => ({ action: "report", did, report }),
    finalize: (did) => ({ action: "finalize", did }),
    resolve: (did, buyerWins) => ({ action: "resolve", did, buyerWins }),
    flag: (id, reason) => ({ action: "flag", id, reason }),
    unflag: (id) => ({ action: "unflag", id }),
    clearFlags: (id) => ({ action: "clearFlags", id }),
    createPassportIn: (name, brand, details, photo, icon, category) => ({ action: "createPassport", name, brand, details, photo, icon, category }),
    buyCover: (id) => ({ action: "buyCover", id }),
    fileClaim: (cover, evidence) => ({ action: "fileClaim", cover, evidence }),
    decideClaim: (cover, fake, ruling) => ({ action: "decideClaim", cover, fake, ruling }),
    stakeBond: (amount) => ({ action: "stakeBond", amount }),
    withdrawBond: (amount) => ({ action: "withdrawBond", amount }),
    poolDeposit: (amount) => ({ action: "poolDeposit", amount }),
    poolWithdraw: (amount) => ({ action: "poolWithdraw", amount }),
  };

  const GENERIC = "Something went wrong. Please try again.";
  function friendlyError(e) {
    if (e?.friendly) return e.friendly;
    const msg = `${e?.shortMessage || ""} ${e?.message || ""}`.toLowerCase();
    if (msg.includes("timeout")) return "That took too long. Check the page before trying again.";
    return GENERIC;
  }

  async function runTx({ pending, done, send }) {
    if (readOnly()) { toast("The admin view is read-only. Sign in as the member to act.", "error"); return null; }
    if (state.busy) return null;
    state.busy = true;
    render();
    const t = toast(pending, "pending");
    try {
      const r = await api("/api/tx", send(ACTIONS));
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
  const hasMoney = (wei) => myBalance() >= wei;

  // ---------------------------------------------------------------- toasts
  function toast(text, kind = "ok", hash) {
    const root = $("#toast-root");
    const el = document.createElement("div");
    root.appendChild(el);
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
    root.querySelector(".backdrop").addEventListener("click", (ev) => { if (ev.target.hasAttribute("data-close")) closeModal(); });
    onMount && onMount(root.querySelector(".modal"));
  }
  function closeModal() { $("#modal-root").innerHTML = ""; state.openItemId = null; }
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });

  // ------------------------------------------------------------- rendering
  function chipFor(item) {
    const mineAsBuyer = same(item.buyer, myAddr());
    switch (item.status) {
      case STATUS.LISTED: return paused(item) ? `<span class="chip bad">Paused · flagged by members</span>` : `<span class="chip listed">For sale · ${usd(item.price)}</span>`;
      case STATUS.PAID: return mineAsBuyer ? `<span class="chip held">Paid · waiting for seller to ship</span>` : `<span class="chip held">Sold · ${usd(item.price)} held · ship it</span>`;
      case STATUS.SHIPPED: return mineAsBuyer ? `<span class="chip held">On its way · ${usd(item.price)} held</span>` : `<span class="chip held">Shipped · ${usd(item.price)} held</span>`;
      case STATUS.DISPUTED: return `<span class="chip bad">Dispute · panel voting</span>`;
      default: {
        if (state.view !== "sell" || !same(item.owner, myAddr())) return `<span class="chip owned">${same(item.owner, myAddr()) ? "Yours" : "Not for sale"}</span>`;
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
  // Listing card: big photo, title and price, brand, who checked it.
  function card(item, footer) {
    const shop = partnerOf(item.authBy);
    const sold = item.status === STATUS.OWNED && (state.histories[item.id] || []).some((t) => !isZero(t.from));
    const price = item.status === STATUS.LISTED ? usd(item.price) : sold ? `Sold ${usd(facts(item).lastSale.price)}` : "";
    return `
      <button class="lcard" data-open="${item.id}" aria-label="Open ${esc(item.name)}">
        <div class="lcard-img">${art(item)}
          ${bondBacked(item) ? `<span class="lbadge bond" title="${esc(nameOf(item.authBy))} has money staked behind this stamp">✓ Bond-backed</span>` : verified(item) ? `<span class="lbadge">✓ Verified</span>` : ""}
          ${item.status === STATUS.DISPUTED ? `<span class="lbadge warn">In dispute</span>` : sold ? `<span class="lbadge muted">Sold</span>` : ""}
        </div>
        <div class="lcard-row"><b>${esc(item.name)}</b>${price ? `<span>${price}</span>` : ""}</div>
        <div class="lcard-sub">${esc(item.brand || "No brand")}${item.details ? `, ${esc(item.details)}` : ""}</div>
        ${shop ? `<div class="lcard-sub">Checked by ${esc(shop.name)}${catOf(item) ? ` · ${esc(catName(catOf(item)))}` : ""}</div>` : ""}
        ${item.status === STATUS.LISTED && quoteOf(item)?.available ? `<div class="lcard-sub prot-line">90-day protection ${usd(quoteOf(item).fee)}</div>` : ""}
        ${footer === "" ? "" : `<div class="lcard-foot">${footer ?? chipFor(item)}</div>`}
      </button>`;
  }
  const tiles = (list) => `<div class="tiles">${list.map(([v, l]) => `<div class="tile"><strong>${v}</strong><small>${esc(l)}</small></div>`).join("")}</div>`;

  function renderWho() {
    const el = $("#who");
    if (state.publicId || state.inviteCode) { el.innerHTML = ""; return; }
    if (!signedIn()) { el.innerHTML = `<button class="btn primary signin-btn" data-action="open-signin">Sign in</button>`; return; }
    if (state.isAdmin) {
      el.innerHTML = `
        <div class="persona active" aria-label="Signed in">${avatar("A", "admin")}
          <span><div class="p-name">Admin <em>contract owner</em></div><div class="p-bal">${short(state.adminAddress)}</div></span></div>
        <button class="signout" data-action="sign-out">Sign out</button>`;
      return;
    }
    const v = state.me;
    const lvl = levelOf(v.address);
    el.innerHTML = `
      <div class="persona active" aria-label="Signed in">${avatar(v.name, v.handle)}
        <span><div class="p-name">${esc(v.name)} <em>${esc(lvl.label)}</em></div><div class="p-bal">${state.loaded ? usd(myBalance()) : "…"}</div></span></div>
      <button class="addmoney" data-action="add-money">+ Add money</button>
      <button class="signout" data-action="sign-out">Sign out</button>`;
  }

  const mineSelling = () => state.items.filter((i) => IN_SALE.includes(i.status) && same(i.owner, myAddr()));
  const mineBuying = () => state.items.filter((i) => IN_SALE.includes(i.status) && same(i.buyer, myAddr()));
  const myRequests = () => state.items.filter((i) => {
    const r = reqOf(i.id);
    return r && r.status === "pending" && same(r.partner, myAddr()) && same(r.owner, i.owner) && i.status === STATUS.OWNED && !verified(i);
  });
  const myShopDisputes = () => openDisputes().filter((d) => same(d.partner, myAddr()));
  const myPanelDuty = () => openDisputes().filter((d) => d.panel.some((p) => same(p.addr, myAddr()) && !p.vote) && now() <= d.deadline);
  const unverifiedMembers = () => state.directory.filter((u) => u.role === "member" && memberOf(u.address) && !memberOf(u.address).verifiedBy);
  const flaggedListings = () => state.items.filter((i) => i.status === STATUS.LISTED && flagsOf(i.id).count > 0 && (same(i.partner, myAddr()) || same(i.authBy, myAddr())));

  function renderViewbar() {
    const el = $("#viewbar");
    const list = viewsFor();
    if (!signedIn() || !state.loaded || state.publicId || state.inviteCode || !list.length) { el.innerHTML = ""; return; }
    const badge = { community: myPanelDuty().length, desk: myRequests().length + myShopDisputes().length + unverifiedMembers().length + secondOpinions().length, sell: mineSelling().filter((i) => i.status === STATUS.PAID).length, buy: 0, admin: 0 };
    let html = `<div class="viewbar-inner">${list.map((v) => `<button class="vbtn ${state.view === v ? "active" : ""}" data-view="${v}">${VIEWS[v].label}${badge[v] ? `<span class="count">${badge[v]}</span>` : ""}</button>`).join("")}</div>`;
    if (state.isAdmin && state.viewAs) {
      const v = viewer();
      html += `<div class="asbanner">Viewing as <strong>${esc(v?.name)}</strong> (${esc(levelOf(v?.address).label)}) · read-only <button class="linkish" data-action="stop-view-as">Back to admin</button></div>`;
    }
    el.innerHTML = html;
  }

  function renderTabs() {
    const nav = $("#tabs");
    if (!state.view || !state.loaded || state.publicId || state.inviteCode) { nav.innerHTML = ""; nav.dataset.sig = ""; return; }
    const counts = {
      sales: mineSelling().length, orders: mineBuying().length, requests: myRequests().length,
      sdisputes: myShopDisputes().length, disputes: myPanelDuty().length, front: unverifiedMembers().length + flaggedListings().length, opinions: secondOpinions().length,
    };
    const html = tabsOf(state.view).map(([id, label]) =>
      `<button role="tab" data-tab="${id}" class="tab ${state.tab === id ? "active" : ""}" aria-selected="${state.tab === id}">${label}${counts[id] ? `<span class="count">${counts[id]}</span>` : ""}</button>`).join("");
    if (nav.dataset.sig !== html) { nav.innerHTML = html; nav.dataset.sig = html; }
  }

  function moneyTip() {
    if (readOnly() || myBalance() > 0n) return "";
    return `<p class="tip boxed">No test dollars yet. <button class="linkish" data-action="add-money">Add money</button></p>`;
  }
  const STEPS = ["Join by invitation", "ID checked by an authenticator", "A specialist authenticates the piece", "Buyer pays, money is held", "Ship, then confirm or dispute", "A panel of members decides disputes"];
  const stepsHtml = () => `<ol class="steps">${STEPS.map((t, i) => `<li><span>${i + 1}</span>${t}</li>`).join("")}<li class="how-link"><button class="linkish" data-action="how">How it works on Arc</button></li></ol>`;

  // ------------------------------------------------------------ marketplace
  const CATS = [["all", "All", null], ["watches", "Watches", "watch"], ["vintage-watches", "Vintage watches", "watch"], ["jewelry", "Jewelry", "ring"], ["handbags", "Handbags", "bag"]];
  const ICON_CAT = { watch: "watches", ring: "jewelry", bag: "handbags" };
  const GRID_ICON = '<rect x="10" y="10" width="18" height="18" rx="4"/><rect x="36" y="10" width="18" height="18" rx="4"/><rect x="10" y="36" width="18" height="18" rx="4"/><rect x="36" y="36" width="18" height="18" rx="4"/>';
  const matches = (i) => {
    if (state.cat !== "all" && (catOf(i) || ICON_CAT[iconKey(i.imageUrl)]) !== state.cat) return false;
    const q = state.q.trim().toLowerCase();
    return !q || `${i.name} ${i.brand} ${i.details}`.toLowerCase().includes(q);
  };
  function chipsHtml() {
    return `<div class="cats" aria-label="Categories">${CATS.map(([k, label, ic]) => `
      <button class="cat ${state.cat === k ? "on" : ""}" data-cat="${k}" aria-pressed="${state.cat === k}">
        <svg viewBox="0 0 64 64" aria-hidden="true">${ic ? ICONS[ic].svg : GRID_ICON}</svg><span>${label}</span></button>`).join("")}</div>`;
  }
  function renderSearch() {
    const el = $("#search");
    const show = !state.publicId && !state.inviteCode && (!signedIn() || state.view === "buy");
    if (!show) { el.innerHTML = ""; return; }
    if (el.querySelector("input")) return; // keep focus while typing
    el.innerHTML = `<label class="searchbar"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Search pieces or brands" value="${esc(state.q)}" aria-label="Search pieces or brands"></label>`;
  }
  const listedNow = () => state.items.filter((i) => i.status === STATUS.LISTED && !paused(i));
  const recentlySold = () => state.items.filter((i) => i.status === STATUS.OWNED && (state.histories[i.id] || []).some((t) => !isZero(t.from)));

  // Landing: the 3D passport with the benefits of joining (drawn by passport3d.js).
  // This block is static, so the live refresh never rebuilds the 3D scene.
  function renderHero() {
    const el = $("#hero");
    if (!state.loaded || signedIn() || state.inviteCode || state.publicId) { if (el.innerHTML) { el.innerHTML = ""; el.dataset.sig = ""; } return; }
    if (el.dataset.sig === "why") return;
    el.dataset.sig = "why";
    el.innerHTML = `
      <section class="why" aria-labelledby="why-h">
        <div class="why-copy">
          <h2 id="why-h">Pre-owned watches and jewelry, checked by specialists who stake their own money</h2>
          <p>Every member's ID and every piece is checked in person. Your money is held until it arrives, and 90-day protection is priced from everyone's record.</p>
          <div class="row why-cta"><a class="btn gold" href="#browse" data-scroll="browse">Browse pieces</a><button class="btn ghost" data-action="open-signin">Sign in</button></div>
          <p class="why-hint">Drag the passport to spin it. Hover a badge to see what you get.</p>
        </div>
        <div class="stage3d" tabindex="0" aria-label="3D passport with the benefits of joining. Drag or use the arrow keys to spin it.">
          <canvas aria-hidden="true"></canvas>
          <div class="orbit"></div>
        </div>
      </section>`;
    window.dispatchEvent(new Event("wp:stage"));
  }

  function renderLanding() {
    const s = stats();
    const live = listedNow().filter(matches).reverse();
    const sold = recentlySold().filter(matches).reverse();
    const filtering = state.q.trim() || state.cat !== "all";
    return `
      <div class="intro" id="browse">
        <div><h2>Browse pieces</h2></div>
        <div class="intro-facts"><span><b>${s.members}</b> members</span><span><b>${s.sales}</b> sales</span><span><b>${s.disputes}</b> ${s.disputes === 1 ? "dispute" : "disputes"} decided</span>${prot() ? `<span><b>${usd(totalBonds() + BigInt(prot().pool.assets))}</b> staked behind stamps and protection</span>` : ""}</div>
      </div>
      ${chipsHtml()}
      ${live.length ? `<div class="lgrid">${live.map((i) => card(i, "")).join("")}</div>`
        : `<div class="empty slim"><p>${filtering ? "Nothing matches. Try another category or search." : "Nothing for sale yet."}</p></div>`}
      ${sold.length ? `<h3 class="grid-h">Recently sold</h3><div class="lgrid">${sold.map((i) => card(i, "")).join("")}</div>` : ""}
      ${communityHtml()}
      ${protectionPitchHtml()}
      ${explainHtml()}`;
  }

  // The people in the community. Each one can be used to try the app (demo sign-in).
  function communityHtml() {
    const people = [...state.demo.filter((d) => d.handle !== "shop"), ...state.seeded];
    if (!people.length) return "";
    const shops = state.partners.filter((p) => p.active);
    return `
      <section class="community" aria-labelledby="community-h">
        <div class="community-head">
          <div><h2 id="community-h">Meet the community</h2><p>Every member joined by invitation and had their ID checked in person. Tap anyone to try the app as them.</p></div>
          <div class="shop-cards">${shops.map((p) => `<button class="shop-card" data-demo="${esc(dirByAddr(p.addr)?.handle || "")}" ${dirByAddr(p.addr) ? "" : "disabled"}><span class="avatar">${esc(p.name[0])}</span><span><b>${esc(p.name)}</b><small>${esc(p.city)} · ${specialtiesOf(p.addr).length ? esc(specialtiesOf(p.addr).map(catName).join(", ")) : "authenticator"}${shopStatsOf(p.addr) ? ` · ${usd(BigInt(shopStatsOf(p.addr).bond))} bond` : ""}</small></span></button>`).join("")}</div>
        </div>
        <div class="people-grid">${people.map((u) => `
          <button class="person-card" data-demo="${esc(u.handle)}" aria-label="Try the app as ${esc(u.name)}">
            ${avatar(u.name, u.handle, "avatar big-av")}
            <b>${esc(u.name)}</b>
            <small>✓ ID checked</small>
          </button>`).join("")}</div>
      </section>`;
  }

  const totalBonds = () => Object.values(prot()?.shops || {}).reduce((s, x) => s + BigInt(x.bond), 0n);
  // The new part of the pitch: authenticators back their stamp with money, and protection is priced from the records.
  function protectionPitchHtml() {
    const p = prot();
    if (!p) return "";
    const covers = p.covers.length, paid = p.covers.filter((c) => c.state === "paid").length;
    return `
      <section class="pitch" aria-labelledby="pitch-h">
        <div class="pitch-copy">
          <h2 id="pitch-h">When an authenticator is wrong, it pays</h2>
          <p>Each authenticator stakes a bond behind its stamp. Buyers can add 90 days of protection after delivery, priced from the seller's record, the record of whoever invited them, and the authenticator's record in that category. If a second specialist finds the piece is fake, the bond pays first and a pool funded by members pays the rest.</p>
        </div>
        <div class="pitch-facts">
          <div><b>${usd(totalBonds())}</b><small>staked by ${plural(Object.keys(p.shops).length, "authenticator", "authenticators")}</small></div>
          <div><b>${usd(BigInt(p.pool.assets))}</b><small>in the members' pool</small></div>
          <div><b>${covers}</b><small>${covers === 1 ? "purchase" : "purchases"} protected</small></div>
          <div><b>${usd(BigInt(p.pool.paid))}</b><small>paid out on ${plural(paid, "fake", "fakes")}</small></div>
        </div>
      </section>`;
  }

  function explainHtml() {
    return `
      <section class="explain" aria-labelledby="explain-h">
        <h2 id="explain-h">How it works</h2>
        <div class="promises">
          <div><span class="pi"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg></span><h3>Members are vouched for</h3><p>Invite-only. IDs checked in person.</p></div>
          <div><span class="pi"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="m9 12 2 2 4-4"/></svg></span><h3>Every piece is checked</h3><p>A specialist in its category authenticates it first.</p></div>
          <div><span class="pi"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span><h3>Your money is safe</h3><p>Held until you confirm delivery.</p></div>
          <div><span class="pi"><svg viewBox="0 0 24 24"><path d="M12 4v16M5 8h14M7 8l-3 6h6zM17 8l-3 6h6z"/></svg></span><h3>Disputes are fair</h3><p>Five random members vote.</p></div>
        </div>
      </section>`;
  }

  // Sign in lives in a modal, so the landing page can be the marketplace.
  function openSignin() {
    const si = state.signin;
    const codeForm = si.sent ? `
      <div class="field"><label for="si-code">Code sent to ${esc(si.email)}</label>
        <div class="row"><input id="si-code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" value="${esc(si.demoCode || "")}"><button class="btn primary" data-action="verify-code">Sign in</button></div>
        ${si.demoCode ? `<span class="hint">Demo mode: email isn't connected yet, so the code is shown here.</span>` : `<span class="hint">Check your inbox.</span>`}
        <button class="linkish" data-action="code-reset">Use a different email</button></div>`
      : `
      <div class="field"><label for="si-email">Email you joined with</label>
        <div class="row"><input id="si-email" type="email" placeholder="you@example.com" value="${esc(si.email)}"><button class="btn primary" data-action="send-code">Continue</button></div>
        <span class="hint">We'll email you a one-time code. New here? Open the invite link a member sent you.</span></div>`;
    openModal("Sign in", `
      ${codeForm}
      ${state.demo.length ? `
      <div class="or"><span>or try the demo</span></div>
      <div class="demo-list">${state.demo.map((d) => `
        <button class="demo-row" data-demo="${d.handle}">${avatar(d.name, d.handle)}<span><b>${esc(d.name)}</b><small>${esc(d.label)}</small></span><span class="go">Continue</span></button>`).join("")}</div>
      ${state.seeded.length ? `<p class="fine">Vote on disputes as a member: ${state.seeded.map((u) => `<button class="chip owned seed-chip" data-demo="${esc(u.handle)}">${esc(u.name)}</button>`).join(" ")}</p>` : ""}` : ""}
      <p class="fine center"><button class="linkish" data-action="admin-signin">Platform admin: sign in with MetaMask</button></p>
    `, (m) => { m.classList.add("narrow"); ($("#si-code", m) || $("#si-email", m))?.focus(); });
  }

  function renderJoin() {
    const inv = state.invite;
    if (!inv) return `<div class="loading"><div class="spinner"></div>Checking your invite…</div>`;
    if (inv.error) return `<div class="empty"><h3>This invite can't be used</h3><p>${esc(inv.error)}</p><button class="btn primary" data-action="leave-invite">Go to sign in</button></div>`;
    if (signedIn()) return `<div class="empty"><h3>You're already signed in</h3><p>Sign out first if you want to join as someone new.</p><button class="btn primary" data-action="leave-invite">Back to the app</button></div>`;
    return `
      <div class="join">
        <div class="panel">
          <span class="role-kicker">You're invited</span>
          <h2 class="join-title">${esc(inv.inviterName)} invited you to Wardrobe Passport</h2>
          <p>A closed resale community for watches and jewelry. Every piece is authenticated in person by a specialist, payment is held until it arrives, and members decide disputes together. ${esc(inv.inviterName)}'s name will be linked to your membership on Arc, and your record affects the protection price on what they sell.</p>
          <form id="join-form" novalidate>
            <div class="field"><label for="j-name">Your name</label><input id="j-name" type="text" maxlength="40" placeholder="e.g. Priya Shah" required></div>
            <div class="field"><label for="j-email">Email</label><input id="j-email" type="email" maxlength="120" placeholder="you@example.com" required><span class="hint">You'll use it to sign in. We never show it to other members.</span></div>
            <p class="hint" id="j-error" style="color:var(--err);min-height:1em;margin:0 0 8px"></p>
            <button class="btn gold block" type="submit" ${state.busy ? "disabled" : ""}>Join the community</button>
          </form>
          <ul class="plain fine">
            <li>You get a Circle wallet on Arc, with no keys to look after.</li>
            <li>As a new member you can buy right away, up to $50 per item.</li>
            <li>To sell, show your member code and a photo ID at a partner authenticator.</li>
            <li>Welcome gift: your first delivery is free.</li>
          </ul>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------ seller
  const NEXT = {
    none: "Ask a specialist to authenticate it",
    declined: "Not verified. Ask again or choose another authenticator",
    verified: "Verified. Set a price and list it",
  };
  function memberCard(u) {
    return `
      <div class="member-card">
        <div class="mc-qr">${qrSvg(`wp-member:${u.handle}`)}</div>
        <div>
          <span class="role-kicker">Member code</span>
          <div class="mc-code mono-inline">${esc(u.handle)}</div>
          <p class="fine">Show this and a photo ID at a partner authenticator. They check it's you and record it on Arc.</p>
        </div>
      </div>`;
  }

  /** The parts of a protection price, in plain words. */
  function rateWords(r, item) {
    const out = [];
    const cat = item ? catName(catOf(item)) : "Watches";
    out.push(`${cat || "Category"} base ${pctTxt(r.base)}`);
    if (r.sellerAdj) out.push(`${r.sellerAdj > 0 ? "seller's record" : "seller's clean sales"} ${signedPct(r.sellerAdj)}`);
    if (r.inviterAdj) out.push(`invited by a member whose invitees lost disputes ${signedPct(r.inviterAdj)}`);
    if (r.shopAdj) out.push(`${r.shopAdj > 0 ? "authenticator's fakes in this category" : "authenticator's clean record"} ${signedPct(r.shopAdj)}`);
    return out;
  }
  /** "Why this price?": each part of the fee, with the record behind it. */
  function whyPriceHtml(item, q) {
    const r = recOf(item.owner);
    const mp = memberProt(item.owner) || {};
    const ss = shopStatsOf(item.authBy);
    const inviter = memberOf(item.owner)?.invitedBy;
    const row = (label, bps, why) => `<div class="why-row"><span><b>${label}</b><small>${why}</small></span><span class="why-pct ${bps > 0 ? "up" : bps < 0 ? "down" : ""}">${bps ? signedPct(bps) : "0%"}</span></div>`;
    const sellerWhy = [r.sold ? `${plural(r.sold, "completed sale", "completed sales")} (−0.25% each, up to −1.5%)` : "No completed sales yet (+2%)",
      r.disputesLost ? `${plural(r.disputesLost, "dispute lost", "disputes lost")} (+3% each)` : "", r.refundsGiven ? `${plural(r.refundsGiven, "refund", "refunds")} (+1% each)` : "",
      mp.fakesSold ? `${plural(mp.fakesSold, "fake", "fakes")} proven (+5% each)` : ""].filter(Boolean).join(" · ");
    const invRec = inviter ? recOf(inviter) : null;
    const fakesHere = ss?.fakesIn?.[q.category] || 0;
    const shopWhy = fakesHere ? `${plural(fakesHere, "fake", "fakes")} stamped in ${catName(q.category).toLowerCase()} (+4% each)` : q.shopAdj < 0 ? "10+ stamps and no fakes anywhere (−0.5%)" : "No fakes in this category";
    return `
      <details class="why-price"><summary>Why this price?</summary>
        ${row(`${catName(q.category)} base rate`, q.base, "Set per category. Vintage pieces are harder to judge.")}
        ${row(`Seller: ${esc(nameOf(item.owner))}`, q.sellerAdj, sellerWhy)}
        ${row(`Invited by ${inviter ? esc(nameOf(inviter)) : "no one"}`, q.inviterAdj, inviter ? (invRec.inviteesDisputesLost ? `People they invited lost ${plural(invRec.inviteesDisputesLost, "dispute", "disputes")} (+1% each, up to +3%)` : "People they invited have a clean record") : "Founding member")}
        ${row(`Authenticator: ${esc(nameOf(item.authBy))}`, q.shopAdj, shopWhy)}
        <div class="why-row total"><span><b>Your price</b><small>${pctTxt(q.feeBps)} of ${usd(item.price)}, kept between 1% and 20%</small></span><span class="why-pct">${usd(q.fee)}</span></div>
        <p class="fine">Calculated on Arc by the protection contract from records nobody can edit.</p>
      </details>`;
  }

  function renderSellerHome() {
    const v = viewer();
    const mine = state.items.filter((i) => same(i.owner, myAddr()));
    const owned = mine.filter((i) => i.status === STATUS.OWNED);
    const waiting = owned.filter((i) => authStage(i) === "pending");
    const listed = mine.filter((i) => i.status === STATUS.LISTED);
    const toShip = mine.filter((i) => i.status === STATUS.PAID);
    let earned = 0n;
    for (const it of state.items) for (const t of state.histories[it.id] || []) if (same(t.from, myAddr())) earned += t.price - feeOf(t.price);
    const dis = state.busy || readOnly() ? "disabled" : "";
    const canSell = isVerified(myAddr());

    let html = `
      <div class="section-head">
        <div><h2>${readOnly() ? esc(v.name) + "'s selling" : `Welcome back, ${esc(v.name)}`}</h2><p>${esc(levelOf(myAddr()).label)} · ${esc(recText(myAddr()))}</p></div>
        <button class="btn primary" data-action="add-item" ${dis}>+ Add a piece</button>
      </div>
      ${moneyTip()}`;
    if (!canSell) {
      html += `<div class="callout held"><strong>Get your ID checked to start selling.</strong> Show this code and a photo ID at ${activePartners()[0] ? esc(activePartners()[0].name) : "a partner authenticator"}.</div>${memberCard(v)}`;
    }
    const myRate = memberProt(myAddr())?.rate;
    html += tiles([[mine.length, "pieces"], [waiting.length, "waiting for an authenticator"], [listed.length, "for sale"], [toShip.length, "to ship"], [usd(earned), "earned from sales"], ...(myRate ? [[pctTxt(myRate.feeBps), "protection rate on your watches"]] : [])]);
    if (myRate) html += `<p class="fine">Buyers can protect what you sell for 90 days. Their price starts from your record: ${rateWords(myRate).join(", ")}. Clean sales bring it down.</p>`;

    const todo = [];
    for (const i of owned) { const st = authStage(i); if (NEXT[st]) todo.push([i, st === "verified" && !canSell ? "Verified. Get your ID checked to list it" : NEXT[st], st === "verified" ? "List it" : "Request"]); }
    for (const i of toShip) todo.push([i, `${nameOf(i.buyer)} paid ${usd(i.price)}. Ship it and mark it as shipped`, "Ship"]);
    for (const i of mine.filter((x) => x.status === STATUS.SHIPPED && now() >= x.shippedAt + CONFIRM_DAYS * 86400)) todo.push([i, "The buyer didn't respond. You can collect the payment", "Collect"]);
    for (const i of mine.filter((x) => x.status === STATUS.DISPUTED)) todo.push([i, "Dispute open. A panel of members is voting", "View"]);
    for (const i of listed.filter(paused)) todo.push([i, "Paused: members flagged this listing. The authenticator will review it", "View"]);

    html += `<div class="h-label">What to do next</div>`;
    if (!mine.length) {
      html += `<div class="empty"><h3>Start with your first piece</h3><p>Add a piece and it gets a digital passport: a photo, who owned it, when, and for how much.</p><button class="btn gold" data-action="add-item" ${dis}>Add your first piece</button></div>`;
    } else if (!todo.length) {
      html += `<div class="empty slim"><p>Nothing needs you right now${waiting.length ? ". An authenticator is checking your piece" : listed.length ? ". Your listing is live in the marketplace" : ""}.</p></div>`;
    } else {
      html += `<div class="done-list">` + todo.map(([i, line, cta]) => `
        <button class="done" data-open="${i.id}">${art(i, "mini")}<span><strong>${esc(i.name)}</strong><small>${esc(line)}</small></span><span class="done-cta">${cta}</span></button>`).join("") + `</div>`;
    }
    return html;
  }

  function renderPieces() {
    const mine = state.items.filter((i) => same(i.owner, myAddr())).reverse();
    const dis = state.busy || readOnly() ? "disabled" : "";
    const head = `
      <div class="section-head">
        <div><h2>My pieces</h2><p>${plural(mine.length, "piece", "pieces")}</p></div>
        <button class="btn primary" data-action="add-item" ${dis}>+ Add a piece</button>
      </div>`;
    if (!mine.length) return head + `<div class="empty"><h3>No pieces yet</h3><p>Add a piece and it gets a digital passport.</p><button class="btn gold" data-action="add-item" ${dis}>Add your first piece</button></div>`;
    return head + `<div class="grid">${mine.map((i) => card(i)).join("")}</div>`;
  }

  // ------------------------------------------------------------------- buyer
  function renderShop() {
    const forSale = listedNow().filter((i) => !same(i.owner, myAddr())).filter(matches).reverse();
    const capNote = !isVerified(myAddr()) && !readOnly() ? `<p class="tip boxed">You can buy pieces up to $50 until your ID is checked.</p>` : "";
    const pnote = prot() ? `<p class="fine">Pieces marked “Bond-backed” can be protected for 90 days after delivery. Open one to see its price and why.</p>` : "";
    return `${moneyTip()}${capNote}${chipsHtml()}${pnote}
      ${forSale.length ? `<div class="lgrid">${forSale.map((i) => card(i, "")).join("")}</div>`
        : `<div class="empty slim"><p>${state.q || state.cat !== "all" ? "Nothing matches. Try another category or search." : "Nothing for sale right now."}</p></div>`}`;
  }

  /** Protection on a buyer's purchase: status, days left and what they can do. */
  function coverBlock(item, buyer = myAddr()) {
    if (!prot()) return "";
    const dis = state.busy || readOnly() ? "disabled" : "";
    const c = coverFor(item, buyer);
    const inSale = [STATUS.PAID, STATUS.SHIPPED].includes(item.status) && same(item.buyer, buyer);
    if (!c || (inSale && c.paidAt !== item.paidAt)) {
      if (!inSale) return "";
      const q = quoteOf(item);
      if (!q) return "";
      if (!q.available) return `<p class="fine prot-note">${certified(item) ? "Protection isn't available on this piece right now: the authenticator's bond or the pool is too small." : "This piece wasn't certified by a specialist, so it can't be protected."}</p>`;
      return `<div class="prot-offer"><span><b>Add 90-day protection: ${usd(q.fee)}</b><small>${pctTxt(q.feeBps)} of the price. Covers you for 90 days after delivery if a second specialist finds it's fake.</small></span><button class="btn gold small" data-action="buy-cover" data-id="${item.id}" ${dis}>Add protection</button></div>`;
    }
    const fee = usd(BigInt(c.fee));
    const ends = c.deliveredAt + COVER_DAYS * 86400;
    const left = Math.max(0, Math.ceil((ends - now()) / 86400));
    const canClaim = c.state === "active" && left > 0 && same(item.owner, buyer) && item.status === STATUS.OWNED;
    const line = {
      pending: `Protected (${fee}). The 90 days start when you confirm delivery.`,
      active: left > 0 ? `Protected for ${plural(left, "more day", "more days")}, until ${fmtDate(ends)}. Covers the full ${usd(BigInt(c.amount))}.` : "Protection has ended.",
      claimed: `Claim filed ${fmtDate(c.claimedAt)}. A second specialist in ${esc(catName(c.category).toLowerCase())} is re-inspecting it.`,
      paid: `Proven fake. You got ${usd(BigInt(c.amount) + BigInt(c.claimDeposit))} back: ${esc(nameOf(c.shop))}'s bond paid half, the members' pool paid half.${c.ruling ? ` “${esc(c.ruling)}”` : ""}`,
      rejected: `Claim rejected by ${esc(nameOf(c.reviewer))}: “${esc(c.ruling)}”`,
      expired: "Protection ended after 90 days with no claim.",
      void: `The sale didn't complete, so the ${fee} fee was refunded.`,
    }[c.state];
    const cls = c.state === "paid" ? "ok" : c.state === "rejected" ? "bad" : c.state === "claimed" ? "held" : "info";
    return `<div class="prot-status ${cls}"><span class="shield" aria-hidden="true">🛡</span><span>${line}</span>${canClaim ? `<button class="btn danger small" data-action="claim-fake" data-cover="${c.id}" ${dis}>This is a fake</button>` : ""}</div>`;
  }

  function renderMine() {
    const mine = state.items.filter((i) => same(i.owner, myAddr()) && i.status === STATUS.OWNED).reverse();
    const head = `<div class="section-head"><div><h2>My purchases</h2><p>Pieces you own, each with its passport · ${esc(recText(myAddr()))}</p></div></div>`;
    if (!mine.length) return head + `<div class="empty"><h3>Nothing here yet</h3><p>When a piece arrives and you confirm it, its passport moves to you and it shows here.</p><button class="btn ghost" data-tab-go="shop">Browse the marketplace</button></div>`;
    const covered = prot() ? (prot().covers || []).filter((c) => same(c.buyer, myAddr())).map((c) => itemById(c.itemId)).filter(Boolean) : [];
    const protHtml = covered.length ? `<div class="h-label">Protection</div>` + [...new Set(covered)].reverse().map((i) => `
      <div class="order slim">${art(i, "mini")}<div><h3>${esc(i.name)}</h3><p>${esc(i.brand)} · authenticated by ${esc(nameOf(coverFor(i, myAddr()).shop))}</p>${coverBlock(i)}<div class="actions"><button class="btn ghost small" data-open="${i.id}">View passport</button></div></div></div>`).join("") : "";
    return head + protHtml + `<div class="h-label">In your collection</div><div class="grid">${mine.map((i) => card(i)).join("")}</div>`;
  }

  function disputeLine(d) {
    if (!d) return "";
    const n = d.panel.length;
    if (n < MIN_PANEL) return `The community is too small for a panel, so ${esc(nameOf(d.partner))} decides.`;
    const voted = d.votesBuyer + d.votesSeller;
    return now() <= d.deadline
      ? `A panel of ${n} members is voting (${voted} of ${n} so far). The first side to ${Math.floor(n / 2) + 1} votes wins. Voting closes ${fmtWhen(d.deadline)}.`
      : `Voting closed with ${voted} of ${n} votes.`;
  }

  function saleBlock(i) {
    const dis = state.busy || readOnly() ? "disabled" : "";
    const isBuyer = same(i.buyer, myAddr());
    const isSeller = same(i.owner, myAddr());
    const d = disputeOf(i);
    const shipBy = i.paidAt + SHIP_DAYS * 86400;
    const confirmBy = i.shippedAt + CONFIRM_DAYS * 86400;
    let chip = "", note = "", actions = "";
    if (i.status === STATUS.PAID && isBuyer) {
      chip = `${usd(i.price)} held · waiting for ${esc(nameOf(i.owner))} to ship`;
      note = now() >= shipBy ? `It wasn't shipped in ${SHIP_DAYS} days. You can cancel and receive the seller's deposit too.` : `If it isn't shipped by ${fmtDate(shipBy)}, you can cancel and also receive the seller's ${usd(i.deposit)} deposit.`;
      actions = `<button class="btn gold" data-action="confirm" data-id="${i.id}" ${dis}>I received it</button>` + (now() >= shipBy ? `<button class="btn danger" data-action="buyer-cancel" data-id="${i.id}" ${dis}>Never shipped: cancel and refund me</button>` : "");
    } else if (i.status === STATUS.SHIPPED && isBuyer) {
      chip = `${usd(i.price)} held · shipped ${fmtDate(i.shippedAt)}`;
      note = `Confirm or open a dispute by ${fmtDate(confirmBy)}. After that, ${esc(nameOf(i.owner))} can collect the payment.`;
      actions = `<button class="btn gold" data-action="confirm" data-id="${i.id}" ${dis}>I received it</button><button class="btn danger" data-action="dispute" data-id="${i.id}" ${dis}>Something's wrong</button>`;
    } else if (i.status === STATUS.DISPUTED && (isBuyer || isSeller)) {
      chip = `Dispute open · ${usd(i.price)} held`;
      note = `${isBuyer ? "Your reason" : `${esc(nameOf(i.buyer))} says`}: “${esc(d?.reason || "")}”. ${disputeLine(d)}${isSeller ? ` If the panel sides with the buyer, you lose your ${usd(i.deposit)} deposit.` : ""}`;
      actions = `<button class="btn ghost" data-tab-go="disputes">See the panel</button>`;
    } else if (i.status === STATUS.PAID && isSeller) {
      chip = `${esc(nameOf(i.buyer))} paid ${usd(i.price)} · held`;
      note = `Ship it by ${fmtDate(shipBy)}, then mark it as shipped. You're paid when the buyer confirms.`;
      actions = `<button class="btn gold" data-action="ship" data-id="${i.id}" ${dis}>Mark as shipped</button><button class="btn danger" data-action="seller-cancel" data-id="${i.id}" ${dis}>Can't ship? Refund the buyer</button>`;
    } else if (i.status === STATUS.SHIPPED && isSeller) {
      chip = `Shipped · ${usd(i.price)} held`;
      note = now() >= confirmBy ? `The buyer didn't respond in ${CONFIRM_DAYS} days. You can collect the payment now.` : `Waiting for ${esc(nameOf(i.buyer))} to confirm. If they say nothing, you can collect from ${fmtDate(confirmBy)}.`;
      actions = now() >= confirmBy ? `<button class="btn gold" data-action="claim" data-id="${i.id}" ${dis}>Collect payment</button>` : "";
    }
    return { chip, note, actions, bad: i.status === STATUS.DISPUTED };
  }

  function orderRow(i) {
    const b = saleBlock(i);
    const isBuyer = same(i.buyer, myAddr());
    return `
      <div class="order">${art(i)}
        <div>
          <h3>${esc(i.name)}</h3>
          <p>${esc(i.brand)} · ${isBuyer ? `from ${esc(nameOf(i.owner))}` : `bought by ${esc(nameOf(i.buyer))}`} · paid ${fmtDate(i.paidAt)} · authenticated by ${esc(nameOf(i.partner))}${!isBuyer && coverFor(i, i.buyer) && coverFor(i, i.buyer).paidAt === i.paidAt ? " · buyer added protection" : ""}</p>
          <span class="chip ${b.bad ? "bad" : "held"}">${b.chip}</span>
          <p class="fine">${b.note}</p>
          ${isBuyer ? coverBlock(i) : ""}
          <div class="actions">${b.actions}<button class="btn ghost" data-open="${i.id}">View passport</button></div>
        </div>
      </div>`;
  }

  function renderOrders(side) {
    const buying = side === "buying";
    const open = buying ? mineBuying() : mineSelling();
    const done = [];
    for (const it of state.items) for (const t of state.histories[it.id] || []) {
      if (isZero(t.from)) continue;
      if (buying && same(t.to, myAddr())) done.push({ it, t, kind: "Bought", other: t.from });
      else if (!buying && same(t.from, myAddr())) done.push({ it, t, kind: "Sold", other: t.to });
    }
    done.sort((a, b) => b.t.at - a.t.at);
    let html = `<div class="section-head"><div><h2>${buying ? "My orders" : "Sales"}</h2><p>${buying ? "What you've paid for and what has arrived" : "What you've sold, what to ship and what you've been paid"} · ${esc(recText(myAddr()))}</p></div></div>`;
    if (!open.length && !done.length) {
      return html + `<div class="empty"><h3>${buying ? "No orders yet" : "No sales yet"}</h3><p>${buying ? "When you buy a piece, it shows here until it arrives and the sale is settled." : "When someone buys one of your pieces, it shows here until the sale is settled."}</p><button class="btn ghost" data-tab-go="${buying ? "shop" : "pieces"}">${buying ? "Browse the marketplace" : "See my pieces"}</button></div>`;
    }
    if (open.length) html += `<div class="h-label">${buying ? "On the way" : "In progress"}</div>` + open.map(orderRow).join("");
    if (done.length) {
      html += `<div class="h-label">Completed</div><div class="done-list">` + done.map(({ it, t, kind, other }) => `
        <button class="done" data-open="${it.id}">${art(it, "mini")}<span><strong>${kind} ${esc(it.name)}</strong><small>${kind === "Bought" ? "from" : "to"} ${esc(nameOf(other))} · ${fmtDate(t.at)}</small></span><span class="done-amt ${kind === "Sold" ? "plus" : ""}">${kind === "Sold" ? "+" : "−"}${usd(t.price)}</span></button>`).join("") + `</div>`;
    }
    return html;
  }

  // ------------------------------------------------------------ shop desk
  function renderDesk() {
    const p = partnerOf(myAddr());
    const dis = state.busy || readOnly() ? "disabled" : "";
    if (!p) return `<div class="empty"><h3>This authenticator isn't an approved partner yet</h3><p>The platform admin approves partners on the contract (addPartner). Once approved, it can check IDs, authenticate pieces and help with disputes.</p></div>`;
    const requests = myRequests();
    const disputes = myShopDisputes();
    let html = `
      <div class="section-head">
        <div><h2>${esc(p.name)} · ${esc(p.city)}</h2><p>Partner authenticator${p.active ? "" : " (paused)"}${specialtiesOf(myAddr()).length ? ` · specialist in ${esc(specialtiesOf(myAddr()).map(catName).join(", ").toLowerCase())}` : ""}</p></div>
      </div>
      ${moneyTip()}
      ${tiles([[unverifiedMembers().length, "IDs to check"], [requests.length, "pieces to verify"], ...(prot() ? [[secondOpinions().length, "second opinions"], [usd(BigInt(shopStatsOf(myAddr())?.free ?? 0)), "free bond"]] : []), [disputes.length, "open disputes"], [p.authenticated, "pieces authenticated"], [usd(myBalance()), "balance"]])}`;

    if (state.tab === "front") {
      html += `
        <div class="h-label">Check a member's ID</div>
        <div class="panel">
          <p style="margin-top:0">Enter the member's code, check their photo ID, then record it.</p>
          <div class="row"><input id="fd-code" type="text" placeholder="Member code, e.g. priya-3f9a" ${dis}><button class="btn primary" data-action="fd-lookup" ${dis}>Look up</button></div>
          <div id="fd-result"></div>
        </div>
        <div class="h-label">Members whose ID isn't checked yet</div>`;
      const list = unverifiedMembers();
      html += list.length ? `<div class="done-list">` + list.map((u) => `
        <div class="done static">${avatar(u.name, u.handle, "avatar mini-av")}<span><strong>${esc(u.name)}</strong><small>Code ${esc(u.handle)} · invited by ${esc(dirBy(u.invitedBy)?.name || "—")} · joined ${fmtDate(memberOf(u.address).joinedAt)}</small></span>
          <span><button class="btn gold small" data-action="fd-check" data-member="${esc(u.handle)}" ${dis}>Check ID</button></span></div>`).join("") + `</div>` : `<div class="empty slim"><p>Everyone's ID has been checked.</p></div>`;
      const flagged = flaggedListings();
      html += `<div class="h-label">Listings flagged by members</div>`;
      html += flagged.length ? flagged.map((i) => `
        <div class="order">${art(i)}<div>
          <h3>${esc(i.name)} <small class="muted">Passport #${i.id}</small></h3>
          <p>Listed by ${esc(nameOf(i.owner))} for ${usd(i.price)}</p>
          <span class="chip ${paused(i) ? "bad" : "held"}">${plural(flagsOf(i.id).count, "flag", "flags")}${paused(i) ? " · paused" : ""}</span>
          <p class="fine">Reasons: ${flagsOf(i.id).reasons.map((r) => `“${esc(r)}”`).join(", ")}</p>
          <div class="actions"><button class="btn ghost" data-action="clear-flags" data-id="${i.id}" ${dis}>Reviewed: it's fine, clear the flags</button><button class="btn ghost" data-open="${i.id}">View passport</button></div>
        </div></div>`).join("") : `<div class="empty slim"><p>No flagged listings.</p></div>`;
      return html;
    }

    if (state.tab === "bond") return html + renderBond(p);
    if (state.tab === "opinions") return html + renderOpinions();

    if (state.tab === "sdisputes") {
      html += `<div class="h-label">Disputes on pieces you authenticated</div>`;
      html += disputes.length ? disputes.map((d) => disputeCard(d, "shop")).join("") : `<div class="empty slim"><p>No open disputes.</p></div>`;
      return html;
    }

    if (state.tab === "record") {
      const behind = state.items.filter((i) => same(i.partner, myAddr()) && i.status !== STATUS.OWNED);
      const stamped = state.items.filter((i) => same(i.authBy, myAddr())).reverse();
      html += tiles([[p.disputesResolved, "disputes it decided"], [p.reportsFiled, "inspection reports"], [state.disputes.filter((d) => same(d.partner, myAddr()) && d.resolved).length, "disputes closed"]]);
      html += `<div class="h-label">Sales you stand behind</div>`;
      html += behind.length ? `<div class="done-list">` + behind.map((i) => `
        <button class="done" data-open="${i.id}">${art(i, "mini")}<span><strong>${esc(i.name)}</strong><small>${esc(nameOf(i.owner))}${isZero(i.buyer) ? " · listed" : ` → ${esc(nameOf(i.buyer))}`} · your fee ${usd(feeOf(i.price))}</small></span><span class="done-amt">${usd(i.price)}</span></button>`).join("") + `</div>` : `<div class="empty slim"><p>No live sales right now.</p></div>`;
      html += `<div class="h-label">Authenticated by you</div>`;
      html += stamped.length ? `<div class="grid">${stamped.map((i) => card(i)).join("")}</div>` : `<div class="empty slim"><p>Nothing yet.</p></div>`;
      return html;
    }

    html += `<div class="h-label">Sellers waiting for you</div>`;
    html += requests.length ? requests.map((i) => `
      <div class="order">${art(i)}<div>
        <h3>${esc(i.name)} <small class="muted">Passport #${i.id}</small></h3>
        <p>${esc(i.brand || "No brand")}${i.details ? ` · ${esc(i.details)}` : ""}${catOf(i) ? ` · ${esc(catName(catOf(i)))}` : ""}</p>
        <span class="chip held">${esc(nameOf(i.owner))} asked on ${fmtDate(reqOf(i.id).createdAt)}</span>
        <p class="fine">Inspect it in person before you stamp it.${prot() && catOf(i) && specIn(myAddr(), catOf(i)) ? " Your stamp also certifies it for protection, and your bond stands behind it." : ""}</p>
        <div class="actions">
          <button class="btn gold" data-action="auth" data-id="${i.id}" ${dis}>Authenticate</button>
          <button class="btn ghost" data-action="decline" data-id="${i.id}" ${dis}>Can't verify</button>
          <button class="btn ghost" data-open="${i.id}">View passport</button>
        </div>
      </div></div>`).join("") : `<div class="empty slim"><p>Nothing waiting. Sellers' requests show up here.</p></div>`;
    return html;
  }

  // Claims on other authenticators' stamps, in categories this shop is approved for.
  const secondOpinions = () => !prot() ? [] : prot().covers.filter((c) => c.state === "claimed" && !same(c.shop, myAddr()) && !same(c.buyer, myAddr()) && !same(c.seller, myAddr()) && specIn(myAddr(), c.category));

  function renderBond(p) {
    const ss = shopStatsOf(myAddr()) || { bond: "0", locked: "0", free: "0", covered: 0, fakes: 0, fakesIn: {} };
    const dis = state.busy || readOnly() ? "disabled" : "";
    const mine = prot().covers.filter((c) => same(c.shop, myAddr())).reverse();
    const specs = specialtiesOf(myAddr());
    return `
      <div class="h-label">Your bond</div>
      <div class="panel">
        <p style="margin-top:0">Your bond stands behind every protected piece you stamped. If a second specialist proves one fake, half the price comes from your bond. Each protected sale holds half the price plus 2% (the re-inspection fee) until its 90 days end.</p>
        ${tiles([[usd(BigInt(ss.bond)), "staked"], [usd(BigInt(ss.locked)), "held behind live protection"], [usd(BigInt(ss.free)), "free"], [ss.covered, "protected sales on your stamp"], [ss.fakes, ss.fakes === 1 ? "fake proven" : "fakes proven"]])}
        <div class="row bond-row">
          <div class="money-input"><span>$</span><input id="bond-amt" type="number" min="0.01" step="0.01" placeholder="Amount" ${dis}></div>
          <button class="btn gold" data-action="stake-bond" ${dis}>Add to bond</button>
          <button class="btn ghost" data-action="withdraw-bond" ${dis}>Withdraw free bond</button>
        </div>
        <p class="hint">A bigger free bond lets you back more expensive pieces: a $10 piece needs $5.20 free.</p>
      </div>
      <div class="h-label">Your specialties</div>
      <div class="panel people">${specs.length ? specs.map((k) => `
        <div class="person"><span class="pn"><strong>${esc(catName(k))}</strong><small>${esc(specIn(myAddr(), k).credential)}</small></span><span class="pr">${plural(ss.fakesIn?.[k] || 0, "fake", "fakes")} proven in this category</span></div>`).join("") : `<p class="muted">You're not approved for any category yet. The platform admin approves specialists.</p>`}</div>
      <div class="h-label">Protected sales on your stamp</div>
      ${mine.length ? `<div class="done-list">${mine.map((c) => { const it = itemById(c.itemId); return `<button class="done" data-open="${c.itemId}">${it ? art(it, "mini") : ""}<span><strong>${esc(it?.name || "Piece")}</strong><small>${esc(nameOf(c.buyer))} · ${esc(c.state)} · ${usd(BigInt(c.shopLock))} of your bond ${["pending", "active", "claimed"].includes(c.state) ? "held" : c.state === "paid" ? "paid out" : "released"}</small></span><span class="done-amt">${usd(BigInt(c.amount))}</span></button>`; }).join("")}</div>` : `<div class="empty slim"><p>No protected sales yet.</p></div>`}`;
  }

  function renderOpinions() {
    const list = secondOpinions();
    const dis = state.busy || readOnly() ? "disabled" : "";
    let html = `<div class="h-label">Claims waiting for a second opinion</div><p class="fine">A buyer says a protected piece is fake. You never rule on your own stamps. Re-inspect it and rule: if it's fake, the buyer is refunded and you earn 2% of the price. If you don't rule in 3 days, the platform admin can.</p>`;
    html += list.length ? list.map((c) => {
      const it = itemById(c.itemId);
      return `
      <div class="order">${it ? art(it) : ""}<div>
        <h3>${esc(it?.name || "Piece")} <small class="muted">${esc(catName(c.category))}</small></h3>
        <p>${esc(nameOf(c.buyer))} bought it from ${esc(nameOf(c.seller))} for ${usd(BigInt(c.amount))}. Stamped by ${esc(nameOf(c.shop))}.</p>
        <div class="evidence"><div><small>Buyer says</small><p>“${esc(c.evidence)}”</p></div><div><small>${esc(nameOf(c.shop))}'s note when it stamped it</small><p>${it?.authNote ? `“${esc(it.authNote)}”` : "—"}</p></div></div>
        <div class="field"><label for="rule-${c.id}">Your ruling</label><input id="rule-${c.id}" type="text" maxlength="200" placeholder="What you found when you re-inspected it" ${dis}></div>
        <div class="actions"><button class="btn danger" data-action="decide-claim" data-cover="${c.id}" data-fake="1" ${dis}>It's fake: refund the buyer</button><button class="btn primary" data-action="decide-claim" data-cover="${c.id}" data-fake="0" ${dis}>It's genuine</button>${it ? `<button class="btn ghost" data-open="${it.id}">View passport</button>` : ""}</div>
      </div></div>`;
    }).join("") : `<div class="empty slim"><p>No claims waiting. Claims on pieces other authenticators stamped, in your categories, show up here.</p></div>`;
    const decided = prot().covers.filter((c) => same(c.reviewer, myAddr())).reverse();
    if (decided.length) html += `<div class="h-label">You ruled</div><div class="done-list">${decided.map((c) => `<button class="done" data-open="${c.itemId}">${itemById(c.itemId) ? art(itemById(c.itemId), "mini") : ""}<span><strong>${esc(itemById(c.itemId)?.name || "Piece")}: ${c.state === "paid" ? "fake" : "genuine"}</strong><small>“${esc(c.ruling)}”</small></span><span class="done-amt">${usd(BigInt(c.amount))}</span></button>`).join("")}</div>`;
    return html;
  }

  // ------------------------------------------------------- disputes (panel)
  const canFinalize = (d) => !d.resolved && now() > d.deadline && d.panel.length >= MIN_PANEL && d.votesBuyer + d.votesSeller >= QUORUM && d.votesBuyer !== d.votesSeller;
  const shopMustDecide = (d) => !d.resolved && (d.panel.length < MIN_PANEL || (now() > d.deadline && !canFinalize(d)));

  function disputeCard(d, as = "member") {
    const item = itemById(d.itemId);
    const dis = state.busy || readOnly() ? "disabled" : "";
    const n = d.panel.length;
    const myVote = d.panel.find((p) => same(p.addr, myAddr()));
    // The bond is always 5% of the price, so the price is known even after the sale has cleared.
    const price = d.bond * 20n;
    const voteLabel = (v) => (v === 1 ? "Buyer" : v === 2 ? "Seller" : d.resolved || now() > d.deadline ? "Didn't vote" : "Not yet");
    let status;
    if (d.resolved) status = `<span class="chip ${d.buyerWon ? "bad" : "ok"}">${d.buyerWon ? "Buyer won" : "Seller won"} · decided by ${d.decidedByPanel ? "the member panel" : esc(nameOf(d.partner))}</span>`;
    else status = `<span class="chip held">${disputeLine(d)}</span>`;
    let actions = "";
    if (!d.resolved && myVote && !myVote.vote && now() <= d.deadline && as === "member") {
      actions += `<button class="btn gold" data-action="vote" data-did="${d.id}" data-win="buyer" ${dis}>The buyer is right</button><button class="btn primary" data-action="vote" data-did="${d.id}" data-win="seller" ${dis}>The seller is right</button>`;
    }
    if (as === "shop" && !d.resolved) {
      actions += `<button class="btn ${d.report ? "ghost" : "gold"}" data-action="report" data-did="${d.id}" ${dis}>${d.report ? "Update inspection report" : "File inspection report"}</button>`;
      if (shopMustDecide(d)) actions += `<button class="btn primary" data-action="resolve" data-did="${d.id}" data-win="buyer" ${dis}>Decide: buyer is right</button><button class="btn ghost" data-action="resolve" data-did="${d.id}" data-win="seller" ${dis}>Decide: seller is right</button>`;
    }
    if (canFinalize(d) && !readOnly()) actions += `<button class="btn gold" data-action="finalize" data-did="${d.id}" ${dis}>Close the vote and pay out</button>`;
    return `
      <div class="order dispute">${item ? art(item) : ""}
        <div>
          <h3>Dispute #${d.id}: ${esc(item?.name || "Item")} <small class="muted">Passport #${d.itemId}</small></h3>
          <p>${esc(nameOf(d.buyer))} bought it from ${esc(nameOf(d.seller))} for ${usd(price)}. Opened ${fmtWhen(d.openedAt)} with a ${usd(d.bond)} bond.</p>
          <div class="evidence">
            <div><small>Buyer says</small><p>“${esc(d.reason)}”</p></div>
            <div><small>${esc(nameOf(d.partner))}'s inspection report</small><p>${d.report ? `“${esc(d.report)}”` : `<span class="muted">Not filed yet</span>`}</p></div>
          </div>
          <div class="panel-row">${d.panel.length ? d.panel.map((p) => `<span class="pv ${p.vote === 1 ? "b" : p.vote === 2 ? "s" : ""}" title="${esc(nameOf(p.addr))}: ${voteLabel(p.vote)}">${avatar(nameOf(p.addr), dirByAddr(p.addr)?.handle || p.addr, "avatar mini-av")}<span>${esc(nameOf(p.addr))}<small>${voteLabel(p.vote)}</small></span></span>`).join("") : `<span class="muted">No panel: too few eligible members.</span>`}</div>
          <p class="fine">Buyer ${d.votesBuyer} · Seller ${d.votesSeller}${n >= MIN_PANEL ? ` · needs ${Math.floor(n / 2) + 1} of ${n}` : ""}. Panel members who vote${d.resolved ? "d" : ""} with the outcome ${d.resolved ? "shared" : "share"} ${usd(pct(price, PANEL_FEE_BPS))}.${myVote && myVote.vote ? ` You voted for the ${voteLabel(myVote.vote).toLowerCase()}.` : ""}</p>
          ${status}
          <div class="actions">${actions}${item ? `<button class="btn ghost" data-open="${item.id}">View passport</button>` : ""}</div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ community
  const ACTION_LABEL = {
    registerMember: "joined the community", verifyMember: "checked a member's ID", createPassport: "created a passport", authenticate: "authenticated a piece",
    list: "listed a piece", unlist: "took a piece off sale", buy: "bought a piece", ship: "shipped a piece", confirm: "confirmed a delivery",
    claim: "collected a payment", sellerCancel: "refunded a buyer", buyerCancel: "cancelled an unshipped order", dispute: "opened a dispute",
    vote: "voted on a dispute", report: "filed an inspection report", finalize: "closed a dispute vote", resolve: "decided a dispute", fund: "received test dollars",
    certify: "certified a piece for protection", stakeBond: "staked a bond", withdrawBond: "withdrew bond", poolDeposit: "put money into the protection pool",
    poolWithdraw: "took money out of the protection pool", buyCover: "added 90-day protection", fileClaim: "filed a claim: says it's fake", decideClaim: "ruled on a claim",
    coverActivated: "started 90 days of protection", coverVoided: "cancelled protection and refunded the fee",
  };
  function actorName(row) {
    if (row.actor === "treasury") {
      if (row.action === "registerMember") return dirBy(row.detail?.member)?.name || "A member";
      return "Platform";
    }
    return dirBy(row.actor)?.name || row.actor;
  }
  function ledgerLine(row) {
    const it = row.itemId ? itemById(row.itemId) : null;
    let what = ACTION_LABEL[row.action] || row.action;
    if (row.action === "registerMember") what = row.detail?.invitedBy ? `joined, invited by ${esc(dirBy(row.detail.invitedBy)?.name || row.detail.invitedBy)}` : "joined as a founding member";
    if (row.action === "verifyMember") what = `checked ${esc(dirBy(row.detail?.member)?.name || "a member")}'s ID`;
    if (row.action === "fund") what = `sent ${esc(dirBy(row.detail?.to)?.name || "a member")} $${row.detail?.dollars} of test dollars${row.detail?.reason === "welcome" ? " (welcome)" : ""}`;
    if (row.action === "vote") what = `voted for the ${row.detail?.buyerWins ? "buyer" : "seller"} on dispute #${row.detail?.did}`;
    if (row.action === "list" && row.detail?.price) what = `listed it for ${usd(BigInt(row.detail.price))}`;
    if (row.action === "buy" && row.detail?.price) what = `bought it for ${usd(BigInt(row.detail.price))}`;
    if (row.action === "certify" && row.detail?.category) what = `certified it as ${esc(catName(row.detail.category).toLowerCase())}`;
    if (["stakeBond", "withdrawBond", "poolDeposit", "poolWithdraw"].includes(row.action) && row.detail?.amount) what = `${ACTION_LABEL[row.action]} (${usd(BigInt(row.detail.amount))})`;
    if (row.action === "buyCover" && row.detail?.fee) what = `added 90-day protection for ${usd(BigInt(row.detail.fee))} (${pctTxt(row.detail.feeBps)})`;
    if (row.action === "decideClaim") what = `re-inspected it and ruled it ${row.detail?.fake ? "fake: the buyer was refunded" : "genuine"}`;
    return `
      <div class="ledger-row">
        <span class="lr-when">${fmtWhen(row.at)}</span>
        <span class="lr-what"><strong>${esc(actorName(row))}</strong> ${what}${it ? ` · <button class="linkish" data-open="${it.id}">${esc(it.name)}</button>` : ""}</span>
        <span class="lr-links">${streamChip(row)}<a class="lr-link" href="${explorerTx(row.hash)}" target="_blank" rel="noopener">Check on Arc ↗</a></span>
      </div>`;
  }
  // Whether QuickNode Streams independently delivered this transaction's events from Arc.
  function streamChip(row) {
    if (!state.streamStatus || !row.hash) return "";
    const ev = state.streamed[String(row.hash).toLowerCase()];
    if (ev) return `<span class="qn-chip ok" title="Events: ${esc(ev.join(", "))}">✓ Confirmed by QuickNode Streams</span>`;
    return now() - row.at > 120 ? `<span class="qn-chip">Waiting for chain feed</span>` : "";
  }
  const agoText = (ts) => { const m = Math.max(0, Math.round((now() - ts) / 60)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const feedLine = () => state.streamStatus ? `<p class="qn-line"><span class="live"></span>Chain feed: QuickNode Streams · block ${state.streamStatus.lastBlock.toLocaleString("en-US")} · ${agoText(state.streamStatus.lastAt)} · ${plural(state.streamStatus.count, "event", "events")}</p>` : "";

  // Community → Chain feed: raw events pushed by QuickNode Streams, not our own database of app actions.
  function renderFeed() {
    const nameArg = (k, v) => (/At$/.test(k) && /^\d{9,10}$/.test(String(v)) ? fmtDate(v) : typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? nameOf(v) : /category|key/i.test(k) && /^0x[0-9a-f]{64}$/i.test(v || "") ? (catName(ethers.decodeBytes32String(v)) || v) : typeof v === "string" && /^\d{16,}$/.test(v) ? usd(BigInt(v)) : String(v));
    const argsText = (a) => Object.entries(a || {}).slice(0, 5).map(([k, v]) => `${esc(k)}: ${esc(nameArg(k, v))}`).join(" · ");
    return `
      <div class="section-head"><div><h2>Chain feed</h2><p>Raw events from the contracts, pushed by QuickNode Streams. This list doesn't come from our database of app actions.</p></div></div>
      ${feedLine()}
      <div class="panel ledger">${state.chainFeed.map((e) => `
        <div class="ledger-row">
          <span class="lr-when">Block ${e.block.toLocaleString("en-US")}<br><small>${fmtWhen(e.at)}</small></span>
          <span class="lr-what"><strong>${esc(e.event)}</strong> <small class="muted">${e.contract === "protection" ? "protection" : "marketplace"}</small><br><small>${argsText(e.args)}</small></span>
          <a class="lr-link" href="${explorerTx(e.hash)}" target="_blank" rel="noopener">Check on Arc ↗</a>
        </div>`).join("") || `<p class="muted">No events yet.</p>`}</div>`;
  }

  function renderLedger() {
    const rows = state.ledger.filter((r) => r.action !== "fund" || readOnly());
    return `
      <div class="section-head"><div><h2>Community ledger</h2><p>Every action, with proof on Arc.</p></div></div>
      ${feedLine()}
      ${tiles([[stats().members, "members"], [stats().verified, "ID-checked"], [stats().passports, "passports"], [stats().sales, "sales settled"], [usd(stats().held), "held right now"], [stats().open, "open disputes"]])}
      <div class="panel ledger">${rows.length ? rows.map(ledgerLine).join("") : `<p class="muted">Nothing yet.</p>`}</div>
      `;
  }

  function renderPeople() {
    const members = state.directory.filter((u) => u.role === "member" && memberOf(u.address));
    const shops = state.partners;
    const byInviter = {};
    for (const u of members) (byInviter[u.invitedBy || ""] ??= []).push(u);
    const row = (u, depth) => {
      const r = recOf(u.address);
      const lvl = levelOf(u.address);
      return `
        <div class="person" style="--depth:${depth}">
          ${avatar(u.name, u.handle, "avatar mini-av")}
          <span class="pn"><strong>${esc(u.name)}</strong><small>${esc(lvl.label)}${u.invitedBy ? ` · invited by ${esc(dirBy(u.invitedBy)?.name || "—")}` : " · founding member"}</small></span>
          <span class="pr">${r.sold} sold · ${r.bought} bought · ${r.disputesLost} lost${r.votesCast ? ` · ${r.votesWithMajority}/${r.votesCast} votes with majority` : ""}${r.inviteesDisputesLost ? ` · <span class="warn">${r.inviteesDisputesLost} lost by invitees</span>` : ""}${memberProt(u.address)?.fakesSold ? ` · <span class="warn">${plural(memberProt(u.address).fakesSold, "fake", "fakes")} sold</span>` : ""}</span>
          ${memberProt(u.address)?.rate ? `<span class="rate-pill" title="Protection rate on a watch they sell: ${esc(rateWords(memberProt(u.address).rate).join(", "))}">${pctTxt(memberProt(u.address).rate.feeBps)}</span>` : ""}
          ${state.isAdmin && !state.viewAs ? `<button class="btn ghost small" data-action="view-as" data-handle="${esc(u.handle)}">View as</button>` : ""}
        </div>` + (byInviter[u.handle] || []).map((c) => row(c, depth + 1)).join("");
    };
    const roots = members.filter((u) => !u.invitedBy || !members.some((m) => m.handle === u.invitedBy));
    return `
      <div class="section-head"><div><h2>Members</h2><p>${plural(members.length, "member", "members")}, grouped by who invited whom.${prot() ? " The % is each member's protection rate on a watch they sell, from their record and their inviter's." : ""}</p></div></div>
      <div class="panel people">${roots.map((u) => row(u, 0)).join("") || `<p class="muted">No members yet.</p>`}</div>
      <div class="h-label">Partner authenticators</div>
      <div class="panel people">${shops.map((p) => `
        <div class="person">${avatar(p.name, p.addr, "avatar mini-av")}<span class="pn"><strong>${esc(p.name)}</strong><small>${esc(p.city)}${p.active ? "" : " · paused"}${specialtiesOf(p.addr).map((k) => ` · ${esc(catName(k))}: ${esc(specIn(p.addr, k).credential)}`).join("")}</small></span>
          <span class="pr">${p.membersVerified} IDs checked · ${p.authenticated} pieces authenticated · ${p.reportsFiled} reports · ${p.disputesResolved} decided${shopStatsOf(p.addr) ? ` · ${usd(BigInt(shopStatsOf(p.addr).bond))} bond · ${specialtiesOf(p.addr).map((k) => `${shopStatsOf(p.addr).fakesIn?.[k] || 0} fakes in ${esc(catName(k).toLowerCase())}`).join(", ")}` : ""}</span>
          ${state.isAdmin && !state.viewAs && dirByAddr(p.addr) ? `<button class="btn ghost small" data-action="view-as" data-handle="${esc(dirByAddr(p.addr).handle)}">View as</button>` : ""}</div>`).join("") || `<p class="muted">No partners yet.</p>`}</div>`;
  }

  // Community → Protection: the pool members fund, what it stands behind, and every protected sale.
  function renderProtection() {
    const p = prot();
    const pool = p.pool;
    const dis = state.busy || readOnly() ? "disabled" : "";
    const me = viewer();
    const mine = me ? memberProt(me.address) : null;
    const isMember = me?.role === "member";
    const label = { pending: "Waiting for delivery", active: "Active", claimed: "Claim under review", paid: "Fake: refunded", rejected: "Claim rejected", expired: "Ended, no claim", void: "Sale cancelled, fee refunded" };
    const rows = p.covers.slice().reverse().map((c) => {
      const it = itemById(c.itemId);
      return `<button class="done" data-open="${c.itemId}">${it ? art(it, "mini") : ""}<span><strong>${esc(it?.name || "Piece")}</strong><small>${esc(nameOf(c.buyer))} from ${esc(nameOf(c.seller))} · stamped by ${esc(nameOf(c.shop))} · fee ${usd(BigInt(c.fee))} (${pctTxt(c.feeBps)})</small></span><span class="chip ${c.state === "paid" ? "bad" : c.state === "active" || c.state === "pending" ? "ok" : "owned"}">${label[c.state]}</span></button>`;
    });
    return `
      <div class="section-head"><div><h2>Protection</h2><p>Members fund the pool that stands behind protected purchases, and earn the fees.</p></div></div>
      ${tiles([[usd(BigInt(pool.assets)), "in the pool"], [usd(BigInt(pool.locked)), "behind live protection"], [usd(BigInt(pool.fees)), "fees earned"], [usd(BigInt(pool.paid)), "paid out on fakes"], [usd(totalBonds()), "staked by authenticators"], [p.covers.length, "purchases protected"]])}
      <div class="panel">
        <h3 style="margin-top:0">How a claim is paid</h3>
        <p class="fine" style="margin-top:0">On a $100 piece: the authenticator's bond pays the first $50 and the pool pays $50, so the buyer gets the full price back. The second specialist who re-inspected it earns $2 from the bond. If the piece is genuine, the buyer's 5% claim deposit pays the reviewer and the rest goes to the pool.</p>
        ${isMember && !readOnly() ? `
        <div class="h-label">Your stake</div>
        ${tiles([[usd(BigInt(mine?.value ?? 0)), "your stake is worth"]])}
        <div class="row bond-row">
          <div class="money-input"><span>$</span><input id="pool-amt" type="number" min="0.01" step="0.01" placeholder="Amount" ${dis}></div>
          <button class="btn gold" data-action="pool-deposit" ${dis}>Add to the pool</button>
          <button class="btn ghost" data-action="pool-withdraw" ${dis}>Withdraw</button>
        </div>
        <p class="hint">Fees raise the value of every stake. Money held behind live protection can't be withdrawn until those 90 days end. This is community protection on test dollars, not a licensed product.</p>` : isMember ? tiles([[usd(BigInt(mine?.value ?? 0)), `${esc(me.name)}'s stake`]]) : ""}
      </div>
      <div class="h-label">How the price is set</div>
      <div class="panel rate-table">
        <div class="why-row"><span><b>Category base</b><small>${p.categories.filter((c) => c.active).map((c) => `${esc(c.name)} ${pctTxt(c.baseBps)}`).join(" · ")}</small></span></div>
        <div class="why-row"><span><b>Seller</b><small>New seller +2% · each completed sale −0.25% (up to −1.5%) · each dispute lost +3% · each refund +1% · each proven fake +5%</small></span></div>
        <div class="why-row"><span><b>Who invited the seller</b><small>+1% for each dispute lost by anyone they invited, up to +3%</small></span></div>
        <div class="why-row"><span><b>Authenticator</b><small>+4% for each fake it stamped in this category · −0.5% with 10+ stamps and no fakes</small></span></div>
        <p class="fine">The total is kept between 1% and 20% of the price. The contract on Arc calculates it.</p>
      </div>
      <div class="h-label">Protected purchases</div>
      ${rows.length ? `<div class="done-list">${rows.join("")}</div>` : `<div class="empty slim"><p>No protected purchases yet.</p></div>`}`;
  }

  function renderCommunityDisputes() {
    const mine = myPanelDuty();
    const open = openDisputes().filter((d) => !mine.includes(d));
    const closed = state.disputes.filter((d) => d.resolved).reverse();
    let html = `<div class="section-head"><div><h2>Disputes</h2><p>Five random members decide. The contract pays out.</p></div></div>`;
    if (mine.length) html += `<div class="h-label">You're on the panel</div>` + mine.map((d) => disputeCard(d)).join("");
    html += `<div class="h-label">Open</div>` + (open.length ? open.map((d) => disputeCard(d)).join("") : `<div class="empty slim"><p>No open disputes.</p></div>`);
    if (closed.length) html += `<div class="h-label">Decided</div>` + closed.map((d) => disputeCard(d)).join("");
    return html;
  }

  function renderInvite() {
    const me = state.me;
    if (!me || readOnly()) {
      const v = viewer();
      return `<div class="section-head"><div><h2>Invites & credits</h2><p>Each member's invites and credits are private to them.</p></div></div>${v && v.role === "member" ? memberCard(v) : ""}`;
    }
    if (me.role !== "member") return `<div class="empty"><h3>Invites are for members</h3><p>Authenticators don't invite members; they check IDs at the front desk.</p></div>`;
    const a = me.allowance || { left: 0, total: 0, used: 0 };
    const credits = me.credits || [];
    return `
      <div class="section-head"><div><h2>Invites & credits</h2><p>Invite people you'd trade with.</p></div>
        <button class="btn gold" data-action="new-invite" ${a.left > 0 && !state.busy ? "" : "disabled"}>+ New invite link</button></div>
      ${tiles([[a.left, "invites left"], [a.used, "sent"], [credits.filter((c) => !c.usedAt).reduce((s, c) => s + c.dollars, 0).toLocaleString("en-US", { style: "currency", currency: "USD" }), "credit available"]])}
      <p class="fine">Earn an invite for each clean sale. Their disputes show on your record.</p>
      <div class="h-label">Your invite links</div>
      ${me.invites.length ? `<div class="done-list">${me.invites.map((i) => `
        <div class="done static"><span class="inv-ico">✉</span><span><strong>${i.usedBy ? `Used by ${esc(i.usedBy)}` : "Not used yet"}</strong><small class="mono-inline">${esc(inviteUrl(i.code))}</small></span>
          <span>${i.usedBy ? `<span class="chip ok">Joined</span>` : `<button class="btn ghost small" data-action="copy-invite" data-code="${esc(i.code)}">Copy link</button>`}</span></div>`).join("")}</div>` : `<div class="empty slim"><p>No invites yet. Create one and send it to someone you'd trade with.</p></div>`}
      <div class="h-label">Credits</div>
      ${credits.length ? `<div class="done-list">${credits.map((c) => `
        <div class="done static"><span class="inv-ico">★</span><span><strong>${c.kind === "welcome_shipping" ? "Welcome: free first delivery" : "Invite reward"}</strong><small>${esc(c.note || "")} · ${c.usedAt ? "used" : `expires ${fmtDate(new Date(c.expiresAt).getTime() / 1000)}`}</small></span><span class="done-amt plus">$${c.dollars.toFixed(2)}</span></div>`).join("")}</div>` : `<div class="empty slim"><p>No credits yet. You earn $${CFG.rules?.inviterReward ?? 5} when someone you invited completes their first purchase.</p></div>`}
      <div class="h-label">Your member card</div>
      ${memberCard(me)}`;
  }

  // ------------------------------------------------------------------ admin
  function renderAdmin() {
    const s = stats();
    const treasury = state.directory.find((u) => u.role === "treasury");
    const dis = state.busy ? "disabled" : "";
    if (state.tab === "members") return renderPeople();
    if (state.tab === "specialists") return renderSpecialists();
    if (state.tab === "setup") {
      const shop = state.directory.find((u) => u.handle === "shop");
      const seeded = state.directory.filter((u) => u.seeded).length;
      const check = (ok, text) => `<li class="${ok ? "ok" : ""}"><span>${ok ? "✓" : "○"}</span>${text}</li>`;
      return `
        <div class="section-head"><div><h2>Setup</h2><p>One-time steps to get the community ready for the demo.</p></div></div>
        <div class="panel"><ul class="checklist">
          ${check(!!state.admin && same(state.admin, state.adminAddress), `You're signed in with the contract's admin wallet ${short(state.adminAddress)}`)}
          ${check(!!(shop && partnerOf(shop.address)), `Demo Pawn Shop approved as a partner (addPartner)`)}
          ${check(["maya", "alex"].every((h) => dirBy(h) && isVerified(dirBy(h).address)), "Maya and Alex are members with their IDs checked")}
          ${check(seeded >= 10, `Community members added: ${seeded} of 10`)}
          ${check(state.ledger.some((r) => r.action === "vote"), "Demo history played: sales, listings and a dispute decided by a member panel")}
          ${CFG.protectionAddress ? `
          ${check(!!prot(), `Protection contract connected ${short(CFG.protectionAddress)}`)}
          ${check(specPlanDone(), `Specialists approved (Admin → Specialists)`)}
          ${check(!!prot() && prot().covers.some((c) => c.state === "paid"), "Protection demo played: bonds, the pool, a fake refunded and a claim rejected")}` : `<li><span>○</span>Protection is off. Deploy WardrobeProtection and set PROTECTION_ADDRESS on Vercel to switch it on.</li>`}
        </ul>
        <div class="row">
          <button class="btn gold" data-action="admin-setup" ${dis}>Set up demo accounts</button>
          <button class="btn primary" data-action="admin-seed" ${dis}>Add community members</button>
          <button class="btn ghost" data-action="admin-history" ${dis}>Play demo history</button>
          ${prot() ? `<button class="btn gold" data-action="admin-protection" ${dis}>Play protection demo</button>` : ""}
        </div>
        <p class="fine">The platform wallet must be approved once with setOperator (done in Remix). The treasury pays network fees and gives each new member a little test money: it holds ${treasury ? usd(balanceOf(treasury.address)) : "—"}. Refill it from <a href="${CFG.faucet}" target="_blank" rel="noopener">Circle's faucet</a> at <span class="mono-inline">${esc(treasury?.address || "")}</span>.</p></div>`;
    }
    if (state.tab === "side") return renderSideBySide();
    return `
      <div class="section-head"><div><h2>Admin overview</h2><p>The whole community at a glance.</p></div></div>
      ${tiles([[s.members, "members"], [s.verified, "ID-checked"], [state.partners.length, "authenticators"], [s.passports, "passports"], [state.items.filter((i) => i.status === STATUS.LISTED).length, "for sale"], [usd(s.volume), `volume in ${plural(s.sales, "sale", "sales")}`], [usd(s.held), "held in the contract"], [s.open, "open disputes"],
        ...(state.streamStatus ? [[state.streamStatus.count, "events streamed"]] : []),
        ...(prot() ? [[usd(totalBonds()), "staked in bonds"], [usd(BigInt(prot().pool.assets)), "in the protection pool"], [prot().covers.length, "purchases protected"], [prot().covers.filter((c) => c.state === "claimed").length, "claims open"]] : [])])}
      <div class="h-label">Open disputes</div>
      ${openDisputes().length ? openDisputes().map((d) => disputeCard(d, "admin")).join("") : `<div class="empty slim"><p>No open disputes.</p></div>`}
      <div class="h-label">Latest activity</div>
      <div class="panel ledger">${state.ledger.slice(0, 12).map(ledgerLine).join("") || `<p class="muted">Nothing yet.</p>`}</div>`;
  }

  const planShop = (h) => dirBy(h);
  const specPlanDone = () => !!prot() && (CFG.specialistPlan || []).every((x) => planShop(x.shop) && specIn(planShop(x.shop).address, x.category));
  // Admin → Specialists: approve which authenticator may certify which category. These are
  // admin transactions on the contracts, so they're signed with the admin's MetaMask.
  function renderSpecialists() {
    const dis = state.busy ? "disabled" : "";
    if (!CFG.protectionAddress) return `<div class="section-head"><div><h2>Specialists</h2></div></div><div class="empty"><h3>Protection is off</h3><p>Deploy WardrobeProtection in Remix, then set PROTECTION_ADDRESS on Vercel and redeploy.</p></div>`;
    const shop2 = dirBy("shop2");
    const s2ok = shop2 && partnerOf(shop2.address);
    const rows = (CFG.specialistPlan || []).map((x, i) => {
      const u = planShop(x.shop);
      const ok = u && specIn(u.address, x.category);
      return `<div class="person"><span class="pn"><strong>${esc(u?.name || x.shop)} · ${esc(catName(x.category))}</strong><small>${esc(x.credential)}</small></span>
        <span>${ok ? `<span class="chip ok">Approved</span>` : u && partnerOf(u.address) ? `<button class="btn gold small" data-action="approve-spec" data-plan="${i}" ${dis}>Approve with MetaMask</button>` : `<span class="chip owned">Approve the partner first</span>`}</span></div>`;
    }).join("");
    return `
      <div class="section-head"><div><h2>Specialists</h2><p>Only a specialist can certify a piece for protection, and only a second specialist in the same category can rule on a claim.</p></div></div>
      <div class="panel">
        <ul class="checklist">
          <li class="${s2ok ? "ok" : ""}"><span>${s2ok ? "✓" : "○"}</span>Second Opinion Jewelers is a partner on the marketplace contract${shop2 ? ` <span class="mono-inline">${esc(shop2.address)}</span>` : " (run Set up demo accounts first)"}</li>
        </ul>
        ${!s2ok && shop2 ? `<div class="row"><button class="btn gold" data-action="approve-shop2" ${dis}>Approve as a partner with MetaMask</button></div><p class="fine">Or in Remix, on WardrobePassportV3: addPartner(${esc(shop2.address)}, "Second Opinion Jewelers", "Atlanta").</p>` : ""}
      </div>
      <div class="h-label">Approvals</div>
      <div class="panel people">${rows}</div>
      <p class="fine">Each approval is one transaction from the admin wallet to the protection contract ${short(CFG.protectionAddress)} (setSpecialist). MetaMask must be on Arc Testnet.</p>`;
  }

  function renderSideBySide() {
    const col = (title, sub, rows) => `<div class="sbs-col"><h3>${title}</h3><p class="fine">${sub}</p>${rows.length ? rows.join("") : `<p class="muted">Nothing here.</p>`}</div>`;
    const line = (i, text, who) => `<div class="sbs-item"><button class="sbs-open" data-open="${i.id}">${art(i, "mini")}<span><strong>${esc(i.name)}</strong><small>${text}</small></span></button>${who ? `<button class="linkish" data-action="view-as" data-handle="${esc(who)}">view as</button>` : ""}</div>`;
    const h = (addr) => dirByAddr(addr)?.handle;
    const sellers = [];
    for (const i of state.items) {
      if (i.status === STATUS.OWNED && authStage(i) === "pending") sellers.push(line(i, `${esc(nameOf(i.owner))} · waiting for authentication`, h(i.owner)));
      else if (i.status === STATUS.LISTED) sellers.push(line(i, `${esc(nameOf(i.owner))} · listed ${usd(i.price)}${paused(i) ? " · paused" : ""}`, h(i.owner)));
      else if (i.status === STATUS.PAID) sellers.push(line(i, `${esc(nameOf(i.owner))} · paid, must ship`, h(i.owner)));
      else if (i.status === STATUS.SHIPPED) sellers.push(line(i, `${esc(nameOf(i.owner))} · shipped, waiting for buyer`, h(i.owner)));
    }
    const buyers = state.items.filter((i) => IN_SALE.includes(i.status)).map((i) =>
      line(i, `${esc(nameOf(i.buyer))} · ${i.status === STATUS.PAID ? "paid, waiting for shipping" : i.status === STATUS.SHIPPED ? "on its way: confirm or dispute" : "disputed: panel voting"}`, h(i.buyer)));
    const shops = [];
    for (const p of state.partners) {
      const reqs = state.items.filter((i) => { const r = reqOf(i.id); return r && r.status === "pending" && same(r.partner, p.addr) && i.status === STATUS.OWNED && !verified(i); });
      shops.push(`<div class="sbs-shop"><strong>${esc(p.name)}</strong><small>${unverifiedMembers().length} IDs to check · ${reqs.length} pieces to verify · ${openDisputes().filter((d) => same(d.partner, p.addr)).length} disputes · ${state.items.filter((i) => i.status === STATUS.LISTED && flagsOf(i.id).count && same(i.partner, p.addr)).length} flagged</small>${dirByAddr(p.addr) ? `<button class="linkish" data-action="view-as" data-handle="${esc(dirByAddr(p.addr).handle)}">view as</button>` : ""}</div>`);
      for (const i of reqs) shops.push(line(i, `${esc(nameOf(i.owner))} asked ${esc(p.name)} to authenticate`, null));
    }
    return `
      <div class="section-head"><div><h2>Side by side</h2><p>Every live piece, from each side.</p></div></div>
      <div class="sbs">${col("Sellers", "Pieces on their way to a sale", sellers)}${col("Buyers", "Orders in progress", buyers)}${col("Authenticators", "Queues waiting for each authenticator", shops)}</div>`;
  }

  function renderFoot() {
    $("#foot").innerHTML = `
      <span class="live ${state.online ? "" : "down"}">${state.online ? `Live on ${esc(CFG.chainName)}` : "Reconnecting to Arc…"}</span><span>·</span>
      <a href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">Contract ${short(CFG.contractAddress)} ↗</a><span>·</span>
      <button class="linkish foot-link" data-action="how">How it works</button><span>·</span>
      <span>${CFG.walletProvider === "circle" ? "Wallets by Circle · " : ""}Test dollars on Arc Testnet</span>`;
  }

  function render() {
    document.body.classList.toggle("public", !!state.publicId);
    renderWho();
    renderSearch();
    renderViewbar();
    renderTabs();
    renderFoot();
    const view = $("#view");
    if (state.fatal) {
      $("#hero").innerHTML = "";
      view.dataset.sig = ""; view.innerHTML = `<div class="empty"><h3>Can't connect</h3><p>${esc(state.fatal)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
      return;
    }
    if (state.inviteCode) { $("#hero").innerHTML = ""; const h = renderJoin(); if (view.dataset.sig !== h) { view.innerHTML = h; view.dataset.sig = h; } mountJoin(); return; }
    if (!state.loaded) { view.dataset.sig = ""; view.innerHTML = `<div class="loading"><div class="spinner"></div>Connecting to Arc…</div>`; return; }
    if (state.publicId) { $("#hero").innerHTML = ""; const h = renderPublic(state.publicId); if (view.dataset.sig !== h) { view.innerHTML = h; view.dataset.sig = h; } return; }
    renderHero();
    document.body.classList.toggle("signed-out", !signedIn());
    if (!signedIn()) {
      const html = renderLanding();
      const typing = view.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
      if (view.dataset.sig !== html && !typing) { view.innerHTML = html; view.dataset.sig = html; }
      return;
    }
    const R = {
      home: renderSellerHome, pieces: renderPieces, sales: () => renderOrders("selling"),
      shop: renderShop, orders: () => renderOrders("buying"), mine: renderMine,
      front: renderDesk, requests: renderDesk, sdisputes: renderDesk, record: renderDesk,
      ledger: renderLedger, feed: renderFeed, people: renderPeople, disputes: renderCommunityDisputes, invite: renderInvite, protection: renderProtection,
      bond: renderDesk, opinions: renderDesk,
      overview: renderAdmin, side: renderAdmin, members: renderAdmin, setup: renderAdmin, specialists: renderAdmin,
    };
    const scroll = window.scrollY;
    const html = (R[state.tab] || (() => ""))();
    const typing = view.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (view.dataset.sig !== html && !typing) { view.innerHTML = html; view.dataset.sig = html; window.scrollTo(0, scroll); }
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
      default: return "With its owner";
    }
  }
  function timelineHtml(item) {
    const h = state.histories[item.id] || [];
    const rows = h.map((t) => ({ at: t.at, html: isZero(t.from)
      ? `<li><div class="t-main">Passport issued to ${esc(nameOf(t.to))}</div><div class="t-sub">${fmtDate(t.at)}</div></li>`
      : `<li><div class="t-main">${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} for ${usd(t.price)}</div><div class="t-sub">${fmtDate(t.at)} · sale settled, payment released</div></li>` }));
    if (!isZero(item.authBy)) rows.push({ at: item.authAt, html: `<li class="t-auth"><div class="t-main">Authenticated by ${esc(nameOf(item.authBy))}</div><div class="t-sub">${fmtDate(item.authAt)}${item.authNote ? ` · “${esc(item.authNote)}”` : ""}</div></li>` });
    if (prot()) {
      if (certified(item)) rows.push({ at: item.authAt + 1, html: `<li class="t-auth"><div class="t-main">Certified as ${esc(catName(prot().categoryOf[item.id]).toLowerCase())} by a specialist</div><div class="t-sub">Can be protected for 90 days after delivery</div></li>` });
      for (const c of coversOf(item)) {
        rows.push({ at: c.boughtAt, html: `<li><div class="t-main">${esc(nameOf(c.buyer))} added 90-day protection for ${usd(BigInt(c.fee))}</div><div class="t-sub">${fmtDate(c.boughtAt)} · ${pctTxt(c.feeBps)} · backed by ${esc(nameOf(c.shop))}'s bond and the members' pool</div></li>` });
        if (c.state === "paid") rows.push({ at: c.claimedAt, html: `<li class="t-dispute"><div class="t-main">Proven fake by ${esc(nameOf(c.reviewer))}. ${esc(nameOf(c.buyer))} was refunded ${usd(BigInt(c.amount))}</div><div class="t-sub">${fmtDate(c.claimedAt)} · “${esc(c.ruling)}”</div></li>` });
        if (c.state === "rejected") rows.push({ at: c.claimedAt, html: `<li><div class="t-main">Claim checked by ${esc(nameOf(c.reviewer))}: genuine</div><div class="t-sub">${fmtDate(c.claimedAt)} · “${esc(c.ruling)}”</div></li>` });
      }
    }
    for (const d of state.disputes.filter((x) => x.itemId === item.id && x.resolved)) {
      rows.push({ at: d.openedAt, html: `<li class="t-dispute"><div class="t-main">Dispute #${d.id}: ${d.buyerWon ? "buyer" : "seller"} won</div><div class="t-sub">${fmtDate(d.openedAt)} · decided by ${d.decidedByPanel ? "a member panel" : esc(nameOf(d.partner))}</div></li>` });
    }
    rows.sort((a, b) => a.at - b.at);
    return rows.length ? rows.map((r) => r.html).join("") : `<li><div class="t-sub">No history yet.</div></li>`;
  }
  function authLine(item) {
    if (isZero(item.authBy)) return `<div class="callout info">Not yet authenticated. It can't be listed for sale until a partner authenticator has checked it in person.</div>`;
    const p = partnerOf(item.authBy);
    const who = `${esc(nameOf(item.authBy))}${p ? `, ${esc(p.city)}` : ""}`;
    if (!verified(item)) return `<div class="callout info">Authenticated by ${who} on ${fmtDate(item.authAt)}, before it last changed hands. It needs a fresh check before it can be sold again.</div>`;
    return `<div class="callout ok"><strong>✓ Authenticated in person by ${who}</strong> on ${fmtDate(item.authAt)}.${item.authNote ? ` “${esc(item.authNote)}”` : ""}</div>`;
  }
  function renderPublic(id) {
    const item = itemById(id);
    if (!item) return `<div class="empty"><h3>Passport #${esc(id)} not found</h3><p>Check the link, or open the app.</p><button class="btn primary" data-action="leave-public">Open the app</button></div>`;
    const f = facts(item);
    const url = passportUrl(id);
    return `
      <div class="pp">
        <button class="linkish back" data-action="leave-public">← Back to the app</button>
        <article class="cert">
          <div class="cert-top"><span class="cert-kicker">Digital product passport</span><span class="cert-no">No. ${pad(id)}</span></div>
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
        ${item.status === STATUS.LISTED && !paused(item) ? `<div class="callout info pp-cta"><span>This piece is for sale for <strong>${usd(item.price)}</strong> to community members, authenticated by ${esc(nameOf(item.partner))}.</span><button class="btn gold" data-action="public-buy" data-id="${id}">Open in the app</button></div>` : ""}
      </div>`;
  }

  async function route() {
    document.querySelectorAll("#toast-root .toast:not(.pending)").forEach((t) => t.remove());
    const m = /^#passport=(\d+)$/.exec(location.hash);
    state.publicId = m ? Number(m[1]) : null;
    const inv = /^#invite=([A-Za-z0-9_-]+)$/.exec(location.hash);
    state.inviteCode = inv ? inv[1] : null;
    state.invite = null;
    closeModal();
    render();
    window.scrollTo(0, 0);
    if (state.inviteCode) {
      try { state.invite = await api("/api/auth", { op: "check-invite", code: state.inviteCode }); }
      catch (e) { state.invite = { error: friendlyError(e) }; }
      render();
    }
  }
  window.addEventListener("hashchange", route);
  function clearHash() { history.pushState("", document.title, location.pathname + location.search); route(); }

  function mountJoin() {
    const f = $("#join-form");
    if (!f || f.dataset.mounted) return;
    f.dataset.mounted = "1";
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const err = $("#j-error");
      const name = $("#j-name").value.trim(), email = $("#j-email").value.trim();
      if (name.length < 2) { err.textContent = "Please enter your name."; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = "Please enter a valid email."; return; }
      err.textContent = "";
      state.busy = true;
      f.querySelector("button[type=submit]").disabled = true;
      const t = toast("Creating your wallet and adding you to the community on Arc. This takes about 20 seconds…", "pending");
      try {
        await api("/api/auth", { op: "join", code: state.inviteCode, name, email });
        updateToast(t, `Welcome, ${name}! You're a member. Your first delivery is free.`, "ok");
        history.pushState("", document.title, location.pathname + location.search);
        state.inviteCode = null;
        await afterSignIn();
      } catch (e) {
        updateToast(t, friendlyError(e), "error");
        err.textContent = friendlyError(e);
        f.querySelector("button[type=submit]").disabled = false;
      } finally { state.busy = false; }
    });
  }

  async function afterSignIn() {
    state.view = null; state.tab = null; state.viewAs = null;
    state.signin = { email: "", sent: false, demoCode: null };
    await connect();
    await refresh();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ item detail
  function openDetail(id) {
    const item = itemById(id);
    if (!item) return;
    const f = facts(item);
    const shop = partnerOf(item.authBy);
    openModal(item.name, `
      <div class="listing">
        <div class="listing-photo">${art(item)}</div>
        <div class="listing-side">
          <p class="pid-line">Passport No. ${pad(item.id)} · <a href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">on Arc ↗</a></p>
          <h4 class="detail-title">${esc(item.name)}</h4>
          <p class="detail-brand">${esc(item.brand || "No brand")}${item.details ? `, ${esc(item.details)}` : ""}</p>
          ${verified(item) ? `<div class="trust"><span class="ti">✓</span><span><b>Checked in person${catOf(item) && specIn(item.authBy, catOf(item)) ? ` by a ${esc(catName(catOf(item)).toLowerCase())} specialist` : ""}</b><small>${esc(shop ? `${shop.name}, ${shop.city}` : nameOf(item.authBy))} · ${fmtDate(item.authAt)}${catOf(item) && specIn(item.authBy, catOf(item)) ? ` · ${esc(specIn(item.authBy, catOf(item)).credential)}` : ""}</small></span></div>` : authLine(item)}
          ${bondBacked(item) ? `<div class="trust"><span class="ti bond-ti">$</span><span><b>Bond-backed</b><small>${esc(nameOf(item.authBy))} has ${usd(BigInt(shopStatsOf(item.authBy).free))} staked and free to stand behind its stamps. If this piece turns out fake, the bond pays first.</small></span></div>` : ""}
          <div class="trust"><span class="ti">${esc((nameOf(item.owner) || "?")[0])}</span><span><b>${esc(nameOf(item.owner))}</b><small>${esc(levelOf(item.owner).label)} · ${esc(recText(item.owner))}</small></span></div>
          <div class="pricebox">
            <div class="pb-top"><span class="pb-price">${item.status === STATUS.LISTED ? usd(item.price) : f.lastSale ? usd(f.lastSale.price) : "Not for sale"}</span><small data-status></small></div>
            <div data-actions></div>
            <div data-protect></div>
          </div>
          <button class="linkish share-link" data-action="share" data-id="${item.id}">Share this passport</button>
        </div>
      </div>
      <h3 class="grid-h">History</h3>
      <ul class="timeline">${timelineHtml(item)}</ul>
    `, (m) => m.classList.add("wide"));
    state.openItemId = id;
    refreshDetailActions();
  }

  /** Authenticators to ask: with protection on, only specialists in the piece's category, with their credential and record there. */
  function partnerSelect(id, cat) {
    let list = activePartners().filter((p) => !same(p.addr, myAddr()));
    if (prot() && cat) list = list.filter((p) => specIn(p.addr, cat));
    if (!list.length) return "";
    const label = (p) => {
      if (!prot() || !cat) return `${p.name} · ${p.city}`;
      const fakes = shopStatsOf(p.addr)?.fakesIn?.[cat] || 0;
      return `${p.name} · ${specIn(p.addr, cat).credential} · ${fakes ? plural(fakes, "fake", "fakes") : "no fakes"} in ${catName(cat).toLowerCase()}`;
    };
    return `<select id="${id}" class="select">${list.map((p) => `<option value="${esc(p.addr)}">${esc(label(p))}</option>`).join("")}</select>`;
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
    const dis = state.busy || readOnly() ? "disabled" : "";
    const v = viewer();
    statusEl.textContent = item.status === STATUS.LISTED ? (paused(item) ? "Paused for review" : "Paid on delivery") : statusText(item);
    let html = "";
    if (!signedIn()) {
      html = item.status === STATUS.LISTED && !paused(item)
        ? `<button class="btn gold block" data-action="open-signin">Sign in to buy</button><p class="hint center">Members only. Your money is held until it arrives.</p>`
        : "";
    } else if (v?.role === "partner") {
      const r = reqOf(item.id);
      if (r && r.status === "pending" && same(r.partner, myAddr()) && !isOwner && partnerOf(myAddr())) {
        html = `<div class="actions-col"><button class="btn gold block" data-action="auth" data-id="${item.id}" ${dis}>Authenticate this piece</button><button class="btn ghost block" data-action="decline" data-id="${item.id}" ${dis}>Can't verify</button></div>`;
      }
    } else if (isOwner && item.status === STATUS.OWNED && v?.role === "member") {
      const st = authStage(item);
      if (st === "verified" && !isVerified(myAddr())) {
        html = `<div class="callout held"><strong>Authenticated. One more step to list it:</strong> get your ID checked at a partner authenticator. Show your member code <span class="mono-inline">${esc(v.handle)}</span> and a photo ID.</div>`;
      } else if (st === "verified") {
        html = `
        <div class="field">
          <label for="list-price">Sell this piece</label>
          <div class="row"><div class="money-input"><span>$</span><input id="list-price" type="number" min="0.01" step="0.01" placeholder="Price, e.g. 8"></div><button class="btn gold" data-action="list" data-id="${item.id}" ${dis}>List for sale</button></div>
          <span class="hint">${esc(nameOf(item.authBy))} authenticated this piece and stands behind the sale.</span>
          <span class="hint" data-deposit-hint>${depositHint("")}</span>
        </div>`;
      } else if (st === "pending") {
        html = `<div class="callout held"><strong>Waiting for ${esc(nameOf(reqOf(item.id).partner))}.</strong><br>Take the piece to them. Once they've checked it and stamped its passport, you can list it.</div><button class="btn ghost block" data-action="cancel-auth" data-id="${item.id}" ${dis}>Cancel the request</button>`;
      } else {
        const sel = partnerSelect("auth-partner", catOf(item));
        const r = reqOf(item.id);
        html = (st === "declined" ? `<div class="callout bad"><strong>${esc(nameOf(r.partner))} couldn't verify this piece.</strong>${r.note ? `<br>“${esc(r.note)}”` : ""}</div>` : "") + (sel ? `
        <div class="field"><label for="auth-partner">Step 1: get it authenticated${catOf(item) ? ` by a ${esc(catName(catOf(item)).toLowerCase())} specialist` : ""}</label>${sel}<span class="hint">They check the piece in person and stamp its passport. After that you can list it.</span></div>
        <button class="btn gold block" data-action="request-auth" data-id="${item.id}" ${dis}>Request authentication</button>` : `<div class="callout info">No authenticator is approved for ${catOf(item) ? esc(catName(catOf(item)).toLowerCase()) : "this"} yet, so this piece can't be verified or listed.</div>`);
      }
    } else if (isOwner && item.status === STATUS.LISTED) {
      html = `<div class="callout info">Listed for <strong>${usd(item.price)}</strong>, authenticated by ${esc(nameOf(item.partner))}. Your ${usd(item.deposit)} deposit is locked.${paused(item) ? `<br><strong>Paused:</strong> ${plural(flagsOf(item.id).count, "member flagged", "members flagged")} it. The authenticator will review.` : ""}</div><button class="btn ghost block" data-action="unlist" data-id="${item.id}" ${dis}>Take it off sale and get the deposit back</button>`;
    } else if ((isOwner || isBuyer) && IN_SALE.includes(item.status)) {
      const b = saleBlock(item);
      html = `<div class="callout ${b.bad ? "bad" : "held"}"><strong>${b.chip}</strong><br>${b.note}</div><div class="actions-col">${b.actions.replace(/class="btn /g, 'class="btn block ')}</div>`;
    } else if (v?.role === "member" && item.status === STATUS.LISTED) {
      const fl = flagsOf(item.id);
      html = (paused(item) ? `<div class="callout bad">This listing is paused while the authenticator reviews flags from members.</div>` : `<button class="btn gold block" data-action="buy" data-id="${item.id}" ${dis}>Buy for ${usd(item.price)}</button>`) +
        `<button class="linkish flag-link" data-action="${fl.mine ? "unflag" : "flag"}" data-id="${item.id}" ${dis}>${fl.mine ? "Remove my flag" : "Flag this listing as suspicious"}</button>${fl.count ? `<span class="hint"> · ${plural(fl.count, "flag", "flags")} so far</span>` : ""}`;
    } else if (isOwner) {
      html = `<div class="callout ok">This piece is yours. Its passport names you as the owner.</div>`;
    } else if (IN_SALE.includes(item.status)) {
      html = `<div class="callout info">Someone has already paid for this piece.</div>`;
    }
    if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
    const pbox = $("[data-protect]");
    if (pbox) {
      const q = quoteOf(item);
      let ph = "";
      if (q && item.status === STATUS.LISTED) {
        ph = q.available
          ? `<div class="prot-quote"><span class="shield" aria-hidden="true">🛡</span><span><b>Add 90-day protection: ${usd(q.fee)}</b><small>${pctTxt(q.feeBps)} of the price, offered after you pay. If a second specialist finds it's fake within 90 days of delivery, you get the full price back.</small></span></div>${whyPriceHtml(item, q)}`
          : `<p class="hint">${certified(item) ? "Protection isn't available on this piece right now." : "Not certified by a specialist, so it can't be protected."}</p>`;
      } else if (isBuyer || (isOwner && coverFor(item, myAddr()))) {
        ph = coverBlock(item);
        if (q && isBuyer && [STATUS.PAID, STATUS.SHIPPED].includes(item.status) && !coverFor(item, myAddr())) ph += whyPriceHtml(item, q);
      }
      if (pbox.dataset.sig !== ph) { const open = pbox.querySelector("details")?.open; pbox.innerHTML = ph; pbox.dataset.sig = ph; if (open && pbox.querySelector("details")) pbox.querySelector("details").open = true; }
    }
  }

  document.addEventListener("input", (ev) => {
    if (ev.target.id === "list-price") { const hint = document.querySelector("[data-deposit-hint]"); if (hint) hint.textContent = depositHint(ev.target.value); }
    if (ev.target.id === "si-email") state.signin.email = ev.target.value;
    if (ev.target.id === "q") {
      state.q = ev.target.value;
      if (signedIn() && state.view !== "buy" && viewsFor().includes("buy")) { state.view = "buy"; state.tab = "shop"; }
      render();
    }
  });

  // ------------------------------------------------------------ photos
  async function compressPhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("unreadable")); i.src = url; });
      const W = img.naturalWidth, H = img.naturalHeight;
      let sw = W, sh = Math.round(W * 3 / 4);
      if (sh > H) { sh = H; sw = Math.round(H * 4 / 3); }
      const sx = Math.round((W - sw) / 2), sy = Math.round((H - sh) / 2);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      for (const [w, q] of [[1000, 0.82], [800, 0.78], [640, 0.72], [480, 0.66]]) {
        canvas.width = w; canvas.height = Math.round(w * 3 / 4);
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        if (w > sw) { canvas.width = sw; canvas.height = sh; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, sw, sh); ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh); }
        const data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= MAX_PHOTO_CHARS) return data;
      }
      throw new Error("too detailed");
    } finally { URL.revokeObjectURL(url); }
  }

  // -------------------------------------------------------------- add item
  function openAddItem() {
    const cats = (CFG.categories || []).filter((c) => !prot() || prot().categories.some((x) => x.key === c.key && x.active));
    const picks = cats.map((c, idx) => `
      <div><input type="radio" name="cat" id="cat-${c.key}" value="${c.key}" data-icon="${c.icon}" ${idx === 0 ? "checked" : ""}><label for="cat-${c.key}"><svg viewBox="0 0 64 64">${ICONS[c.icon].svg}</svg>${esc(c.name)}</label></div>`).join("");
    const samples = SAMPLES.map((s, i) => `<button type="button" class="sample" data-sample="${i}">${esc(s.name)}</button>`).join("");
    const sel = partnerSelect("f-partner", cats[0]?.key);
    let photoData = "";
    openModal("Add a piece", `
      <form id="add-form" novalidate>
        <div class="samples"><span>Quick fill:</span>${samples}</div>
        <div class="field"><label>Category</label><div class="icon-pick">${picks}</div><span class="hint">A specialist in this category authenticates it. The category also sets the base protection rate.</span></div>
        <div class="field"><label for="f-name">What is it?</label><input id="f-name" type="text" maxlength="60" placeholder="e.g. Steel dive watch" required></div>
        <div class="row">
          <div class="field"><label for="f-brand">Brand</label><input id="f-brand" type="text" maxlength="40" placeholder="e.g. Seiko"></div>
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
        <label class="check"><input id="f-sell" type="checkbox" ${sel ? "checked" : ""}> Ask a specialist to authenticate it now</label>
        <div class="field" id="f-price-wrap" ${sel ? "" : "hidden"}><label for="f-partner" class="sub-label">Authenticator</label><span id="f-partner-wrap">${sel || `<span class="hint">No specialist is approved for this category yet.</span>`}</span><span class="hint">They check the piece in person. Once it's stamped, you can list it.</span></div>
        <p class="hint" id="f-error" style="color:var(--err);min-height:1em;margin:0 0 8px"></p>
        <button class="btn primary block" type="submit" ${state.busy ? "disabled" : ""}>Create passport</button>
      </form>`, (m) => {
      const sell = $("#f-sell", m);
      const err = $("#f-error", m);
      const pickedCat = () => m.querySelector('input[name="cat"]:checked')?.value || null;
      const updatePartners = () => { $("#f-partner-wrap", m).innerHTML = partnerSelect("f-partner", pickedCat()) || `<span class="hint">No specialist is approved for this category yet.</span>`; };
      sell.addEventListener("change", () => ($("#f-price-wrap", m).hidden = !sell.checked));
      m.querySelectorAll('input[name="cat"]').forEach((r) => r.addEventListener("change", updatePartners));
      $("#f-name", m).focus();
      m.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", () => {
        const s = SAMPLES[Number(b.dataset.sample)];
        $("#f-name", m).value = s.name; $("#f-brand", m).value = s.brand; $("#f-details", m).value = s.details;
        const r = $(`#cat-${s.category}`, m); if (r) { r.checked = true; updatePartners(); }
      }));
      const setPhoto = (data) => {
        photoData = data;
        $("#f-prev", m).innerHTML = data ? `<img src="${data}" alt="Photo preview">` : "<span>No photo</span>";
        $("#f-photo-clear", m).hidden = !data;
      };
      $("#f-photo", m).addEventListener("change", async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        err.textContent = "";
        try { setPhoto(await compressPhoto(file)); } catch (_) { setPhoto(""); err.textContent = "Couldn't use that photo. Try a JPG or PNG."; }
        ev.target.value = "";
      });
      $("#f-photo-clear", m).addEventListener("click", () => setPhoto(""));
      $("#add-form", m).addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const name = $("#f-name", m).value.trim();
        const brand = $("#f-brand", m).value.trim();
        const details = $("#f-details", m).value.trim();
        const category = pickedCat();
        const kind = m.querySelector('input[name="cat"]:checked')?.dataset.icon || "other";
        const asking = !!(sell && sell.checked && $("#f-partner", m));
        const partner = asking ? $("#f-partner", m).value : null;
        if (!name) { err.textContent = "Please give the piece a name."; return; }
        if (!category) { err.textContent = "Please choose a category."; return; }
        if (!hasMoney(toWei("0.02"))) { err.textContent = "You need a few cents for the network fee. Tap “Add money”."; return; }
        closeModal();
        const rc = await runTx({ pending: `Creating the passport for “${name}”…`, done: `“${name}” now has its passport.`, send: (c) => c.createPassportIn(name, brand, details, photoData || null, kind, category) });
        if (rc && asking && rc.id) {
          const id = rc.id;
          await runTx({ pending: `Asking ${nameOf(partner)} to authenticate “${name}”…`, done: `Request sent. ${nameOf(partner)} will check “${name}” in person.`, send: (c) => c.requestAuth(id, partner) });
        }
      });
    });
  }

  // ------------------------------------------------------------------- buy
  function openBuy(id) {
    const item = itemById(id);
    if (!item) return;
    const bal = myBalance();
    const enough = bal >= item.price + toWei("0.01");
    const capped = !isVerified(myAddr()) && item.price > NEW_MEMBER_CAP;
    const welcome = (state.me?.credits || []).find((c) => c.kind === "welcome_shipping" && !c.usedAt);
    const q = quoteOf(item);
    const offer = q && q.available;
    const total = item.price + (offer ? q.fee : 0n);
    openModal("Buy this piece", `
      ${art(item)}
      <h4 class="detail-title">${esc(item.name)}</h4>
      <p class="detail-brand">${esc(item.brand)} · sold by ${esc(nameOf(item.owner))} (${esc(levelOf(item.owner).label)} · ${esc(recText(item.owner))})</p>
      ${authLine(item)}
      <div class="callout held">
        <strong>${usd(item.price)} is held by the contract, not sent to the seller.</strong>
        <ul class="plain">
          <li>${esc(nameOf(item.owner))} has locked a ${usd(item.deposit)} deposit and must ship within ${SHIP_DAYS} days.</li>
          <li>After it ships, you have ${CONFIRM_DAYS} days to confirm or open a dispute.</li>
          <li>A dispute goes to a panel of 5 members. Opening one needs a ${usd(bondOf(item.price))} bond (5%), returned if you're right.</li>
        </ul>
      </div>
      ${welcome && Number(ethers.formatUnits(item.price, 18)) >= (CFG.rules?.welcomeMinOrder ?? 15) ? `<div class="callout ok">Welcome gift: your first delivery is free (up to $${welcome.dollars}).</div>` : ""}
      ${offer ? `
      <label class="check prot-check"><input id="b-protect" type="checkbox" checked> <span><b>Add 90-day protection for ${usd(q.fee)}</b><small>If a second specialist finds it's fake within 90 days of delivery, you get the full ${usd(item.price)} back. ${esc(nameOf(item.authBy))}'s bond pays first. Added right after you pay.</small></span></label>
      ${whyPriceHtml(item, q)}` : ""}
      <div class="facts"><div class="fact"><small>Price</small><strong>${usd(item.price)}</strong></div>${offer ? `<div class="fact"><small>With protection</small><strong>${usd(total)}</strong></div>` : ""}<div class="fact"><small>Your balance</small><strong>${usd(bal)}</strong></div></div>
      ${capped ? `<div class="callout bad">New members can buy items up to $50. Get your ID checked at a partner authenticator to lift the limit.</div>`
        : enough ? `<button class="btn gold block" data-action="pay" data-id="${item.id}" ${state.busy ? "disabled" : ""}>Pay ${usd(item.price)}</button>`
        : `<div class="callout info">You need ${usd(item.price)} plus a cent for the network fee.</div><button class="btn primary block" data-action="add-money">Add money</button>`}
    `, (m) => {
      const cb = $("#b-protect", m);
      const btn = m.querySelector('[data-action="pay"]');
      if (cb && btn) cb.addEventListener("change", () => { btn.textContent = cb.checked ? `Pay ${usd(item.price)}, then add protection` : `Pay ${usd(item.price)}`; });
      if (cb && btn) btn.textContent = `Pay ${usd(item.price)}, then add protection`;
    });
  }

  // ------------------------------------------------------- dispute / authenticate
  function openDispute(id) {
    const item = itemById(id);
    if (!item) return;
    const bond = bondOf(item.price);
    const reasons = ["It never arrived", "It's not as described", "I don't think it's genuine"];
    openModal("Something's wrong", `
      <p style="margin-top:0">Your ${usd(item.price)} stays held. A panel of up to 5 ID-checked members, drawn at random, will decide. ${esc(nameOf(item.partner))}, which authenticated the piece, files an inspection report as evidence.</p>
      ${coverFor(item, myAddr()) ? `<p class="fine">Your protection starts after delivery. While your payment is still held, a dispute is the faster way to get it back.</p>` : ""}
      <div class="callout held">Opening a dispute needs a <strong>${usd(bond)} bond</strong> (5% of the price). You get it back if the panel agrees with you. If not, it pays the panel and the seller. This keeps disputes honest.</div>
      <div class="field"><label>What happened?</label>${reasons.map((r, i) => `<label class="radio"><input type="radio" name="reason" value="${esc(r)}" ${i === 1 ? "checked" : ""}> ${esc(r)}</label>`).join("")}</div>
      <div class="field"><label for="d-note">Details (optional)</label><input id="d-note" type="text" maxlength="100" placeholder="e.g. Strap is a replacement"></div>
      ${myBalance() >= bond + toWei("0.01") ? `<button class="btn primary block" data-action="dispute-send" data-id="${id}">Open dispute and post ${usd(bond)}</button>` : `<div class="callout info">You need ${usd(bond)} for the bond.</div><button class="btn primary block" data-action="add-money">Add money</button>`}
    `);
  }
  function openClaim(coverId) {
    const c = prot()?.covers.find((x) => x.id === coverId);
    if (!c) return;
    const item = itemById(c.itemId);
    const dep = (BigInt(c.amount) * CLAIM_DEPOSIT_BPS) / 10000n;
    const others = activePartners().filter((p) => !same(p.addr, c.shop) && specIn(p.addr, c.category));
    openModal("This is a fake", `
      ${item ? art(item) : ""}
      <h4 class="detail-title">${esc(item?.name || "Piece")}</h4>
      <p style="margin-top:0">A second ${esc(catName(c.category).toLowerCase())} specialist${others.length ? ` (${esc(others.map((p) => p.name).join(" or "))})` : ""} re-inspects the piece. ${esc(nameOf(c.shop))}, which stamped it, can't rule on its own stamp.</p>
      <div class="callout held">Filing a claim needs a <strong>${usd(dep)} deposit</strong> (5% of the price).
        <ul class="plain"><li>If it's fake: you get ${usd(BigInt(c.amount))} plus your deposit back. ${esc(nameOf(c.shop))}'s bond pays half, the members' pool pays half.</li>
        <li>If it's genuine: your deposit pays the reviewer and the pool, and a rejected claim shows on your record.</li></ul></div>
      <div class="field"><label for="c-ev">What did you find?</label><textarea id="c-ev" rows="3" maxlength="300" class="select" placeholder="e.g. A watchmaker opened the caseback: the movement isn't the one listed."></textarea></div>
      ${myBalance() >= dep + toWei("0.01") ? `<button class="btn danger block" data-action="claim-send" data-cover="${c.id}">File claim and post ${usd(dep)}</button>` : `<div class="callout info">You need ${usd(dep)} for the deposit.</div><button class="btn primary block" data-action="add-money">Add money</button>`}
    `);
  }

  function openAuth(id) {
    const item = itemById(id);
    if (!item) return;
    openModal("Authenticate this piece", `
      ${art(item)}
      <h4 class="detail-title">${esc(item.name)}</h4>
      <p class="detail-brand">${esc(item.brand || "No brand")}${item.details ? ` · ${esc(item.details)}` : ""} · owner ${esc(nameOf(item.owner))}</p>
      <p>Only stamp a piece you have inspected in person. Your name goes on its passport, and you'll file the evidence if there's ever a dispute.${prot() && catOf(item) && specIn(myAddr(), catOf(item)) ? ` Your stamp also certifies it as ${esc(catName(catOf(item)).toLowerCase())} for protection: if it's later proven fake, your bond pays half the price.` : ""}</p>
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
  function openReport(did) {
    const d = state.disputes.find((x) => x.id === did);
    if (!d) return;
    const item = itemById(d.itemId);
    openModal("Inspection report", `
      <p style="margin-top:0">You authenticated <strong>${esc(item?.name || "this piece")}</strong>. The buyer says: “${esc(d.reason)}”. Re-inspect it if you can, and write what you found. The panel reads this before voting, and it's stored on Arc.</p>
      <div class="field"><label for="r-text">Your findings</label><textarea id="r-text" rows="4" maxlength="300" class="select" placeholder="e.g. Re-inspected on return: serial matches our records, stitching is factory standard.">${esc(d.report || "")}</textarea></div>
      <button class="btn gold block" data-action="report-send" data-did="${did}">File report on Arc</button>
    `);
  }
  function openCheckId(handle) {
    const u = dirBy(handle);
    if (!u) return;
    const m = memberOf(u.address);
    openModal("Check a member's ID", `
      <div class="member-card">${avatar(u.name, u.handle)}<div><h4 class="detail-title" style="margin:0">${esc(u.name)}</h4><p class="detail-brand">Code ${esc(u.handle)} · invited by ${esc(dirBy(u.invitedBy)?.name || "—")}${m ? ` · joined ${fmtDate(m.joinedAt)}` : ""}</p></div></div>
      <div class="callout held">Only confirm after you've seen a government photo ID and the name matches <strong>${esc(u.name)}</strong>. Your name is recorded on Arc as the partner that checked them. The ID itself is never stored.</div>
      <label class="check"><input id="cid-ok" type="checkbox"> I checked a photo ID in person and the name matches</label>
      <button class="btn gold block" data-action="check-id-send" data-member="${esc(handle)}">Record the ID check on Arc</button>
    `);
  }

  function openHow() {
    openModal("How it works on Arc", `
      <ol class="how-list">
        <li><strong>A closed community.</strong> You join only with an invite link from a member. The contract records who invited whom, and only members can trade.</li>
        <li><strong>ID checked in person.</strong> To sell, a member shows a photo ID at a partner authenticator, which records the check on Arc. New members can buy up to $50 until then.</li>
        <li><strong>Every piece gets a passport.</strong> A specialist in its category (watches, vintage watches, jewelry) authenticates it in person before it can be listed.</li>
        <li><strong>Payment is held, not sent.</strong> The buyer's dollars go into the contract. The seller locks a 10% deposit.</li>
        <li><strong>Disputes go to the community.</strong> The buyer posts a 5% bond. Five ID-checked members are drawn at random, never anyone connected to the sale. The authenticator files an inspection report. The first side to 3 votes wins, and the contract pays out. Members who voted with the outcome share 2% of the price.</li>
        ${prot() ? `<li><strong>Authenticators back their stamp with money.</strong> Each stakes a bond. Buyers can add 90 days of protection after delivery, priced on Arc from the seller's record, the record of whoever invited them, and the authenticator's record in that category. If a second specialist proves a piece fake, the bond pays half and a pool funded by members pays half. This is community protection on test dollars, not a licensed product.</li>` : ""}
        <li><strong>Everyone can check.</strong> The community ledger links every action to its transaction on Arc. Track records, including how the people you invited behaved, can't be edited.</li>
        <li><strong>Why Arc.</strong> USDC is the native currency, so fees are in dollars and cost about a cent.</li>
      </ol>
      <div class="row" style="margin-top:6px"><a class="btn ghost" href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">See the contract on Arc ↗</a><button class="btn primary" data-close>Got it</button></div>
    `);
  }

  // ------------------------------------------------------------- add money
  function openAddMoney() {
    const w = state.me;
    if (!w) return;
    const treasury = state.directory.find((u) => u.role === "treasury");
    openModal("Add test dollars", `
      <p style="margin-top:0">This runs on Arc's test network, so the dollars are free test USDC. In a real launch, members would add money with a card or bank transfer.</p>
      <div class="facts"><div class="fact"><small>Your balance</small><strong>${usd(myBalance())}</strong></div><div class="fact"><small>Network fee per action</small><strong>under $0.01</strong></div></div>
      <div class="h-label">Fastest: from the platform treasury</div>
      <div class="row"><button class="btn gold" data-action="fund" data-amount="1">Get $1</button><button class="btn gold" data-action="fund" data-amount="5">Get $5</button><button class="btn gold" data-action="fund" data-amount="10">Get $10</button></div>
      <p class="hint" style="margin:6px 0 0">The treasury holds ${treasury ? usd(balanceOf(treasury.address)) : "—"}.</p>
      <div class="h-label">Or use Circle's free faucet</div>
      <p style="margin:0 0 8px;font-size:14px">Pick <strong>Arc Testnet</strong> and <strong>USDC</strong>, then paste your account number:</p>
      <div class="mono" id="addr">${esc(w.address)}</div>
      <div class="row" style="margin-top:10px"><button class="btn ghost" data-action="copy-addr">Copy account number</button><a class="btn ghost" href="${CFG.faucet}" target="_blank" rel="noopener">Open faucet ↗</a></div>
    `);
  }

  async function metamaskSigner() {
    const eth = window.ethereum;
    if (!eth) throw Object.assign(new Error("no metamask"), { code: "NO_MM" });
    await eth.request({ method: "eth_requestAccounts" });
    return new ethers.BrowserProvider(eth).getSigner();
  }
  const mmCancelled = (e) => e?.code === 4001 || e?.code === "ACTION_REJECTED";

  async function adminSignIn() {
    const t = toast("Sign the message in MetaMask to prove you hold the contract's admin wallet…", "pending");
    try {
      const { message, nonce } = await api("/api/auth", { op: "admin-nonce" });
      const signer = await metamaskSigner();
      const signature = await signer.signMessage(message);
      await api("/api/auth", { op: "admin", nonce, signature });
      updateToast(t, "Signed in as admin.", "ok");
      lsSet(LS.view, "admin");
      await afterSignIn();
    } catch (e) {
      console.error(e);
      updateToast(t, e?.code === "NO_MM" ? "Open the app in a browser with MetaMask." : mmCancelled(e) ? "Cancelled in MetaMask." : friendlyError(e), "error");
    }
  }

  async function fundFromTreasury(dollars) {
    const t = toast(`Sending $${dollars} from the platform treasury…`, "pending");
    try {
      const r = await api("/api/fund", { dollars });
      updateToast(t, `You received $${dollars}.`, "ok", r.hash);
      closeModal();
      await refresh();
    } catch (e) { updateToast(t, friendlyError(e), "error"); }
  }

  // Admin transactions signed in the browser with MetaMask (approving partners and specialists).
  async function adminTx(label, to, abi, fn, args) {
    if (state.busy) return;
    state.busy = true; render();
    const t = toast(`${label}: confirm it in MetaMask…`, "pending");
    try {
      const signer = await metamaskSigner();
      const net = await signer.provider.getNetwork();
      if (Number(net.chainId) !== CFG.chainId) {
        try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CFG.chainId.toString(16) }] }); }
        catch (_) { throw Object.assign(new Error("wrong network"), { friendly: "Switch MetaMask to Arc Testnet and try again." }); }
      }
      const c = new ethers.Contract(to, abi, await metamaskSigner());
      const tx = await c[fn](...args);
      updateToast(t, `${label}: waiting for Arc…`, "pending");
      await tx.wait();
      updateToast(t, `${label}: done.`, "ok", tx.hash);
      await connect(); await refresh();
    } catch (e) {
      console.error(e);
      updateToast(t, e?.code === "NO_MM" ? "Open the app in a browser with MetaMask." : mmCancelled(e) ? "Cancelled in MetaMask." : friendlyError(e), "error");
    } finally { state.busy = false; render(); }
  }

  async function adminOp(op) {
    if (state.busy) return;
    state.busy = true; render();
    const t = toast(op === "setup" ? "Setting up the demo accounts on Arc…" : op === "seed" ? "Adding community members on Arc…" : op === "protection" ? "Playing the protection demo on Arc…" : "Playing the demo history on Arc…", "pending");
    try {
      if (op === "protection") {
        let r;
        do {
          r = await api("/api/admin", { op: "protection" });
          updateToast(t, `${r.done[r.done.length - 1] || "Working"}… (step ${r.step} of ${r.total})`, "pending");
          await refresh();
        } while (!r.finished);
        updateToast(t, "Protection demo done: both authenticators staked bonds, members funded the pool, one fake was refunded, one claim was rejected, and one purchase is protected.", "ok");
      } else if (op === "history") {
        let r;
        do {
          r = await api("/api/admin", { op: "history" });
          updateToast(t, `${r.done[r.done.length - 1] || "Working"}… (step ${r.step} of ${r.total})`, "pending");
          await refresh();
        } while (!r.finished);
        updateToast(t, "Demo history done: 2 sales, the listings, a piece waiting for an authenticator, and a dispute the member panel decided.", "ok");
      } else if (op === "setup") {
        const r = await api("/api/admin", { op: "setup" });
        updateToast(t, r.message, "ok");
      } else {
        let r;
        do {
          r = await api("/api/admin", { op: "seed" });
          updateToast(t, `Added ${r.added.join(" and ") || "no one new"}. ${r.total} of 10 community members are ready…`, "pending");
          await connect(); await refresh();
        } while (r.remaining > 0 && r.added.length);
        updateToast(t, `Community ready: ${r.total} members, each invited, ID-checked and given a little test money. Next: Play demo history.`, "ok");
      }
      await connect();
      await refresh();
    } catch (e) { updateToast(t, friendlyError(e), "error"); }
    finally { state.busy = false; render(); }
  }

  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch (_) { toast("Couldn't copy. Select it and copy it by hand.", "error"); }
  }
  const clearToasts = () => document.querySelectorAll("#toast-root .toast:not(.pending)").forEach((t) => t.remove());

  // ---------------------------------------------------------------- events
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-scroll]");
    if (!a) return;
    ev.preventDefault();
    document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-view],[data-demo],[data-tab],[data-tab-go],[data-open],[data-action],[data-cat]");
    if (!el) return;
    if (el.dataset.cat) { state.cat = el.dataset.cat; render(); return; }
    if (el.dataset.view) { closeModal(); goView(el.dataset.view); window.scrollTo(0, 0); return; }
    if (el.dataset.demo) {
      clearToasts();
      try { await api("/api/auth", { op: "demo", handle: el.dataset.demo }); closeModal(); await afterSignIn(); }
      catch (e) { toast(friendlyError(e), "error"); }
      return;
    }
    if (el.dataset.tab || el.dataset.tabGo) { closeModal(); goTab(el.dataset.tab || el.dataset.tabGo); return; }
    if (el.dataset.open && !el.dataset.action) { ev.stopPropagation(); openDetail(Number(el.dataset.open)); return; }

    const id = Number(el.dataset.id);
    const did = Number(el.dataset.did);
    const item = itemById(id);
    switch (el.dataset.action) {
      case "sign-out":
        clearToasts(); closeModal();
        await api("/api/auth", { op: "sign-out" }).catch(() => {});
        state.me = null; state.isAdmin = false; state.viewAs = null; state.view = null; state.tab = null;
        await connect(); await refresh(); window.scrollTo(0, 0);
        break;
      case "send-code": {
        const email = ($("#si-email")?.value || "").trim();
        if (!email) { toast("Enter the email you joined with.", "error"); return; }
        try {
          const r = await api("/api/auth", { op: "send-code", email });
          state.signin = { email, sent: true, demoCode: r.demoCode || null };
          openSignin();
        } catch (e) { toast(friendlyError(e), "error"); }
        break;
      }
      case "code-reset": state.signin = { email: state.signin.email, sent: false, demoCode: null }; openSignin(); break;
      case "verify-code": {
        const code = ($("#si-code")?.value || "").trim();
        try { await api("/api/auth", { op: "verify", email: state.signin.email, code }); closeModal(); await afterSignIn(); }
        catch (e) { toast(friendlyError(e), "error"); }
        break;
      }
      case "admin-signin": closeModal(); adminSignIn(); break;
      case "open-signin": openSignin(); break;
      case "admin-setup": adminOp("setup"); break;
      case "admin-seed": adminOp("seed"); break;
      case "admin-history": adminOp("history"); break;
      case "admin-protection": adminOp("protection"); break;
      case "approve-spec": {
        const x = (CFG.specialistPlan || [])[Number(el.dataset.plan)];
        const u = x && dirBy(x.shop);
        if (!u) return;
        await adminTx(`Approving ${u.name} for ${catName(x.category).toLowerCase()}`, CFG.protectionAddress,
          ["function setSpecialist(address partner, bytes32 key, bool approved, string credential)"], "setSpecialist",
          [u.address, ethers.encodeBytes32String(x.category), true, x.credential]);
        break;
      }
      case "approve-shop2": {
        const u = dirBy("shop2");
        if (!u) return;
        await adminTx("Approving Second Opinion Jewelers as a partner", CFG.contractAddress,
          ["function addPartner(address partner, string name, string city)"], "addPartner", [u.address, "Second Opinion Jewelers", "Atlanta"]);
        break;
      }
      case "buy-cover": {
        const q = quoteOf(item);
        if (!q) return;
        if (!hasMoney(q.fee + toWei("0.01"))) { toast(`You need ${usd(q.fee)} for protection. Tap “Add money”.`, "error"); return; }
        await runTx({ pending: `Adding 90-day protection to “${item.name}” for ${usd(q.fee)}…`, done: `“${item.name}” is protected. The 90 days start when you confirm delivery.`, send: (c) => c.buyCover(id) });
        break;
      }
      case "claim-fake": openClaim(Number(el.dataset.cover)); break;
      case "claim-send": {
        const ev2 = $("#c-ev")?.value.trim();
        if (!ev2) { toast("Please say what you found.", "error"); return; }
        closeModal();
        await runTx({ pending: "Filing your claim and posting the deposit…", done: "Claim filed. A second specialist will re-inspect the piece.", send: (c) => c.fileClaim(Number(el.dataset.cover), ev2) });
        break;
      }
      case "decide-claim": {
        const cid = Number(el.dataset.cover);
        const fake = el.dataset.fake === "1";
        const ruling = $(`#rule-${cid}`)?.value.trim();
        if (!ruling) { toast("Please write what you found.", "error"); return; }
        await runTx({ pending: `Recording your ruling (${fake ? "fake" : "genuine"}) on Arc…`, done: fake ? "Ruled fake. The buyer has been refunded, and you earned the re-inspection fee." : "Ruled genuine. The claim is closed and you earned the re-inspection fee.", send: (c) => c.decideClaim(cid, fake, ruling) });
        break;
      }
      case "stake-bond": case "withdraw-bond": case "pool-deposit": case "pool-withdraw": {
        const inp = $(el.dataset.action.startsWith("pool") ? "#pool-amt" : "#bond-amt");
        const amt = parseFloat(inp?.value);
        if (!(amt > 0)) { toast("Please enter an amount above $0.", "error"); return; }
        const a = amt.toFixed(2);
        const map = {
          "stake-bond": [`Adding $${a} to your bond…`, `Your bond is $${a} bigger.`, (c) => c.stakeBond(a)],
          "withdraw-bond": [`Withdrawing $${a} of free bond…`, `$${a} is back in your account.`, (c) => c.withdrawBond(a)],
          "pool-deposit": [`Putting $${a} into the protection pool…`, `$${a} is in the pool. You earn a share of the fees.`, (c) => c.poolDeposit(a)],
          "pool-withdraw": [`Withdrawing $${a} from the pool…`, `$${a} is back in your account.`, (c) => c.poolWithdraw(a)],
        }[el.dataset.action];
        await runTx({ pending: map[0], done: map[1], send: map[2] });
        break;
      }
      case "view-as":
        ev.stopPropagation();
        state.viewAs = el.dataset.handle; state.view = null; state.tab = null;
        pickView(); closeModal(); render(); window.scrollTo(0, 0);
        break;
      case "stop-view-as": state.viewAs = null; state.view = "admin"; state.tab = "members"; render(); break;
      case "leave-invite": clearHash(); break;
      case "new-invite": {
        try {
          const r = await api("/api/invites", {});
          await connect(); render();
          await copy(inviteUrl(r.code), "Invite link created and copied. Send it to someone you'd trade with.");
        } catch (e) { toast(friendlyError(e), "error"); }
        break;
      }
      case "copy-invite": copy(inviteUrl(el.dataset.code), "Invite link copied."); break;
      case "add-item": openAddItem(); break;
      case "how": openHow(); break;
      case "add-money": openAddMoney(); break;
      case "copy-addr": copy(state.me?.address, "Account number copied."); break;
      case "copy-link": copy(passportUrl(id), "Passport link copied."); break;
      case "share": closeModal(); location.hash = `passport=${id}`; break;
      case "leave-public": clearHash(); break;
      case "public-buy":
        clearHash();
        if (!signedIn()) { openSignin(); break; }
        if (state.me?.role === "member") { goTab("shop"); if (item && !same(item.owner, myAddr())) openBuy(id); }
        break;
      case "fund": fundFromTreasury(Number(el.dataset.amount)); break;
      case "buy": openBuy(id); break;
      case "pay": {
        const protect = !!$("#b-protect")?.checked;
        closeModal();
        if (await runTx({ pending: `Paying ${usd(item.price)}. The money will be held…`, done: `Paid! ${usd(item.price)} is held until you confirm “${item.name}” arrived.`, send: (c) => c.buy(id) })) {
          if (protect && quoteOf(itemById(id))?.available) {
            const q = quoteOf(itemById(id));
            await runTx({ pending: `Adding 90-day protection for ${usd(q.fee)}…`, done: `Protected. The 90 days start when you confirm “${item.name}” arrived.`, send: (c) => c.buyCover(id) });
          }
          goTab("orders");
        }
        break;
      }
      case "list": {
        const price = parseFloat($("#list-price")?.value);
        if (!(price > 0)) { toast("Please enter a price above $0.", "error"); return; }
        const w = toWei(price.toFixed(2));
        if (!hasMoney(depositOf(w) + toWei("0.01"))) { toast(`You need ${usd(depositOf(w))} for the deposit. Tap “Add money”.`, "error"); return; }
        await runTx({ pending: `Listing “${item.name}” for ${usd(w)} and locking your ${usd(depositOf(w))} deposit…`, done: `“${item.name}” is now for sale.`, send: (c) => c.listForSale(id, w) });
        break;
      }
      case "unlist": await runTx({ pending: "Taking it off sale…", done: `“${item.name}” is off sale and your deposit is returned.`, send: (c) => c.cancelListing(id) }); break;
      case "ship": closeModal(); await runTx({ pending: "Marking it as shipped…", done: `Marked as shipped. ${nameOf(item.buyer)} has ${CONFIRM_DAYS} days to confirm or dispute.`, send: (c) => c.markShipped(id) }); break;
      case "confirm":
        closeModal();
        if (await runTx({ pending: `Releasing the payment to ${nameOf(item.owner)} and moving the passport to you…`, done: `Done! ${nameOf(item.owner)} was paid, and “${item.name}” is now yours.`, send: (c) => c.confirmDelivery(id) })) { await connect(); goTab("mine"); }
        break;
      case "claim": closeModal(); await runTx({ pending: "Collecting the payment…", done: `You've been paid for “${item.name}”.`, send: (c) => c.sellerClaim(id) }); break;
      case "seller-cancel": closeModal(); await runTx({ pending: "Refunding the buyer…", done: "The buyer got their money back. The piece is listed again.", send: (c) => c.sellerCancelSale(id) }); break;
      case "buyer-cancel": closeModal(); await runTx({ pending: "Cancelling and refunding you…", done: "Your money is back, plus the seller's deposit.", send: (c) => c.buyerCancelUnshipped(id) }); break;
      case "dispute": openDispute(id); break;
      case "dispute-send": {
        const reason = document.querySelector('input[name="reason"]:checked')?.value || "Something's wrong";
        const note = $("#d-note")?.value.trim();
        closeModal();
        if (await runTx({ pending: "Opening the dispute and drawing a panel of members…", done: "Dispute opened. A panel of members has been drawn and the authenticator will file a report.", send: (c) => c.openDispute(id, note ? `${reason}: ${note}` : reason) })) goTab("disputes");
        break;
      }
      case "vote": {
        const buyerWins = el.dataset.win === "buyer";
        await runTx({ pending: "Recording your vote on Arc…", done: `Vote recorded for the ${buyerWins ? "buyer" : "seller"}. If it completes a majority, the contract pays out now.`, send: (c) => c.vote(did, buyerWins) });
        break;
      }
      case "report": openReport(did); break;
      case "report-send": {
        const text = $("#r-text")?.value.trim();
        if (!text) { toast("Please write what you found.", "error"); return; }
        closeModal();
        await runTx({ pending: "Filing your inspection report on Arc…", done: "Report filed. The panel can read it now.", send: (c) => c.report(did, text) });
        break;
      }
      case "finalize": await runTx({ pending: "Closing the vote…", done: "The vote is closed and the contract has paid out.", send: (c) => c.finalize(did) }); break;
      case "resolve": {
        const buyerWins = el.dataset.win === "buyer";
        await runTx({ pending: "Recording your decision…", done: `Decided for the ${buyerWins ? "buyer" : "seller"}. The contract has paid out.`, send: (c) => c.resolve(did, buyerWins) });
        break;
      }
      case "flag": {
        const reason = window.prompt("What looks off about this listing?", "Price or photos look suspicious");
        if (reason === null) return;
        await runTx({ pending: "Flagging the listing…", done: `Flag added. At ${CFG.rules?.flagsToPause ?? 3} flags the listing pauses until the authenticator reviews it.`, send: (c) => c.flag(id, reason) });
        break;
      }
      case "unflag": await runTx({ pending: "Removing your flag…", done: "Flag removed.", send: (c) => c.unflag(id) }); break;
      case "clear-flags": await runTx({ pending: "Clearing the flags…", done: "Flags cleared. The listing is live again.", send: (c) => c.clearFlags(id) }); break;
      case "fd-lookup": {
        const code = ($("#fd-code")?.value || "").trim().replace(/^wp-member:/, "");
        const u = dirBy(code);
        const box = $("#fd-result");
        if (!u || u.role !== "member") { box.innerHTML = `<p class="hint" style="color:var(--err)">No member has that code.</p>`; return; }
        if (isVerified(u.address)) { box.innerHTML = `<p class="hint">${esc(u.name)}'s ID was already checked by ${esc(nameOf(memberOf(u.address).verifiedBy))}.</p>`; return; }
        openCheckId(u.handle);
        break;
      }
      case "fd-check": openCheckId(el.dataset.member); break;
      case "check-id-send": {
        if (!$("#cid-ok")?.checked) { toast("Tick the box to confirm you checked the ID.", "error"); return; }
        const u = dirBy(el.dataset.member);
        closeModal();
        await runTx({ pending: `Recording ${u.name}'s ID check on Arc…`, done: `${u.name} is now a verified member and can sell.`, send: (c) => c.verifyMember(u.handle) });
        break;
      }
      case "request-auth": {
        const partner = $("#auth-partner")?.value;
        if (!partner) return;
        await runTx({ pending: `Asking ${nameOf(partner)} to authenticate “${item.name}”…`, done: `Request sent. ${nameOf(partner)} will check “${item.name}” in person.`, send: (c) => c.requestAuth(id, partner) });
        break;
      }
      case "cancel-auth": await runTx({ pending: "Cancelling the request…", done: "Request cancelled.", send: (c) => c.cancelAuthRequest(id) }); break;
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
        await runTx({ pending: `Stamping the passport of “${item.name}”…`, done: `“${item.name}” is now authenticated by your shop.`, send: (c) => c.authenticate(id, note) });
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
      await route();
      await refresh();
      setInterval(() => { if (!state.busy && !document.hidden) refresh(); }, CFG.refreshMs);
    } catch (e) {
      state.fatal = e.message || String(e);
      render();
    }
  }

  // Small hook for automated tests and debugging (no secrets exposed).
  window.WP = { state, refresh, me: () => state.me };

  start();
})();
