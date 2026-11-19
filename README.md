# Wardrobe Passport

**A closed resale community for pre-owned watches and jewelry on Arc. Members join by invitation and have their ID checked in person. Every piece is authenticated by a specialist in its category, who stakes a bond behind the stamp. The buyer's money is held until the piece arrives, and buyers can add 90 days of protection priced on-chain from everyone's record. If something goes wrong, a panel of members or a second specialist decides, and the contracts carry out the decision.**

- **Live app:** https://wardrobe-passport.vercel.app
- **Marketplace contract V3 (Arc Testnet, verified):** [`0xF3ef3709C7D14e5b86B1C9e2B4a37ad97D7b9Ccf`](https://explorer.testnet.arc.io/address/0xF3ef3709C7D14e5b86B1C9e2B4a37ad97D7b9Ccf)
- **Protection contract:** `contracts/WardrobeProtection.sol` (address in the app footer once deployed)
- **Track:** Consumer Applications · **Chain award:** Best use of Arc · **Bounty:** Best use of QuickNode Streams
- Built for the UBC 2026 hackathon (University Blockchain Conference, UT Austin)

---

## The problem

Buying a second-hand watch or piece of jewelry from a stranger comes down to four questions: **Is it real? Will I get it? Who is this person? And who pays if the expert was wrong?** Marketplaces answer the first three inside their own walls. Nobody answers the fourth: an authenticator's stamp costs it nothing if it's wrong, and every buyer pays the same for protection no matter who they're buying from.

## How Wardrobe Passport answers them

| Question | Answer | Enforced by |
|---|---|---|
| Who is this person? | Invite-only membership. The inviter is recorded, and their record shows how the people they invited behaved | V3 (`registerMember`, `inviteesDisputesLost`) |
| Is this person real? | A partner authenticator checks a photo ID in person before a member can sell | V3 (`verifyMember`; only verified members can list) |
| Is the piece real? | A specialist in its category (watches, vintage watches, jewelry) authenticates it in person and certifies the category | V3 (`authenticate`) + Protection (`certify`, specialists only) |
| Will I get it? | The buyer's money is held by the contract; the seller locks a 10% deposit | V3 |
| What if the expert was wrong? | The authenticator's bond pays first. Buyers can add 90 days of protection after delivery, priced from the records | Protection (`buyCover`, `fileClaim`, `decideClaim`) |
| What if it goes wrong before delivery? | The buyer posts a 5% bond. 5 verified members are drawn at random. The first side to 3 votes wins; the contract pays out and rewards the majority voters | V3 (`openDispute`, `castVote`, `finalizeDispute`) |
| Can I check it myself? | Every member sees the community ledger. Each action links to its Arc transaction, and QuickNode Streams independently confirms it | Arc + QuickNode Streams |

## Protection

_Community protection on test dollars, not a licensed insurance product._

1. **Authenticators back their stamp with money.** Each partner stakes a bond. Every protected piece it stamped holds half the price plus 2% (the re-inspection fee) of that bond until its 90 days end.
2. **Protection that lasts after delivery.** V3 holds the money only until the buyer confirms. A buyer can add protection while the money is held; it covers them for 90 days after delivery.
3. **A price for trust.** The fee is calculated on-chain from three records, and members fund the pool that pays claims and earn the fees.
4. **Specialists by category.** Only a specialist can certify a piece, only a second specialist in the same category can rule on a claim, each category has its own base rate, and an authenticator's fakes are counted per category.

### Nobody can cheat for free

| Who | If they try to | What happens |
|---|---|---|
| Seller | List a fake | Loses the listing deposit if a dispute goes against them; every proven fake adds +5% to their protection price |
| Jeweler (authenticator) | Stamp a fake | Their bond pays the buyer first, and the fake is counted against them in that category |
| Buyer | Claim a genuine piece is fake | Posts a 5% deposit and loses it if a rival specialist rules the piece genuine; must still own the piece |
| Panel member | Vote against the evidence | Only members who vote with the outcome share the 2% panel reward |

**Conflict of interest:** a jeweler can't check a piece from its own wallet or from a member it invited. This is an app-level check today; on-chain enforcement is the next contract version.

### Rating table (share of the price)

`fee = category base + seller + inviter + authenticator`, kept between 1% and 20%.

| Part | Rule |
|---|---|
| Category base | Watches 3%, vintage watches 4%, jewelry 3%, handbags 3% (the admin can add clothing later) |
| Seller: new | +2% with no completed sales |
| Seller: experience | −0.25% per completed sale, up to −1.5% |
| Seller: losses | +3% per dispute lost, +1% per refund given |
| Seller: fakes | +5% per proven fake |
| Inviter | +1% per dispute lost by anyone the seller's inviter brought in, up to +3% |
| Authenticator | +4% per fake it stamped in this category; −0.5% with 10+ stamps and no fakes anywhere |

Examples (watches): a new seller pays 5%, or 6% on a vintage watch. Three clean sales and one refund: 3.25%. A new seller who lost a dispute: 9%. A seller with one fake, behind an authenticator with one fake: 11.75%.

### Money on a protected $100 piece with a 5% fee

| Step | What happens |
|---|---|
| Buyer adds protection | Pays $5 to the pool. $52 of the authenticator's bond and $50 of the pool are held |
| Sale completes | The 90 days start (the platform starts them automatically) |
| Sale cancelled or refunded | Protection cancelled, $5 refunded |
| Buyer files a claim | Posts a $5 deposit; must still own the piece |
| A second specialist rules it fake | Buyer gets $100 + $5 back: $50 from the bond, $50 from the pool. The reviewer earns $2 from the bond |
| The reviewer rules it genuine | Reviewer earns $2 from the deposit, $3 goes to the pool |
| No claim in 90 days | The held money is released |
| Nobody rules in 3 days | The platform admin may rule |

## QuickNode Streams

`Arc → QuickNode Streams (filter: logs from the V3 and Protection contracts) → /api/streams (HMAC-verified) → chain_events → ledger cross-check`

Our ledger comes from our own database. QuickNode Streams independently pushes every event both contracts emit; each ledger row shows **✓ Confirmed by QuickNode Streams** when the chain feed has it, and **Community → Chain feed** lists the raw events. The filter is in `streams/filter.js`; the webhook is `web/app/api/streams/route.ts`.

## Who uses it

One membership, with separate views:

- **Sell:** add pieces (with a category), get them authenticated by a specialist, list them, ship them, get paid. Shows your protection rate and why.
- **Buy:** marketplace (bond-backed badges, the protection price and "Why this price?"), orders, purchases (protection status, days left, "This is a fake").
- **Community:** ledger, chain feed, members (with each member's rate), protection (pool, stake and withdraw, every protected purchase), disputes, invites and credits.
- **Shop desk** (authenticators): front desk ID checks, pieces to verify, second opinions on other authenticators' stamps, bond, disputes, record.
- **Admin** (contract owner): overview, side by side, members with read-only "view as", specialists (approved with MetaMask), and setup.

## Tech

- **Contracts:** `contracts/WardrobePassportV3.sol` (19.5 KB) and `contracts/WardrobeProtection.sol` (19.1 KB, reads V3; V3 is unchanged). Solidity 0.8.24+, deployed with Remix and MetaMask, optimizer on, 200 runs.
- **App:** Next.js on Vercel. The API is in `web/app/api`; the screens are a static client in `web/public` using vanilla JS and ethers v6. If `PROTECTION_ADDRESS` is unset, every protection screen is hidden.
- **Wallets:** Circle developer-controlled wallets on Arc (USDC is the native currency). The platform treasury is V3's approved operator, and it starts or cancels protection when a sale ends.
- **Database:** Supabase Postgres (row level security on) stores members, sessions, invites, credits, flags, photos, piece categories, the activity log and the chain feed.
- **Tests:**
  - `npm run test:v3`: 35 contract checks for V3.
  - `npm run test:protection`: 27 contract checks for Protection, next to V3.
  - `node test/devchain-v3.js` plus the app, then `node test/api-v3.js`: 35 end-to-end API checks.
  - `node test/history-v3.js --full --protection`: plays the admin setup, community, history and protection demo.
  - `node test/streams-v3.js`: plays QuickNode Streams over the local chain through the real filter and webhook.
  - `python test/shots-protection.py`: a browser walkthrough of a protected purchase, a fake claim and a second opinion.

## Known limits (next version)

- The dispute panel is drawn from a hash of the dispute's own data. This keeps gas estimates exact but makes the panel predictable; the fix is a VRF or commit-reveal.
- ID checks are done by the authenticator; the next step is an ID-verification provider.
- The conflict-of-interest check runs in the app, not the contract; the next contract version enforces it on-chain.
- A proven fake stays with the buyer after the refund; a real launch would route it back to the authenticator.
- Test dollars only. A real launch needs money-transmission, marketplace, second-hand dealer and insurance-regulation review.

## Photo credits

Demo listing photos in `web/public/seed/` are free photos from [Pexels](https://www.pexels.com/license/) (Pexels IDs: 29298231, 10414975, 8839604, 1432234, 16739805, 33524465, 28977357, 33423909, 10591429, 11365012, 34399115, 2849742, 32988751), cropped to squares. They illustrate the category only; brands shown in a photo are not the listed piece. Pieces without a photo use our own 3D renders.
