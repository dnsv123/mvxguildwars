import { UserSigner } from "@multiversx/sdk-wallet";
import { Transaction, TransactionPayload, Address } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import * as fs from "fs";

const GL = "erd158rt37truyh2yl5s0fp83nw9u2llmsxhr8g298eugt9x0w03d23qc8n9ng";
const GATEWAY = "https://gateway.battleofnodes.com";
const GAS_LIMIT = BigInt(50_000);
const GAS_PRICE = BigInt(1_000_000_000);
const FEE = GAS_LIMIT * GAS_PRICE; // 50000000000000 = 0.00005 EGLD

async function main() {
  const provider = new ProxyNetworkProvider(GATEWAY, { timeout: 10000 });
  const wallets: { mnemonic: string; address: string }[] = JSON.parse(
    fs.readFileSync("/root/gw/wallets_part1.json", "utf-8")
  );

  console.log(`🔄 Recovering from ${wallets.length} wallets → GL`);

  let recovered = 0;
  let totalRecovered = BigInt(0);
  const BATCH = 25;

  for (let i = 0; i < wallets.length; i += BATCH) {
    const batch = wallets.slice(i, i + BATCH);
    const promises = batch.map(async (w) => {
      try {
        const acc = await provider.getAccount(new Address(w.address));
        const balance = BigInt(acc.balance.toString());
        if (balance <= FEE) return; // skip empty

        const sendAmount = balance - FEE;
        const signer = UserSigner.fromPem(
          `-----BEGIN PRIVATE KEY for ${w.address}-----\n` +
          Buffer.from(
            require("@multiversx/sdk-wallet").Mnemonic.fromString(w.mnemonic)
              .deriveKey(0)
              .hex(),
            "hex"
          ).toString("base64") +
          `\n-----END PRIVATE KEY for ${w.address}-----`
        );

        const tx = new Transaction({
          nonce: acc.nonce,
          receiver: new Address(GL),
          value: sendAmount,
          gasLimit: Number(GAS_LIMIT),
          gasPrice: Number(GAS_PRICE),
          chainID: "B",
        });

        const serialized = tx.serializeForSigning();
        const signature = await signer.sign(serialized);
        tx.applySignature(signature);

        await provider.sendTransaction(tx);
        recovered++;
        totalRecovered += sendAmount;
        process.stdout.write(`✅`);
      } catch (e: any) {
        process.stdout.write(`❌`);
      }
    });
    await Promise.all(promises);
  }

  console.log(`\n\n🏦 Recovered: ${recovered} wallets`);
  console.log(`💰 Total: ${Number(totalRecovered) / 1e18} EGLD`);
  console.log(`⏳ Wait 30s then check GL balance...`);
}

main().catch(console.error);
