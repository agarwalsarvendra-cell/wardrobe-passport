/* Wardrobe Passport — app logic
 *
 * How it fits together:
 * - The WardrobePassport contract on Arc stores every item's passport (incl. a
 *   small photo), its status and its ownership history, and holds the buyer's
 *   money until delivery is confirmed.
 * - This page reads that data from Arc and sends transactions for the current
 *   person. Each demo person (Maya, Alex) has an in-app wallet kept in this
 *   browser, so nobody sees MetaMask, gas or crypto addresses while using the
 *   app. Amounts are shown in dollars (Arc's native currency is USDC).
 * - #passport=<id> opens a public, read-only passport page anyone can verify.
 */
(() => {
  "use strict";

  const CFG = window.WP_CONFIG;
  const ABI = window.WP_ABI;
  const { ethers } = window;

  const STATUS = { OWNED: 0, LISTED: 1, PENDING: 2 };
  const PERSONAS = [
    { id: "maya", name: "Maya", color: "#c9a45c" },
    { id: "alex", name: "Alex", color: "#8fb8a8" },
  ];
  const LS = { keys: "wp.personaKeys.v1", current: "wp.currentPersona", tab: "wp.tab" };
  const REFUND_DAYS = 14;
  const MAX_PHOTO_CHARS = 7000; // ~5 KB photo stored in the passport (fee about $0.10 on Arc)

  const state = {
    provider: null,
    contract: null,
    rpcUrl: null,
    wallets: {},
    balances: {},
    current: "maya",
    tab: "wardrobe",
    items: [],
    histories: {},
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
    return n > 0 && n < 0.01 ? `$${n.toFixed(4).replace(/0+$/, "")}` : usd(wei);
  };
  const toWei = (dollars) => ethers.parseUnits(String(dollars), 18);
  const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const me = () => state.wallets[state.current];
  const myAddr = () => me()?.address;
  const person = (id) => PERSONAS.find((p) => p.id === id);
  const itemById = (id) => state.items.find((i) => i.id === id);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const explorerAddr = (a) => `${CFG.explorer}/address/${a}`;
  const explorerTx = (h) => `${CFG.explorer}/tx/${h}`;
  const passportUrl = (id) => `${location.origin}${location.pathname}#passport=${id}`;
  const pad = (id) => String(id).padStart(6, "0");

  function nameOf(addr) {
    if (isZero(addr)) return "—";
    for (const p of PERSONAS) if (same(state.wallets[p.id]?.address, addr)) return p.name;
    return `Member ${short(addr)}`;
  }
  function isSafeImage(u) {
    return /^https:\/\/[^\s"'<>]+$/i.test(u || "") || /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(u || "");
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
    if (isSafeImage(item.imageUrl)) {
      return `<div class="art photo ${cls}"><img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" loading="lazy" referrerpolicy="no-referrer"></div>`;
    }
    const ic = ICONS[iconKey(item.imageUrl)];
    return `<div class="art ${cls}" style="--tint:${ic.tint}"><svg viewBox="0 0 64 64" aria-hidden="true">${ic.svg}</svg></div>`;
  }

  // Sample pieces make demos fast; they're normal passports once created.
  const SAMPLES = [
    { name: "Navy wool blazer", brand: "Hugo Boss", details: "Size 40R, worn twice", kind: "jacket", price: 15 },
    { name: "Steel dive watch", brand: "Rolex", details: "Box and papers, serviced 2025", kind: "watch", price: 12 },
    { name: "Leather tote", brand: "Coach", details: "Tan, like new", kind: "bag", price: 9 },
    { name: "White leather sneakers", brand: "Common Projects", details: "US 9, light wear", kind: "shoes", price: 8 },
  ];

  // ------------------------------------------------------------- chain setup
  async function connect() {
    const network = new ethers.Network(CFG.chainName, CFG.chainId);
    for (const url of CFG.rpcUrls) {
      try {
        // cacheTimeout -1: always read fresh balances/status (no short-term cache)
        const p = new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
        await withTimeout(p.getBlockNumber(), 7000);
        state.provider = p;
        state.rpcUrl = url;
        state.contract = new ethers.Contract(CFG.contractAddress, ABI, p);
        return;
      } catch (e) {
        console.warn("Arc endpoint not reachable:", url, e?.message || e);
      }
    }
    throw new Error("Can't reach Arc right now. Check your connection and refresh the page.");
  }

  function loadPersonas() {
    let keys = {};
    try { keys = JSON.parse(lsGet(LS.keys) || "{}"); } catch (_) { keys = {}; }
    let changed = false;
    for (const p of PERSONAS) {
      if (!keys[p.id]) { keys[p.id] = ethers.Wallet.createRandom().privateKey; changed = true; }
    }
    if (changed) lsSet(LS.keys, JSON.stringify(keys));
    for (const p of PERSONAS) state.wallets[p.id] = new ethers.Wallet(keys[p.id], state.provider);
    const cur = lsGet(LS.current);
    if (person(cur)) state.current = cur;
    const tab = lsGet(LS.tab);
    if (["wardrobe", "shop", "orders"].includes(tab)) state.tab = tab;
  }

  // Overlapping refreshes (timer + after a transaction) must not let an older,
  // slower read overwrite newer data, so only the latest one is applied.
  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq;
    try {
      const c = state.contract;
      const count = Number(await c.itemCount());
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      const [rows, hists, bals] = await Promise.all([
        Promise.all(ids.map((id) => c.getItem(id))),
        Promise.all(ids.map((id) => c.getHistory(id))),
        Promise.all(PERSONAS.map((p) => state.provider.getBalance(state.wallets[p.id].address))),
      ]);
      if (seq !== refreshSeq) return; // a newer refresh is on its way
      state.items = rows.map((r, i) => ({
        id: ids[i],
        name: r[0], brand: r[1], details: r[2], imageUrl: r[3],
        owner: r[4], buyer: r[5], price: r[6], paidAt: r[7], status: Number(r[8]),
      }));
      state.histories = {};
      hists.forEach((h, i) => {
        state.histories[ids[i]] = h.map((t) => ({ from: t[0], to: t[1], price: t[2], at: t[3] }));
      });
      PERSONAS.forEach((p, i) => (state.balances[p.id] = bals[i]));
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
    return {
      created: h[0]?.at,
      creator: h[0]?.to,
      owners: Math.max(1, h.length),
      sales,
      lastSale: sales[sales.length - 1],
    };
  }

  function stats() {
    let sales = 0, volume = 0n, held = 0n;
    for (const it of state.items) {
      for (const t of state.histories[it.id] || []) if (!isZero(t.from)) { sales++; volume += t.price; }
      if (it.status === STATUS.PENDING) held += it.price;
    }
    return { passports: state.items.length, sales, volume, held };
  }

  // ---------------------------------------------------------- transactions
  const FRIENDLY = {
    NotOwner: "Only the owner can do that.",
    NotBuyer: "Only the buyer can do that.",
    WrongStatus: "This item just changed. The page has been refreshed.",
    WrongAmount: "The price changed. The page has been refreshed.",
    InvalidPrice: "Please enter a price above $0.",
    CannotBuyOwnItem: "You can't buy your own item.",
    RefundWindowOpen: `Refunds open ${REFUND_DAYS} days after payment.`,
    NothingOwed: "There's nothing to collect.",
    TransferFailed: "The payment couldn't be sent. Please try again.",
    NoSuchItem: "That item doesn't exist.",
  };

  function revertData(e) {
    const cands = [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data];
    return cands.find((d) => typeof d === "string" && d.startsWith("0x")) || null;
  }

  function friendlyError(e) {
    const data = revertData(e);
    if (data) {
      try {
        const parsed = state.contract.interface.parseError(data);
        if (parsed && FRIENDLY[parsed.name]) return FRIENDLY[parsed.name];
      } catch (_) { /* not one of ours */ }
    }
    const msg = `${e?.shortMessage || ""} ${e?.message || ""}`.toLowerCase();
    if (e?.code === "INSUFFICIENT_FUNDS" || msg.includes("insufficient funds")) {
      return "Not enough test dollars. Tap “Add money” and try again.";
    }
    if (msg.includes("timeout") || msg.includes("network")) return "Arc didn't respond. Please try again.";
    return "Something went wrong. Please try again.";
  }

  async function runTx({ pending, done, send }) {
    if (state.busy) return null;
    state.busy = true;
    render();
    const t = toast(pending, "pending");
    try {
      const tx = await send(state.contract.connect(me()));
      const rc = await tx.wait();
      const fee = rc.fee ?? (rc.gasUsed * (rc.gasPrice ?? 0n));
      updateToast(t, `${done} Network fee: ${usdFee(fee)}.`, "ok", rc.hash);
      await refresh();
      return rc;
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
    if (item.status === STATUS.LISTED) return `<span class="chip listed">For sale · ${usd(item.price)}</span>`;
    if (item.status === STATUS.PENDING) {
      return same(item.buyer, myAddr())
        ? `<span class="chip held">On its way · ${usd(item.price)} held</span>`
        : `<span class="chip held">Sold · ${usd(item.price)} held until delivery</span>`;
    }
    return `<span class="chip owned">In wardrobe</span>`;
  }

  function provenance(item) {
    const f = facts(item);
    if (f.lastSale) return `Last sold ${usd(f.lastSale.price)} · ${f.owners} owners`;
    return f.created ? `Passport since ${fmtDate(f.created)}` : "";
  }

  function card(item, footer) {
    return `
      <button class="card" data-open="${item.id}" aria-label="Open ${esc(item.name)}">
        <div class="card-art">${art(item)}<span class="pid">Passport #${item.id}</span></div>
        <div class="card-body">
          <p class="card-title">${esc(item.name)}</p>
          <p class="card-brand">${esc(item.brand || "No brand")}</p>
          <p class="card-prov">${esc(provenance(item))}</p>
          <div class="card-foot">${footer ?? chipFor(item)}</div>
        </div>
      </button>`;
  }

  function renderWho() {
    $("#who").innerHTML =
      PERSONAS.map((p) => `
        <button class="persona ${p.id === state.current ? "active" : ""}" data-persona="${p.id}" aria-pressed="${p.id === state.current}">
          <span class="avatar" style="background:${p.color}">${p.name[0]}</span>
          <span><div class="p-name">${p.name}</div><div class="p-bal">${state.loaded ? usd(state.balances[p.id]) : "…"}</div></span>
        </button>`).join("") +
      `<button class="addmoney" data-action="add-money">+ Add money</button>`;
  }

  function ordersCount() {
    if (!me()) return 0;
    return state.items.filter((i) => i.status === STATUS.PENDING && (same(i.buyer, myAddr()) || same(i.owner, myAddr()))).length;
  }

  function renderTabs() {
    const n = ordersCount();
    document.querySelectorAll(".tab").forEach((b) => {
      const active = b.dataset.tab === state.tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active);
      if (b.dataset.tab === "orders") b.innerHTML = `Orders${n ? `<span class="count">${n}</span>` : ""}`;
    });
  }

  function renderHero() {
    const el = $("#hero");
    if (!state.loaded) { el.innerHTML = ""; return; }
    const s = stats();
    const broke = PERSONAS.every((p) => (state.balances[p.id] ?? 0n) === 0n);
    el.innerHTML = `
      <div class="hero-copy">
        <h2>Resale you can trust.</h2>
        <p>Every piece gets a passport on Arc. When it sells, the buyer's money is held until the piece arrives, then the money and the piece's history move together.</p>
        <ol class="steps">
          <li><span>1</span>List a piece</li>
          <li><span>2</span>Buyer pays, money held</li>
          <li><span>3</span>Delivered: money + passport move</li>
          <li class="how-link"><button class="linkish" data-action="how">How it works on Arc</button></li>
        </ol>
        ${broke ? `<p class="tip">Demo tip: give Maya and Alex test dollars with <button class="linkish" data-action="add-money">+ Add money</button>.</p>` : ""}
      </div>
      <div class="hero-stats" aria-label="Live totals from Arc">
        <div class="stat"><strong>${s.passports}</strong><small>passports on Arc</small></div>
        <div class="stat"><strong>${s.sales}</strong><small>sales completed</small></div>
        <div class="stat"><strong>${usd(s.volume)}</strong><small>paid out safely</small></div>
        <div class="stat"><strong>${usd(s.held)}</strong><small>held right now</small></div>
      </div>`;
  }

  function renderWardrobe() {
    const mine = state.items.filter((i) => same(i.owner, myAddr())).reverse();
    const head = `
      <div class="section-head">
        <div><h2>${esc(person(state.current).name)}'s wardrobe</h2><p>${mine.length} piece${mine.length === 1 ? "" : "s"}, each with its own passport</p></div>
        <button class="btn primary" data-action="add-item" ${state.busy ? "disabled" : ""}>+ Add a piece</button>
      </div>`;
    if (!mine.length) {
      return head + `
        <div class="empty">
          <h3>Your wardrobe is empty</h3>
          <p>Add a piece and it gets a digital passport: a photo, who owned it, when, and for how much.</p>
          <button class="btn gold" data-action="add-item" ${state.busy ? "disabled" : ""}>Add your first piece</button>
        </div>`;
    }
    return head + `<div class="grid">${mine.map((i) => card(i)).join("")}</div>`;
  }

  function renderShop() {
    const forSale = state.items.filter((i) => i.status === STATUS.LISTED && !same(i.owner, myAddr())).reverse();
    const head = `
      <div class="section-head">
        <div><h2>Shop pre-owned</h2><p>Every piece comes with its verified history. Your money is held until it arrives.</p></div>
      </div>`;
    if (!forSale.length) {
      const other = PERSONAS.find((p) => p.id !== state.current);
      return head + `
        <div class="empty">
          <h3>Nothing for sale right now</h3>
          <p>Switch to ${esc(other.name)} and list a piece from their wardrobe.</p>
        </div>`;
    }
    return head + `<div class="grid">${forSale.map((i) => card(i, `
      <span class="price">${usd(i.price)}</span>
      <span class="chip ok">Sold by ${esc(nameOf(i.owner))}</span>`)).join("")}</div>`;
  }

  function orderRow(i, role) {
    const refundAt = Number(i.paidAt) + REFUND_DAYS * 86400;
    const canRefund = Date.now() / 1000 >= refundAt;
    const dis = state.busy ? "disabled" : "";
    if (role === "buyer") {
      return `
        <div class="order">
          ${art(i)}
          <div>
            <h3>${esc(i.name)}</h3>
            <p>${esc(i.brand)} · from ${esc(nameOf(i.owner))} · paid ${fmtDate(i.paidAt)}</p>
            <span class="chip held">${usd(i.price)} held safely until you confirm</span>
            <div class="actions">
              <button class="btn gold" data-action="confirm" data-id="${i.id}" ${dis}>I received it</button>
              <button class="btn ghost" data-open="${i.id}">View passport</button>
              ${canRefund
                ? `<button class="btn danger" data-action="claim-refund" data-id="${i.id}" ${dis}>It never came: get my money back</button>`
                : `<p class="fine">If it never arrives, you can take your money back from ${fmtDate(refundAt)}.</p>`}
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="order">
        ${art(i)}
        <div>
          <h3>${esc(i.name)}</h3>
          <p>${esc(i.brand)} · bought by ${esc(nameOf(i.buyer))} · paid ${fmtDate(i.paidAt)}</p>
          <span class="chip held">${usd(i.price)} held · paid to you when they confirm delivery</span>
          <div class="actions">
            <button class="btn ghost" data-open="${i.id}">View passport</button>
            <button class="btn danger" data-action="seller-cancel" data-id="${i.id}" ${dis}>Can't ship? Refund the buyer</button>
          </div>
        </div>
      </div>`;
  }

  function renderOrders() {
    const buying = state.items.filter((i) => i.status === STATUS.PENDING && same(i.buyer, myAddr()));
    const selling = state.items.filter((i) => i.status === STATUS.PENDING && same(i.owner, myAddr()));
    const done = [];
    for (const it of state.items) {
      for (const t of state.histories[it.id] || []) {
        if (isZero(t.from)) continue;
        if (same(t.to, myAddr())) done.push({ it, t, kind: "Bought", other: t.from });
        else if (same(t.from, myAddr())) done.push({ it, t, kind: "Sold", other: t.to });
      }
    }
    done.sort((a, b) => Number(b.t.at) - Number(a.t.at));

    let html = `
      <div class="section-head">
        <div><h2>Orders</h2><p>What you're buying, what you've sold, and what's done</p></div>
      </div>`;
    if (!buying.length && !selling.length && !done.length) {
      return html + `
        <div class="empty">
          <h3>No orders yet</h3>
          <p>When you buy or sell a piece, it shows here until delivery is confirmed.</p>
          <button class="btn ghost" data-tab-go="shop">Browse pre-owned</button>
        </div>`;
    }
    if (buying.length) html += `<div class="h-label">On the way to you</div>` + buying.map((i) => orderRow(i, "buyer")).join("");
    if (selling.length) html += `<div class="h-label">Sold: ship it</div>` + selling.map((i) => orderRow(i, "seller")).join("");
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

  function renderFoot() {
    $("#foot").innerHTML = `
      <span class="live ${state.online ? "" : "down"}">${state.online ? `Live on ${esc(CFG.chainName)}` : "Reconnecting to Arc…"}</span>
      <span>·</span>
      <a href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">Contract ${short(CFG.contractAddress)} (verified) ↗</a>
      <span>·</span>
      <button class="linkish foot-link" data-action="how">How it works</button>
      <span>·</span>
      <span>Demo: test dollars only</span>`;
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
    view.innerHTML = state.tab === "shop" ? renderShop() : state.tab === "orders" ? renderOrders() : renderWardrobe();
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
    if (item.status === STATUS.LISTED) return `For sale · ${usd(item.price)}`;
    if (item.status === STATUS.PENDING) return "Sale in progress · payment held";
    return "In owner's wardrobe";
  }

  function timelineHtml(item) {
    const h = state.histories[item.id] || [];
    if (!h.length) return `<li><div class="t-sub">No history yet.</div></li>`;
    return h.map((t) => isZero(t.from)
      ? `<li><div class="t-main">Passport issued to ${esc(nameOf(t.to))}</div><div class="t-sub">${fmtDate(t.at)}</div></li>`
      : `<li><div class="t-main">${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} for ${usd(t.price)}</div><div class="t-sub">${fmtDate(t.at)} · delivery confirmed, payment released</div></li>`).join("");
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
                <div><dt>Status</dt><dd>${esc(statusText(item))}</dd></div>
                <div><dt>Last sale</dt><dd>${f.lastSale ? `${usd(f.lastSale.price)} · ${fmtDate(f.lastSale.at)}` : "Never sold"}</dd></div>
                <div><dt>Recorded on</dt><dd>${esc(CFG.chainName)}</dd></div>
              </dl>
            </div>
          </div>
          <div class="cert-bottom">
            <div class="cert-qr">${qrSvg(url)}<small>Scan to verify</small></div>
            <div class="cert-seal">
              <strong>✓ Verified record on Arc</strong>
              <p>This passport lives in a verified smart contract. Its details can't be edited, and every change of owner is recorded only when a buyer confirms delivery.</p>
              <div class="row">
                <button class="btn ghost small" data-action="copy-link" data-id="${id}">Copy link</button>
                <a class="btn ghost small" href="${explorerAddr(CFG.contractAddress)}" target="_blank" rel="noopener">See the contract on Arc ↗</a>
              </div>
            </div>
          </div>
        </article>
        <div class="h-label">Ownership history</div>
        <ul class="timeline">${timelineHtml(item)}</ul>
        ${item.status === STATUS.LISTED ? `
          <div class="callout info pp-cta">
            <span>This piece is for sale for <strong>${usd(item.price)}</strong>. The money is held until it arrives.</span>
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
      <div class="facts">
        <div class="fact"><small>Current owner</small><strong>${esc(nameOf(item.owner))}</strong></div>
        <div class="fact"><small>Status</small><strong data-status></strong></div>
        <div class="fact"><small>Owners so far</small><strong>${f.owners}</strong></div>
        <div class="fact"><small>Last sale</small><strong>${f.lastSale ? usd(f.lastSale.price) : "Never sold"}</strong></div>
      </div>
      <div data-actions></div>
      <div class="h-label">Ownership history</div>
      <ul class="timeline">${timelineHtml(item)}</ul>
    `);
    state.openItemId = id;
    refreshDetailActions();
  }

  function refreshDetailActions() {
    const box = $("[data-actions]");
    const statusEl = $("[data-status]");
    const item = itemById(state.openItemId);
    if (!box || !item) return;
    const isOwner = same(item.owner, myAddr());
    const isBuyer = same(item.buyer, myAddr());
    const dis = state.busy ? "disabled" : "";
    statusEl.textContent =
      item.status === STATUS.LISTED ? `For sale · ${usd(item.price)}`
      : item.status === STATUS.PENDING ? `Paid · ${usd(item.price)} held`
      : "In wardrobe";

    let html = "";
    if (isOwner && item.status === STATUS.OWNED) {
      html = `
        <div class="field">
          <label for="list-price">Sell this piece</label>
          <div class="row">
            <div class="money-input"><span>$</span><input id="list-price" type="number" min="0.01" step="0.01" placeholder="Price, e.g. 15"></div>
            <button class="btn gold" data-action="list" data-id="${item.id}" ${dis}>List for sale</button>
          </div>
          <span class="hint">The passport and its history go to the buyer once they confirm delivery.</span>
        </div>`;
    } else if (isOwner && item.status === STATUS.LISTED) {
      html = `
        <div class="callout info">Listed for <strong>${usd(item.price)}</strong>. Buyers see it in “Shop pre-owned”.</div>
        <button class="btn ghost block" data-action="unlist" data-id="${item.id}" ${dis}>Take it off sale</button>`;
    } else if (isOwner && item.status === STATUS.PENDING) {
      html = `
        <div class="callout held"><strong>${esc(nameOf(item.buyer))} paid ${usd(item.price)}.</strong> The money is held safely and comes to you as soon as they confirm the piece arrived. Time to ship it!</div>
        <button class="btn danger block" data-action="seller-cancel" data-id="${item.id}" ${dis}>Can't ship it? Cancel and refund the buyer</button>`;
    } else if (isBuyer && item.status === STATUS.PENDING) {
      const refundAt = Number(item.paidAt) + REFUND_DAYS * 86400;
      const canRefund = Date.now() / 1000 >= refundAt;
      html = `
        <div class="callout held">You paid <strong>${usd(item.price)}</strong>. It's held safely until you confirm the piece arrived.</div>
        <div class="actions-col">
          <button class="btn gold block" data-action="confirm" data-id="${item.id}" ${dis}>I received it: release ${usd(item.price)} to ${esc(nameOf(item.owner))}</button>
          ${canRefund
            ? `<button class="btn danger block" data-action="claim-refund" data-id="${item.id}" ${dis}>It never came: get my money back</button>`
            : `<span class="fine">If it never arrives, you can take your money back from ${fmtDate(refundAt)}.</span>`}
        </div>`;
    } else if (item.status === STATUS.LISTED) {
      html = `<button class="btn gold block" data-action="buy" data-id="${item.id}" ${dis}>Buy for ${usd(item.price)}</button>`;
    } else if (item.status === STATUS.PENDING) {
      html = `<div class="callout info">Someone has already paid for this piece.</div>`;
    }
    if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
  }

  // ------------------------------------------------------------ photos
  // Crops to 4:3, shrinks and compresses until it fits in the passport.
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
      for (const [w, q] of [[240, 0.7], [208, 0.66], [184, 0.6], [160, 0.56], [140, 0.5], [120, 0.45]]) {
        canvas.width = w;
        canvas.height = Math.round(w * 3 / 4);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        let data = canvas.toDataURL("image/webp", q);
        if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= MAX_PHOTO_CHARS) return data;
      }
      throw new Error("too detailed");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // Rough fee for storing the photo on Arc (storage ~22k gas per 32 bytes, 20 gwei base fee)
  const photoFee = (chars) => (Math.ceil(chars / 32) * 22100 + chars * 16) * 21e-9;

  // -------------------------------------------------------------- add item
  function openAddItem() {
    const picks = Object.entries(ICONS).map(([k, v], idx) => `
      <div><input type="radio" name="kind" id="kind-${k}" value="${k}" ${idx === 0 ? "checked" : ""}>
      <label for="kind-${k}"><svg viewBox="0 0 64 64">${v.svg}</svg>${v.label}</label></div>`).join("");
    const samples = SAMPLES.map((s, i) => `<button type="button" class="sample" data-sample="${i}">${esc(s.name)}</button>`).join("");
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
              <input id="f-photo" type="file" accept="image/*" capture="environment" hidden>
              <button type="button" class="linkish" id="f-photo-clear" hidden>Remove photo</button>
              <p class="hint" id="f-photo-hint">The photo is shrunk and saved inside the passport on Arc, so every future buyer sees the real piece.</p>
            </div>
          </div>
        </div>
        <div class="field" id="f-kind-wrap"><label>Or pick an icon</label><div class="icon-pick">${picks}</div></div>
        <label class="check"><input id="f-sell" type="checkbox"> List it for sale now</label>
        <div class="field" id="f-price-wrap" hidden>
          <label for="f-price">Price</label>
          <div class="money-input"><span>$</span><input id="f-price" type="number" min="0.01" step="0.01" placeholder="e.g. 15"></div>
        </div>
        <p class="hint" id="f-error" style="color:var(--err);min-height:1em;margin:0 0 8px"></p>
        <button class="btn primary block" type="submit" ${state.busy ? "disabled" : ""}>Add to wardrobe</button>
      </form>`, (m) => {
      const sell = $("#f-sell", m);
      const err = $("#f-error", m);
      sell.addEventListener("change", () => ($("#f-price-wrap", m).hidden = !sell.checked));
      $("#f-name", m).focus();

      m.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", () => {
        const s = SAMPLES[Number(b.dataset.sample)];
        $("#f-name", m).value = s.name;
        $("#f-brand", m).value = s.brand;
        $("#f-details", m).value = s.details;
        const r = $(`#kind-${s.kind}`, m); if (r) r.checked = true;
        sell.checked = true;
        $("#f-price-wrap", m).hidden = false;
        $("#f-price", m).value = s.price;
      }));

      const setPhoto = (data) => {
        photoData = data;
        $("#f-prev", m).innerHTML = data ? `<img src="${data}" alt="Photo preview">` : "<span>No photo</span>";
        $("#f-photo-clear", m).hidden = !data;
        $("#f-kind-wrap", m).hidden = !!data;
        $("#f-photo-hint", m).textContent = data
          ? `Saved inside the passport on Arc (${(data.length / 1024).toFixed(1)} KB, adds about $${photoFee(data.length).toFixed(2)} to the fee).`
          : "The photo is shrunk and saved inside the passport on Arc, so every future buyer sees the real piece.";
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
        const price = parseFloat($("#f-price", m).value);
        if (!name) { err.textContent = "Please give the piece a name."; return; }
        if (sell.checked && !(price > 0)) { err.textContent = "Please enter a price above $0."; return; }
        if (!(await hasGasMoney(photoData ? 0.25 : 0.01))) { err.textContent = "You need a few cents of test dollars first. Tap “Add money”."; return; }
        closeModal();
        const rc = await runTx({
          pending: `Creating the passport for “${name}”…`,
          done: `“${name}” is in your wardrobe, with its passport.`,
          send: (c) => c.createPassport(name, brand, details, photoData || `icon:${kind}`),
        });
        if (rc && sell.checked) {
          const created = rc.logs.map((l) => { try { return state.contract.interface.parseLog(l); } catch (_) { return null; } })
            .find((x) => x && x.name === "PassportCreated");
          if (created) {
            const id = Number(created.args.id);
            await runTx({
              pending: `Listing “${name}” for ${usd(toWei(price.toFixed(2)))}…`,
              done: `“${name}” is now for sale.`,
              send: (c) => c.listForSale(id, toWei(price.toFixed(2))),
            });
          }
        }
      });
    });
  }

  async function hasGasMoney(dollars) {
    const bal = await state.provider.getBalance(myAddr()).catch(() => 0n);
    return bal >= toWei(String(dollars));
  }

  // ------------------------------------------------------------------- buy
  function openBuy(id) {
    const item = itemById(id);
    if (!item) return;
    const f = facts(item);
    const bal = state.balances[state.current] ?? 0n;
    const enough = bal >= item.price + toWei("0.01");
    openModal("Buy this piece", `
      ${art(item)}
      <h4 class="detail-title">${esc(item.name)}</h4>
      <p class="detail-brand">${esc(item.brand)} · sold by ${esc(nameOf(item.owner))} · ${f.owners} owner${f.owners === 1 ? "" : "s"} so far</p>
      <div class="callout held">
        <strong>${usd(item.price)} is held safely, not sent straight to the seller.</strong><br>
        ${esc(nameOf(item.owner))} gets paid only when you confirm the piece arrived. If it never comes, you can take your money back after ${REFUND_DAYS} days.
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

  // ------------------------------------------------------------ how it works
  function openHow() {
    openModal("How it works on Arc", `
      <ol class="how-list">
        <li><strong>Every piece gets a passport.</strong> Its name, brand, details, photo, owner and full ownership history are stored in a verified smart contract on Arc. The details can't be edited after the passport is issued.</li>
        <li><strong>Payment is held, not sent.</strong> When a buyer pays, the dollars go into the contract, not to the seller. Nobody can move them except by the rules below.</li>
        <li><strong>Released on delivery.</strong> When the buyer taps “I received it”, the contract pays the seller and moves the passport to the buyer in the same step, adding the sale to its history.</li>
        <li><strong>If something goes wrong.</strong> The seller can cancel and refund the buyer. If nothing arrives within ${REFUND_DAYS} days, the buyer can take the money back without the seller.</li>
        <li><strong>Why Arc.</strong> On Arc, USDC (digital dollars) is the native currency, so there's no separate crypto token to buy for fees. Most actions cost under a cent (saving a photo in the passport costs a few cents), and each one is final in under a second.</li>
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
    openModal(`Add test dollars for ${person(state.current).name}`, `
      <p style="margin-top:0">This demo runs on Arc's test network, so the dollars are free test USDC. In a real launch, people would add money with a card or bank transfer.</p>
      <div class="facts">
        <div class="fact"><small>${esc(person(state.current).name)}'s balance</small><strong>${usd(state.balances[state.current])}</strong></div>
        <div class="fact"><small>Network fee per action</small><strong>under $0.01 (photo: a few cents)</strong></div>
      </div>
      ${hasMM ? `
        <div class="h-label">Fastest: send from your MetaMask</div>
        <div class="row">
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

  async function topUp(amount) {
    const eth = window.ethereum;
    const to = myAddr();
    const who = person(state.current).name;
    const t = toast(`Sending $${amount} from MetaMask to ${who}…`, "pending");
    try {
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
      const signer = await new ethers.BrowserProvider(eth).getSigner();
      const tx = await signer.sendTransaction({ to, value: toWei(amount) });
      const rc = await tx.wait();
      updateToast(t, `${who} received $${amount}.`, "ok", rc.hash);
      closeModal();
      await refresh();
    } catch (e) {
      console.error(e);
      updateToast(t, e?.code === 4001 || e?.code === "ACTION_REJECTED" ? "Cancelled in MetaMask." : "Couldn't send from MetaMask. Is it on Arc Testnet with some USDC?", "error");
    }
  }

  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch (_) { toast("Couldn't copy. Select it and copy it by hand.", "error"); }
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-persona],[data-tab],[data-tab-go],[data-open],[data-action]");
    if (!el) return;

    if (el.dataset.persona) {
      state.current = el.dataset.persona;
      lsSet(LS.current, state.current);
      closeModal();
      render();
      return;
    }
    if (el.dataset.tab || el.dataset.tabGo) {
      state.tab = el.dataset.tab || el.dataset.tabGo;
      lsSet(LS.tab, state.tab);
      closeModal();
      render();
      return;
    }
    if (el.dataset.open) { openDetail(Number(el.dataset.open)); return; }

    const id = Number(el.dataset.id);
    const item = itemById(id);
    switch (el.dataset.action) {
      case "add-item": openAddItem(); break;
      case "how": openHow(); break;
      case "add-money": openAddMoney(); break;
      case "copy-addr": copy(myAddr(), "Account number copied."); break;
      case "copy-link": copy(passportUrl(id), "Passport link copied."); break;
      case "share": closeModal(); location.hash = `passport=${id}`; break;
      case "leave-public": leavePublic(); break;
      case "public-buy":
        leavePublic();
        state.tab = "shop"; lsSet(LS.tab, "shop"); render();
        if (item && !same(item.owner, myAddr())) openBuy(id);
        break;
      case "topup": topUp(el.dataset.amount); break;
      case "buy": openBuy(id); break;
      case "pay":
        closeModal();
        if (await runTx({
          pending: `Paying ${usd(item.price)}. The money will be held until delivery…`,
          done: `Paid! ${usd(item.price)} is held safely until you confirm “${item.name}” arrived.`,
          send: (c) => c.buy(id, { value: item.price }),
        })) { state.tab = "orders"; lsSet(LS.tab, "orders"); render(); }
        break;
      case "list": {
        const price = parseFloat($("#list-price")?.value);
        if (!(price > 0)) { toast("Please enter a price above $0.", "error"); return; }
        await runTx({
          pending: `Listing “${item.name}” for ${usd(toWei(price.toFixed(2)))}…`,
          done: `“${item.name}” is now for sale.`,
          send: (c) => c.listForSale(id, toWei(price.toFixed(2))),
        });
        break;
      }
      case "unlist":
        await runTx({ pending: "Taking it off sale…", done: `“${item.name}” is back in your wardrobe.`, send: (c) => c.cancelListing(id) });
        break;
      case "confirm":
        closeModal();
        if (await runTx({
          pending: `Releasing ${usd(item.price)} to ${nameOf(item.owner)} and moving the passport to you…`,
          done: `Done! ${nameOf(item.owner)} got ${usd(item.price)}, and “${item.name}” is now in your wardrobe.`,
          send: (c) => c.confirmDelivery(id),
        })) { state.tab = "wardrobe"; lsSet(LS.tab, "wardrobe"); render(); }
        break;
      case "seller-cancel":
        closeModal();
        await runTx({ pending: "Refunding the buyer…", done: "The buyer got their money back. The piece is listed again.", send: (c) => c.sellerCancelSale(id) });
        break;
      case "claim-refund":
        closeModal();
        await runTx({ pending: "Taking your money back…", done: "Your money is back in your balance.", send: (c) => c.buyerClaimRefund(id) });
        break;
    }
  });

  // ------------------------------------------------------------------ start
  async function start() {
    const m = /^#passport=(\d+)$/.exec(location.hash);
    state.publicId = m ? Number(m[1]) : null;
    render();
    try {
      await connect();
      loadPersonas();
      await refresh();
      setInterval(() => { if (!state.busy && !document.hidden) refresh(); }, CFG.refreshMs);
    } catch (e) {
      state.fatal = e.message || String(e);
      render();
    }
  }

  // Small hook for automated tests and debugging (no secrets exposed).
  window.WP = { state, refresh, addresses: () => Object.fromEntries(PERSONAS.map((p) => [p.id, state.wallets[p.id]?.address])) };

  start();
})();
