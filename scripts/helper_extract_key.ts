/**
 * Helper script: extracts hex private key from a 12-word mnemonic.
 * 
 * Usage:  npx ts-node scripts/helper_extract_key.ts
 * 
 * It will prompt you to paste the 12 words, then print the hex private key.
 * ⚠️  DO NOT share the output with anyone!
 */

import * as readline from "readline";
import { Mnemonic } from "@multiversx/sdk-wallet";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("🔐 Paste your 12-word mnemonic: ", (mnemonic) => {
  rl.close();

  try {
    const words = mnemonic.trim();
    const mnemonicObj = Mnemonic.fromString(words);
    const secretKey = mnemonicObj.deriveKey(0);
    const publicKey = secretKey.generatePublicKey();
    const address = publicKey.toAddress();

    console.log("\n" + "═".repeat(60));
    console.log("✅ SUCCESS — Copy the private key below into your .env file");
    console.log("═".repeat(60));
    console.log(`\n📍 Address:     ${address.bech32()}`);
    console.log(`🔑 Private Key: ${secretKey.hex()}`);
    console.log(`\n📝 Add this line to your .env file:`);
    console.log(`   GL_PRIVATE_KEY=${secretKey.hex()}`);
    console.log("\n" + "═".repeat(60));
    console.log("⚠️  DO NOT share this key with anyone!");
    console.log("═".repeat(60));
  } catch (err: any) {
    console.error(`\n❌ Error: ${err.message}`);
    console.error("Make sure you pasted the correct 12 words separated by spaces.");
  }
});
