import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner, Mnemonic } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const GL = "erd158rt37truyh2yl5s0fp83nw9u2llmsxhr8g298eugt9x0w03d23qc8n9ng";
const GATEWAY = process.env.KEPLER_GATEWAY || "https://gateway.battleofnodes.com";
const GAS_LIMIT = BigInt(50_000);
const GAS_PRICE = BigInt(1_000_000_000);
const FEE = GAS_LIMIT * GAS_PRICE;
const txComputer = new TransactionComputer();

async function main() {
  const provider = new ProxyNetworkProvider(GATEWAY, { timeout: 10000 });
  const wallets: { mnemonic: string; address: string }[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets_part1.json"), "utf-8")
  );

  console.log(`🔄 Recovering from ${wallets.length} wallets → GL`);
  console.log(`🌐 Gateway: ${GATEWAY}`);

  let recovered = 0;
  let totalRecovered = BigInt(0);
  const BATCH = 25;

  for (let i = 0; i < wallets.length; i += BATCH) {
    const batch = wallets.slice(i, i + BATCH);
    const promises = batch.map(async (w) => {
      try {
        const acc = await provider.getAccount(Address.newFromBech32(w.address));
        const balance = BigInt(acc.balance.toString());
        if (balance <= FEE) return;

        const sendAmount = balance - FEE;
        const sk = Mnemonic.fromString(w.mnemonic).deriveKey(0);
        const signer = new UserSigner(sk);

        const tx = new Transaction({
          nonce: BigInt(acc.nonce),
          receiver: Address.newFromBech32(GL),
          sender: Address.newFromBech32(w.address),
          value: sendAmount,
          gasLimit: GAS_LIMIT,
          gasPrice: GAS_PRICE,
          chainID: "B",
        });

        tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
        await provider.sendTransaction(tx);
        recovered++;
        totalRecovered += sendAmount;
        process.stdout.write(`✅`);
      } catch (e: any) {
        process.stdout.write(`❌`);
      }
    });
    await Promise.all(promises);
    process.stdout.write(` [${Math.min(i + BATCH, wallets.length)}/${wallets.length}]\n`);
  }

  console.log(`\n🏦 Recovered: ${recovered} wallets`);
  console.log(`💰 Total: ${Number(totalRecovered) / 1e18} EGLD`);
  console.log(`⏳ Wait 30s for on-chain confirmation...`);
}

main().catch(console.error);
