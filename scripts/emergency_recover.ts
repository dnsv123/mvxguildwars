import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const GL = "erd158rt37truyh2yl5s0fp83nw9u2llmsxhr8g298eugt9x0w03d23qc8n9ng";
const GATEWAY = "https://gateway.battleofnodes.com";
const GAS_LIMIT = BigInt(50_000);
const GAS_PRICE = BigInt(1_000_000_000);
const FEE = GAS_LIMIT * GAS_PRICE;
const txComputer = new TransactionComputer();

async function main() {
  const provider = new ProxyNetworkProvider(GATEWAY, { timeout: 15000 });
  const wallets: { privateKey: string; address: string }[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets_part1.json"), "utf-8")
  );

  console.log(`🔄 Recovering from ${wallets.length} wallets → GL`);

  // Test first wallet
  const testAddr = new Address(wallets[0].address);
  const testAcc = await provider.getAccount(testAddr as any);
  console.log(`🧪 wallet[0] balance: ${Number(BigInt(testAcc.balance.toString()))/1e18} EGLD, nonce: ${testAcc.nonce}`);

  let recovered = 0, skipped = 0, totalRecovered = BigInt(0);

  for (let i = 0; i < wallets.length; i += 25) {
    const batch = wallets.slice(i, i + 25);
    const promises = batch.map(async (w) => {
      try {
        const addr = new Address(w.address);
        const acc = await provider.getAccount(addr as any);
        const balance = BigInt(acc.balance.toString());
        if (balance <= FEE) { skipped++; return; }

        const sendAmount = balance - FEE;
        const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));

        const tx = new Transaction({
          nonce: BigInt(acc.nonce),
          receiver: new Address(GL),
          sender: addr,
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
        if (recovered === 0 && skipped < 3) console.log(`\n⚠️ ${e.message?.substring(0,120)}`);
        process.stdout.write(`❌`);
      }
    });
    await Promise.all(promises);
    process.stdout.write(` [${Math.min(i+25,wallets.length)}/${wallets.length}] ok=${recovered} skip=${skipped}\n`);
  }

  console.log(`\n🏦 Recovered: ${recovered} wallets (${skipped} empty)`);
  console.log(`💰 Total: ${Number(totalRecovered) / 1e18} EGLD`);
}

main().catch(e => console.error("FATAL:", e.message));
