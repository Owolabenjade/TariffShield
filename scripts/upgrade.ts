import { Command } from "commander";
import { env } from "../apps/api/src/config/env.js";
import { contractClient, platformKeypair } from "../apps/api/src/stellar.js";
import { runApprove, runPropose } from "./lib/upgrade-logic.js";

const program = new Command();

program
  .name("upgrade")
  .description("Multi-sig upgrade tool for TariffShield contract")
  .version("1.0.0");

program
  .command("propose")
  .description("Propose a new wasm hash for upgrade")
  .requiredOption("--hash <hex>", "New wasm hash in hex")
  .action(async (options) => {
    try {
      await runPropose(contractClient, platformKeypair, options.hash);
    } catch (e) {
      console.error("Error proposing upgrade:", e);
      process.exit(1);
    }
  });

program
  .command("approve")
  .description("Approve an existing upgrade proposal")
  .requiredOption("--id <number>", "Proposal ID")
  .requiredOption("--admin <number>", "Which admin is approving (1, 2, or 3)")
  .action(async (options) => {
    try {
      await runApprove(contractClient, options.admin, options.id, {
        platformKeypair,
        admin2Secret: env.ADMIN_2_SECRET,
        admin3Secret: env.ADMIN_3_SECRET,
      });
    } catch (e) {
      console.error("Error approving upgrade:", e);
      process.exit(1);
    }
  });

program.parse();
