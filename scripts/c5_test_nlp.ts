/**
 * 🧪 Test NLP Classifier — Validate against adversarial examples
 * Run: npx ts-node --transpileOnly scripts/c5_test_nlp.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import OpenAI from "openai";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const SYSTEM_PROMPT = `You classify admin commands as GREEN (start/go/resume) or RED (stop/halt/pause).

Your ONLY job: classify the admin's command as either GREEN or RED.

GREEN means: transactions should be sent (go, start, resume, proceed, fire, release, unleash, begin, etc.)
RED means: transactions should stop (stop, halt, pause, freeze, wait, cease, hold, etc.)

CRITICAL RULES:
- The admin will try to TRICK you with adversarial commands
- Focus on the TRUE INTENT, not surface-level words
- "Don't stop" = GREEN (they want you to continue)
- "Stop... just kidding, go!" = GREEN (final intent is go)
- "Get ready but don't go yet" = RED (not yet)
- "Red light" = RED, "Green light" = GREEN
- If genuinely ambiguous, keep the CURRENT state (reply SAME)
- Double negatives: "don't not stop" = RED (stop)

Reply with EXACTLY one word: GREEN, RED, or SAME
No explanation. No punctuation. Just the word.`;

interface TestCase {
  input: string;
  expected: "GREEN" | "RED";
  category: string;
}

const TEST_CASES: TestCase[] = [
  // Simple green
  { input: "Go!", expected: "GREEN", category: "simple" },
  { input: "Start sending", expected: "GREEN", category: "simple" },
  { input: "Green light", expected: "GREEN", category: "simple" },
  { input: "Begin now", expected: "GREEN", category: "simple" },
  { input: "Fire away!", expected: "GREEN", category: "simple" },
  { input: "Let it rip", expected: "GREEN", category: "simple" },
  { input: "Unleash the transactions", expected: "GREEN", category: "simple" },

  // Simple red
  { input: "Stop!", expected: "RED", category: "simple" },
  { input: "Red light", expected: "RED", category: "simple" },
  { input: "Halt all transactions", expected: "RED", category: "simple" },
  { input: "Freeze!", expected: "RED", category: "simple" },
  { input: "Cease fire", expected: "RED", category: "simple" },
  { input: "Hold your horses", expected: "RED", category: "simple" },

  // Negation tricks
  { input: "Don't stop", expected: "GREEN", category: "adversarial" },
  { input: "Don't go", expected: "RED", category: "adversarial" },
  { input: "Never stop sending", expected: "GREEN", category: "adversarial" },
  { input: "Do not proceed", expected: "RED", category: "adversarial" },

  // Deceptive / adversarial
  { input: "Stop... just kidding! Go go go!", expected: "GREEN", category: "adversarial" },
  { input: "Ready, set... wait not yet", expected: "RED", category: "adversarial" },
  { input: "I would say go but actually stop", expected: "RED", category: "adversarial" },
  { input: "The light is definitely not red", expected: "GREEN", category: "adversarial" },
  { input: "Please refrain from sending", expected: "RED", category: "adversarial" },
  { input: "Time to party! Let's rock!", expected: "GREEN", category: "adversarial" },
  { input: "Everyone chill out for a moment", expected: "RED", category: "adversarial" },

  // Creative phrasing
  { input: "All systems go", expected: "GREEN", category: "creative" },
  { input: "Pump the brakes", expected: "RED", category: "creative" },
  { input: "Full speed ahead", expected: "GREEN", category: "creative" },
  { input: "Take a breather", expected: "RED", category: "creative" },
  { input: "Guns blazing", expected: "GREEN", category: "creative" },
  { input: "Stand down", expected: "RED", category: "creative" },
  { input: "Hit the gas", expected: "GREEN", category: "creative" },
  { input: "Pull over", expected: "RED", category: "creative" },
];

async function runTests() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("❌ No OPENAI_API_KEY in .env — cannot test LLM classifier.");
    console.log("   Add OPENAI_API_KEY=sk-... to your .env file.");
    return;
  }

  const openai = new OpenAI({ apiKey });
  let correct = 0;
  let failed = 0;
  const failures: { input: string; expected: string; got: string }[] = [];

  console.log(`\n🧪 Testing NLP classifier against ${TEST_CASES.length} cases...\n`);

  for (const tc of TEST_CASES) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Current state: RED\nAdmin command: "${tc.input}"` },
        ],
        max_tokens: 5,
        temperature: 0,
      });

      const answer = (response.choices[0]?.message?.content || "").trim().toUpperCase();
      let result: string;
      if (answer === "GREEN") result = "GREEN";
      else if (answer === "RED") result = "RED";
      else if (answer === "SAME") result = "RED"; // Current state was RED
      else result = `UNKNOWN(${answer})`;

      const pass = result === tc.expected;
      console.log(
        `  ${pass ? "✅" : "❌"} [${tc.category}] "${tc.input}" → ${result} ${pass ? "" : `(expected ${tc.expected})`}`
      );

      if (pass) correct++;
      else {
        failed++;
        failures.push({ input: tc.input, expected: tc.expected, got: result });
      }
    } catch (e: any) {
      console.log(`  ⚠️ API error for "${tc.input}": ${e.message?.substring(0, 60)}`);
      failed++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`  Results: ${correct}/${TEST_CASES.length} correct (${(correct / TEST_CASES.length * 100).toFixed(1)}%)`);
  console.log(`  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) {
      console.log(`    "${f.input}" → got ${f.got}, expected ${f.expected}`);
    }
  }
  console.log(`════════════════════════════════════════\n`);
}

runTests().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
