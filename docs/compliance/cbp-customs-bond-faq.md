# CBP Customs Bond FAQ

> **Disclaimer:** This document is informational only and does not constitute legal, compliance, customs-brokerage, or financial advice. Customs bond requirements, thresholds, and enforcement practices are set by U.S. Customs and Border Protection (CBP) and its surety partners, and they change over time. Consult a licensed customs broker, surety, or attorney before making bonding decisions.

## What is a customs bond?

A customs bond is a three-party contract required by CBP before certain imports can enter the United States:

- **Principal (importer)** — the party legally responsible for paying duties, taxes, and fees owed to CBP.
- **Surety** — a company (often backed by an insurance carrier) that guarantees payment to CBP if the importer fails to pay.
- **CBP (obligee)** — the U.S. government agency the bond protects. If the importer defaults, CBP can claim against the bond, and the surety then seeks reimbursement from the importer.

The bond's legal purpose is to guarantee that duties, taxes, and fees on imported goods get paid even if the importer becomes unable or unwilling to pay directly.

There are two bond types:

- **Single-entry bond (SEB)** — covers one specific shipment/entry. Common for infrequent importers.
- **Continuous bond** — covers all of an importer's entries over a 12-month period across all U.S. ports. Cheaper per-shipment for importers with regular volume, and what TariffShield is designed around.

## Who needs a customs bond?

- CBP generally requires a bond for **commercial shipments valued at $2,500 or more**.
- Ocean freight shipments also require an **Importer Security Filing (ISF) bond** (a rider on the continuous bond, or a standalone ISF bond), covering the ISF "10+2" filing obligation.
- Common exemptions include shipments under the $2,500 commercial threshold, most personal/informal entries, and certain government or in-bond movements. Exemptions are fact-specific — confirm with your customs broker.

## How is bond amount calculated?

CBP's standard formula for a continuous bond is:

> **Bond face value = 10% of total duties, taxes, and fees paid in the prior 12 months, with a $50,000 minimum.**

(CBP can require a higher multiple — sometimes up to 3x — for importers in higher-risk categories, e.g. certain AD/CVD-covered goods.)

**How TariffShield maps to this:** TariffShield computes a required collateral amount from the importer's uploaded annual duty total using:

```
bond_face_value        = annual_duty_total × 10%
required_collateral_usd = bond_face_value × 50%
```

> **Technical details:** see the CBP tariff CSV upload handler in [`apps/api/src/routes/importers.ts`](../../apps/api/src/routes/importers.ts) (search for `bondFaceValue` / `requiredCollateralUSD`) for the exact implementation, and [`set_required_collateral` in `contracts/tariff-shield/src/lib.rs`](../../contracts/tariff-shield/src/lib.rs) for how the computed value is pushed on-chain by the oracle role.

In plain terms: TariffShield asks importers to post collateral equal to half of the CBP bond face value (itself 10% of annual duty), rather than the 50–100% cash collateral a traditional surety typically demands against the full bond amount. This is a product policy choice, not a CBP requirement — CBP's rule only governs the bond amount owed to the surety, not how much cash the surety asks the importer to post against it.

## What happens if the bond is insufficient?

If an importer's continuous bond falls below what CBP calculates is needed (e.g. import volume or duty rates rose), CBP issues a **bond insufficiency notice** (informally, a "bond sufficiency letter"). The importer/broker must then:

1. Obtain a **supplemental bond** (an additional rider covering the gap), or increase the continuous bond's face value with the surety, and
2. File it with CBP — usually within a set window.

Until resolved, CBP can place the importer's shipments on **release hold**, meaning goods sit at port accruing demurrage and detention (D&D) charges while the importer scrambles to get the surety to underwrite more bond.

**How TariffShield mitigates this:** TariffShield's `auto_top_up` contract entrypoint moves funds from the importer's on-chain **reserve** bucket into the **collateral** bucket automatically whenever the oracle-set `required_collateral` exceeds the current collateral balance — no surety re-underwriting cycle, no manual supplemental bond filing, and no waiting on release hold. See [`auto_top_up` in `contracts/tariff-shield/src/lib.rs`](../../contracts/tariff-shield/src/lib.rs).

## How does TariffShield differ from a traditional surety?

| | Traditional surety bond | TariffShield |
|---|---|---|
| Collateral instrument | Cash held in a non-interest-bearing escrow account at the surety | On-chain USDC-equivalent collateral, split into collateral + reserve buckets |
| Top-up on tariff spike | Manual: importer wires more cash or negotiates a supplemental bond with the surety (can take days) | Automatic: `auto_top_up` moves reserve → collateral on-chain in one transaction |
| Yield on idle collateral | None — surety escrow typically earns nothing for the importer | Reserve balance is designed to accrue yield (tokenized T-bill integration on the roadmap — see [PITCH.md](../../PITCH.md)) |
| Settlement speed | Days (paper/email-driven underwriting) | Minutes (Stellar/Soroban settlement) |
| Transparency | Importer relies on surety statements | Collateral/reserve balances and history are queryable on-chain (`get_collateral_history`) |
| Emergency clawback authority | Surety can call on the bond via legal/claims process | Surety retains a one-call on-chain `clawback` entrypoint — same authority, faster execution |

TariffShield does not replace the surety relationship or CBP's bond requirement — it replaces the **collateral instrument** the surety accepts, keeping the same clawback authority and regulatory posture.

## What data does CBP require?

CBP (directly, or via the ACE Portal / a licensed customs broker) requires importers to provide data including:

| CBP data field | TariffShield data model |
|---|---|
| Importer of Record number (EIN or CBP-assigned number) | `Importer` record — importer identity/EIN used for account registration |
| Bond type (continuous vs. single-entry) and bond ID | `bond_id` on the on-chain account (`register_importer`) |
| Harmonized Tariff Schedule (HTS) codes per line item | Uploaded CBP-format tariff CSV, parsed per [`docs/tariff-calculation.md`](../tariff-calculation.md) |
| Prior-year duties, taxes, and fees paid (for bond sizing) | `annual_duty_total` field on tariff upload, feeding the bond/collateral calculation |
| Computed/required bond or collateral amount | `required_collateral` (on-chain) / `computed_required_collateral` (API's audit trail) |

> **Technical details:** see the tariff CSV ingest and validation logic in [`apps/api/src/routes/importers.ts`](../../apps/api/src/routes/importers.ts) and the schema in [`apps/api/src/db.ts`](../../apps/api/src/db.ts) (`tariff_uploads`, `oracle_price_feed` tables).

---

Questions this FAQ doesn't answer? See [PITCH.md](../../PITCH.md) for the business case, [ARCHITECTURE.md](../../ARCHITECTURE.md) for the technical deep-dive, or open an issue.
