import * as fs from "fs";
import * as path from "path";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";

const GL = "erd158rt37truyh2yl5s0fp83nw9u2llmsxhr8g298eugt9x0w03d23qc8n9ng";
const API = "https://api.battleofnodes.com";
const GATEWAY = "https://gateway.battleofnodes.com";
const GAS_LIMIT = BigInt(50_000);
const GAS_PRICE = BigInt(1_000_000_000);
const FEE = GAS_LIMIT * GAS_PRICE;
const txComputer = new TransactionComputer();

async function getBalance(addr: string): Promise<{balance: bigint, nonce: number}> {
  const res = await fetch(`${API}/accounts/${addr}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const d: any = await res.json();
  return { balance: BigInt(d.balance), nonce: d.nonce };
}

async function sendTx(tx: any): Promise<void> {
  const res = await fetch(`${GATEWAY}/transaction/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tx),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Send failed: ${t.substring(0,100)}`);
  }
}

async function main() {
  const wallets: { privateKey: string; address: string }[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets_part1.json"), "utf-8")
  );

  console.log(`🔄 Recovering ${wallets.length} wallets → GL (raw HTTP, no SDK provider)`);

  // Test first
  const test = await getBalance(wallets[0].address);
  console.log(`🧪 wallet[0]: ${Number(test.balance)/1e18} EGLD, nonce=${test.nonce}`);

  let recovered = 0, skipped = 0, errors = 0, totalEGLD = BigInt(0);

  for (let i = 0; i < wallets.length; i += 25) {
    const batch = wallets.slice(i, i + 25);
    await Promise.all(batch.map(async (w) => {
      try {
        const { balance, nonce } = await getBalance(w.address);
        if (balance <= FEE) { skipped++; return; }

        const sendAmt = balance - FEE;
        const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
        const sender = new Address(w.address);
        const receiver = new Address(GL);

        const tx = new Transaction({
          nonce: BigInt(nonce),
          sender,
          receiver,
          value: sendAmt,
          gasLimit: GAS_LIMIT,
          gasPrice: GAS_PRICE,
          chainID: "B",
        });
        tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));

        // Raw JSON for gateway
        const txJson = {
          nonce,
          value: sendAmt.toString(),
          receiver: GL,
          sender: w.address,
          gasPrice: Number(GAS_PRICE),
          gasLimit: Number(GAS_LIMIT),
          signature: Buffer.from(tx.signature).toString("hex"),
          chainID: "B",
          version: 1,
        };

        await sendTx(txJson);
        recovered++;
        totalEGLD += sendAmt;
        process.stdout.write(`✅`);
      } catch (e: any) {
        if (errors < 3) console.log(`\n⚠️ ${w.address.substring(0,20)}... : ${e.message?.substring(0,100)}`);
        errors++;
        process.stdout.write(`❌`);
      }
    }));
    process.stdout.write(` [${Math.min(i+25,wallets.length)}/${wallets.length}] ✅${recovered} ⏭${skipped} ❌${errors}\n`);
  }

  console.log(`\n🏦 Recovered: ${recovered} wallets`);
  console.log(`💰 Total: ${Number(totalEGLD) / 1e18} EGLD → GL`);
  console.log(`⏭ Skipped: ${skipped} empty | ❌ Errors: ${errors}`);
}

main().catch(e => console.error("FATAL:", e));
