import * as fs from "fs";
import * as path from "path";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";

const GATEWAY = "https://gateway.battleofnodes.com";

async function main() {
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8"));
  const provider = new ProxyNetworkProvider(GATEWAY, { timeout: 15000 } as any);

  let funded = 0, empty = 0, totalBalance = BigInt(0);
  const emptyList: number[] = [];

  for (let i = 0; i < wallets.length; i += 50) {
    const batch = wallets.slice(i, Math.min(i + 50, wallets.length));
    const results = await Promise.all(
      batch.map(async (w: any, idx: number) => {
        try {
          const acc = await provider.getAccount({ bech32: () => w.address });
          return { index: i + idx, balance: acc.balance.toFixed() };
        } catch { return { index: i + idx, balance: "0" }; }
      })
    );
    for (const r of results) {
      const bal = BigInt(r.balance);
      if (bal > 0) { funded++; totalBalance += bal; }
      else { empty++; emptyList.push(r.index); }
    }
    process.stdout.write(`\r  Scanned ${Math.min(i + 50, wallets.length)}/${wallets.length}...`);
  }

  const egld = Number(totalBalance / BigInt("1000000000000000")) / 1000;
  console.log(`\n\n${"═".repeat(50)}`);
  console.log(`✅ Funded:     ${funded}/500`);
  console.log(`❌ Empty:      ${empty}/500`);
  console.log(`💰 Total bal:  ${egld.toFixed(4)} EGLD`);
  console.log(`${"═".repeat(50)}`);
  if (emptyList.length > 0 && emptyList.length <= 20) {
    console.log(`Empty indices: ${emptyList.join(", ")}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
