# Wardrobe Passport

**Every piece you own gets a digital passport. When you sell it, the buyer's payment is held until the item arrives — then the money and the item's history move together.**

- **Live app:** https://wardrobe-passport.netlify.app
- **Contract (Arc Testnet, verified):** [`0x5627949F0F72404DecCABcd639A48cbea243B1F0`](https://explorer.testnet.arc.io/address/0x5627949F0F72404DecCABcd639A48cbea243B1F0)
- **Track:** Consumer Applications · **Chain award:** Best use of Arc
- Built for the UBC 2026 hackathon (University Blockchain Conference, UT Austin)

---

## The problem

Buying pre-owned clothes, shoes, bags or watches from a stranger comes down to trust:

- **Buyers** worry the item never arrives or isn't what was promised.
- **Sellers** worry about not getting paid.
- **The item's story is lost.** Who owned it, when, and what it sold for disappears with every sale, even though that history is what proves it's real and holds its value.

Marketplaces solve part of this, but only inside their own app. People who trade directly have no protection at all.

## How it works

1. **Add a piece** to your wardrobe. It gets a passport on Arc: what it is, the brand, details such as size or serial number, and a **photo of the actual piece** (compressed to a few KB and stored inside the passport, so every future buyer sees the real item).
2. **List it for sale.** A buyer pays in dollars. **The money is held by the contract**, not sent to the seller.
3. **The buyer confirms it arrived.** In one transaction, the seller is paid and the passport, including its full ownership history, moves to the buyer.

If something goes wrong:

- The seller can't ship → the seller cancels and the buyer is refunded.
- Nothing arrives → after 14 days the buyer can take the money back without the seller's permission.

Every passport also has a **public page with a QR code** (`/#passport=<id>`). Anyone can scan or open it, with no account, to check the piece's photo, details, current owner, last sale price and full ownership history, read live from Arc. Think of a tag on a jacket or a card in a watch box.

Users never see a wallet, gas or a crypto address. They see their balance in dollars, a **Pay** button and an **I received it** button.

## Why Arc

| Arc feature | What it does for this app |
| --- | --- |
| **USDC is the native currency** | Prices, balances and fees are all in dollars. No second token to buy for gas, so the crypto stays invisible. |
| **Fees around a cent** | Listing, paying and confirming each cost well under $0.01; storing a photo in the passport costs a few cents. The app shows the fee after every action. Small resale items make sense. |
| **Sub-second, deterministic finality** | "Paid" and "Delivered" update almost instantly. No waiting for confirmations. |
| **EVM compatible + Blockscout explorer** | Standard Solidity, verified source code anyone can read on the explorer. |

The contract also handles two Arc specifics from Arc's docs:

- **Native USDC uses 18 decimals.** All amounts are tracked in `msg.value` units (1 USDC = 1e18) and never mixed with the 6-decimal ERC-20 view.
- **A native transfer can be rejected** (for example to a blocklisted address). Payouts never block a sale: if paying the seller or refunding the buyer fails, the amount is kept in `owed` and can be collected later with `withdraw()`.

## The contract

[`contracts/WardrobePassport.sol`](contracts/WardrobePassport.sol)

| Function | Who | What it does |
| --- | --- | --- |
| `createPassport(name, brand, details, imageUrl)` | Anyone | Adds an item and starts its history |
| `listForSale(id, price)` | Owner | Puts the item up for sale |
| `cancelListing(id)` | Owner | Takes it off sale (before anyone pays) |
| `buy(id)` *(payable)* | Buyer | Pays the exact price; the money is held |
| `confirmDelivery(id)` | Buyer | Pays the seller and moves ownership + history to the buyer |
| `sellerCancelSale(id)` | Seller | Can't ship: refunds the buyer |
| `buyerClaimRefund(id)` | Buyer | After 14 days without delivery: refund |
| `withdraw()` | Anyone owed money | Collects a payout that couldn't be sent directly |
| `getItem(id)`, `getHistory(id)` | Anyone | Read an item and its ownership history |

Design notes:

- **Checks-effects-interactions:** state is updated before any money moves.
- **Custom errors** (`NotOwner`, `WrongStatus`, `WrongAmount`…) that the app turns into plain-English messages.
- **Events** for every step (`PassportCreated`, `Purchased`, `DeliveryConfirmed`, `Refunded`…), visible on the explorer.

## The app

A static web app in [`app/`](app) with no build step: HTML, CSS and JavaScript using ethers.js.

- **Live totals from Arc:** passports issued, sales completed, dollars paid out safely and dollars held right now.
- **My wardrobe:** your pieces with photo, status and provenance ("Last sold $40 · 2 owners").
- **Add a piece:** take or choose a photo (cropped and compressed in the browser to fit in the passport), or pick an icon; quick-fill samples for demos; optionally list it straight away.
- **Shop pre-owned:** pieces other people listed, with **Buy**. The buy screen explains that the money is held, not sent.
- **Orders:** what's on its way to you (**I received it**, refund after 14 days), what you've sold and need to ship (or refund), and a completed history of purchases and sales.
- **Item passport:** owner, status, last sale and the full ownership timeline, plus **Share passport**.
- **Public passport page:** certificate-style page with QR code and copy-link, readable by anyone.
- **How it works on Arc:** a one-screen explainer for first-time visitors and judges.
- Every confirmation shows the **network fee** and a **View on Arc** link to the transaction on the explorer.

**Demo accounts.** To show both sides of a sale, the app has two demo people, Maya and Alex. Each has an in-app wallet created in the browser, so nobody needs MetaMask to use the app. "Add money" tops them up with free test USDC from Circle's faucet, or from the presenter's MetaMask. In a real launch this would be replaced by email sign-in with Circle's user-controlled wallets and a card or bank on-ramp.

## Run it yourself

**Use the live app:** https://wardrobe-passport.netlify.app. Give the demo accounts test dollars with **+ Add money** (Circle faucet: https://faucet.circle.com, choose Arc Testnet + USDC).

**Run the app locally:**

```bash
python -m http.server 8080 --directory app
# open http://localhost:8080
```

**Deploy your own contract:** open `contracts/WardrobePassport.sol` in [Remix](https://remix.ethereum.org), compile, deploy with MetaMask on Arc Testnet (chain ID `5042002`, RPC `https://rpc.testnet.arc.io`), then put the new address in `app/config.js`.

## Tests

```bash
npm install
npm test                  # 20 contract checks on a local chain
```

The contract tests cover the full sale, resale (history grows), wrong amounts, wrong callers, seller refunds, the 14-day buyer refund and a rejected payout that is kept safe and withdrawn later.

`test/e2e.py` runs the whole story in a real browser against a local chain (`npm run devchain`, `npm run serve`, then `python test/e2e.py`):

- Maya adds a blazer **with a photo** (checked to be stored in the passport) and lists it for $40; fees are shown.
- Alex pays; Maya is **not** paid yet and her Orders tab says "paid to you when they confirm delivery"; the live total shows $40 held.
- Alex confirms; Maya receives **exactly $40**, the passport and history move to Alex, live totals update.
- The public passport page shows the certificate, QR code and "Maya → Alex for $40"; the link is shareable.
- Orders show "Bought … −$40" for Alex and "Sold … +$40" for Maya; Alex relists for $55 (resale).
- A quick-fill sample piece is listed, and its public page leads straight to buying.

## Project structure

```
contracts/WardrobePassport.sol   the smart contract
app/                             the web app (index.html, app.js, styles.css, config.js, abi.js)
app/vendor/                      ethers.js and qrcode-generator (both MIT), bundled so there's no build step
test/run-tests.js                contract tests
test/e2e.py                      browser end-to-end test
test/devchain.js                 local test chain with the contract deployed
```

## What's next

- Email sign-in with user-controlled wallets and a card on-ramp, so real people can use it.
- Passports issued by brands or verified authenticators for high-value items such as watches and bags (a blockchain record can't prove a physical item is genuine by itself).
- Connection points for resale platforms and brand take-back programs, and readiness for the EU Digital Product Passport rules for textiles.

## About

Built by Sarvendra Agarwal (Emory Goizueta MBA) as a companion concept to *Wardrobe Wallet*, a digital wardrobe app he is building. All code in this repository was written during the hackathon.

© 2026 Sarvendra Agarwal. All rights reserved.
