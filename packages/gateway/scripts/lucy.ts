// Regenerates or checks the Lucy-generated gateway machines.
// Lucy lives in the private penner repo, so this runs only where a checkout
// exists. Set LUCY_HOME to the penner checkout; it defaults to a sibling of
// the joelclaw checkout.
//
//   bun run lucy:gen     rewrite each .machine.ts and .laws.txt
//   bun run lucy:check   fail if either is stale or any law is not proven
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const machines = ["gateway-alert-investigator"];

const srcDir = resolve(import.meta.dir, "../src");
const lucyHome = process.env.LUCY_HOME ?? resolve(import.meta.dir, "../../../../penner");
const compiler = join(lucyHome, "research/statechart-verification/lucy/statechart/main.ts");
const check = process.argv.includes("--check");

if (!existsSync(compiler)) {
  console.error(`Lucy compiler not found at ${compiler}. Set LUCY_HOME to a penner checkout.`);
  process.exit(2);
}

function compile(args: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", compiler, ...args], { cwd: srcDir, stderr: "inherit" });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

let failed = false;
for (const name of machines) {
  const source = `${name}.lucy`;
  const machine = compile(["--target", "ts-native", source]);
  const laws = compile(["--laws", source]);
  if (machine.exitCode !== 0) {
    console.error(`${source}: compile failed`);
    failed = true;
    continue;
  }
  const unproven = unprovenLaws(source);
  if (unproven.length > 0) {
    console.error(`${source}: laws not proven:\n${unproven.join("\n")}`);
    failed = true;
  }

  for (const [file, text] of [
    [`${name}.machine.ts`, machine.stdout],
    [`${name}.laws.txt`, laws.stdout],
  ] as const) {
    const path = join(srcDir, file);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
        console.error(`${file} is stale. Run bun run lucy:gen.`);
        failed = true;
      }
    } else {
      writeFileSync(path, text);
    }
  }
}

// The text report formats proven and refuted laws differently, and exits 0
// for unsupported ones, so verdicts come from the JSON report.
function unprovenLaws(source: string): string[] {
  const report = JSON.parse(compile(["--laws", "--json", source]).stdout) as {
    laws: { name: string; status: string }[];
  };
  return report.laws
    .filter((law) => law.status !== "proven")
    .map((law) => `  ${law.name}: ${law.status}`);
}

process.exit(failed ? 1 : 0);
