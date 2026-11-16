# Wardrobe Passport

**A closed resale community on Arc. Members join by invitation, have their ID checked in person at a partner pawn shop, and trade pre-owned clothes, bags and watches with the buyer's money held until the item arrives. If something goes wrong, a panel of members decides, and the contract carries out their decision.**

- **Live app:** https://wardrobe-passport.vercel.app
- **Contract V3 (Arc Testnet, verified):** [`0xF3ef3709C7D14e5b86B1C9e2B4a37ad97D7b9Ccf`](https://explorer.testnet.arc.io/address/0xF3ef3709C7D14e5b86B1C9e2B4a37ad97D7b9Ccf)
- **Track:** Consumer Applications · **Chain award:** Best use of Arc
- Built for the UBC 2026 hackathon (University Blockchain Conference, UT Austin)

---

## The problem

Buying second-hand from a stranger comes down to three questions: **Is it real? Will I get it? Who is this person?** Marketplaces answer them inside their own walls with support teams and opaque decisions. People who trade directly have no protection at all.

## How Wardrobe Passport answers them

| Question | Answer | Enforced by |
|---|---|---|
| Who is this person? | Invite-only membership. The inviter is recorded, and their record shows how the people they invited behaved | Contract (`registerMember`, `inviteesDisputesLost`) |
| Is this person real? | A partner pawn shop checks a photo ID in person before a member can sell | Contract (`verifyMember`; only verified members can list) |
| Is the item real? | The pawn shop authenticates the piece in person, and the stamp goes on its passport | Contract (`authenticate`) + app (no listing without a fresh stamp) |
| Will I get it? | The buyer's money is held by the contract; the seller locks a 10% deposit | Contract |
| What if it goes wrong? | The buyer posts a 5% bond. 5 verified members are drawn at random (never the buyer, the seller, their inviters or the shop). The shop files an inspection report. The first side to 3 votes wins; the contract pays out and rewards the majority voters | Contract (`openDispute`, `castVote`, `finalizeDispute`) |
| Can I check it myself? | Every member sees the community ledger, and each action links to its Arc transaction | Arc (public chain) |

New members can buy items up to $50 until their ID is checked. If the panel is too small, splits evenly, or fewer than 3 vote in 48 hours, the pawn shop decides, with the admin as a last resort.

### Money on a $100 item

| Outcome | Buyer | Seller | Pawn shop | Panel |
|---|---|---|---|---|
| Normal sale | Gets the item | $97 + $10 deposit back | $3 | n/a |
| Panel sides with the buyer | $100 + $5 bond + $5 of the deposit | Loses the $10 deposit | $3 | $2 |
| Panel sides with the seller | Gets the item, loses the $5 bond | $97 + $10 deposit + $3 from the bond | $3 | $2 |

### Invites and credits

These follow common marketplace practice (eBay, Poshmark, Mercari, Depop, Vinted): 3 invites to start, plus 1 per clean completed sale (up to 10). New members get their first delivery free (up to $10). Inviters earn $5 of store credit after their invitee's first confirmed delivery. Nothing is paid when the inviter is also the seller, credit is capped at $100 a year, and credits expire after 90 days.

## Who uses it

One membership, with separate views:

- **Sell:** add pieces, get them authenticated, list them, ship them, get paid.
- **Buy:** marketplace, orders (confirm or dispute), purchases.
- **Community:** ledger, members (shown by who invited whom), disputes (vote when you're on a panel), invites and credits.
- **Shop desk** (pawn shops): front desk ID checks, pieces to verify, flagged listings, inspection reports, fallback decisions.
- **Admin** (contract owner): overview, a side-by-side view of sellers, buyers and shops, members with read-only "view as", and setup.

**Sign-in:** an invite link to join; a one-time email code after that; the admin signs a message with the contract's deployer wallet (MetaMask). "Try the demo" opens Maya (seller), Alex (buyer), the Demo Pawn Shop, or any seeded community member.

## Tech

- **Contract:** `contracts/WardrobePassportV3.sol`, Solidity 0.8.24+, deployed with Remix and MetaMask (optimizer on, 200 runs). It's 19.5 KB.
- **App:** Next.js on Vercel. The API is in `web/app/api`; the screens are a static client in `web/public` using vanilla JS and ethers v6.
- **Wallets:** Circle developer-controlled wallets on Arc (USDC is the native currency). The platform treasury is the contract's approved operator, which registers invited members.
- **Database:** Supabase Postgres stores members, sessions, invites, credits, flags, photos and the activity log. Item and membership facts live on-chain.
- **Tests:**
  - `node test/run-tests-v3.js`: 35 contract checks.
  - `node test/devchain-v3.js` plus the app, then `node test/api-v3.js`: 30 end-to-end API checks.
  - `python test/shots-v3.py`: a browser pass over every screen.

## Known limits (next version)

- The panel is drawn from a hash of the dispute's own data. This keeps gas estimates exact but makes the panel predictable; the fix is a VRF or commit-reveal.
- ID checks are done by the pawn shop; the next step is an ID-verification provider.
- Test dollars only. Real launch needs money-transmission, marketplace and pawn/second-hand dealer compliance (see the regulations page).
