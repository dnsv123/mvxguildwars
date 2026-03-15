import * as fs from "fs";
import * as path from "path";
import { Mnemonic } from "@multiversx/sdk-wallet";

const WALLET_COUNT = 500;
const OUTPUT_FILE = path.join(__dirname, "..", "wallets.json");

interface WalletEntry {
  address: string;
  privateKey: string;
}

function generateWallets(count: number): WalletEntry[] {
  const wallets: WalletEntry[] = [];

  for (let i = 0; i < count; i++) {
    const mnemonic = Mnemonic.generate();
    const secretKey = mnemonic.deriveKey();
    const publicKey = secretKey.generatePublicKey();
    const address = publicKey.toAddress();

    wallets.push({
      address: address.bech32(),
      privateKey: secretKey.hex(),
    });

    if ((i + 1) % 100 === 0) {
      console.log(`Generated ${i + 1}/${count} wallets...`);
    }
  }

  return wallets;
}

function main() {
  console.log(`Generating ${WALLET_COUNT} MultiversX wallets...`);
  const startTime = Date.now();

  const wallets = generateWallets(WALLET_COUNT);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(wallets, null, 2), "utf-8");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nDone! ${WALLET_COUNT} wallets saved to wallets.json in ${elapsed}s`);
  console.log(`Sample wallet: ${wallets[0].address}`);
}

main();
