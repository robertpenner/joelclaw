// Formats, regenerates or checks the Lucy gateway machines.
// Lucy lives in the private penner repo, so this runs only where a checkout
// exists. Set LUCY_HOME to the penner checkout; it defaults to a sibling of
// the joelclaw checkout.
//
//   bun run lucy:gen     format each .lucy file, then rewrite its
//                        .xstate.machine.ts (XState v6), .native.machine.ts (no XState)
//                        and .laws.txt
//   bun run lucy:check   fail if a .lucy file needs formatting, a generated
//                        file is stale, or any law is not proven
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const machines = ["gateway-alert-investigator"];

const srcDir = resolve(import.meta.dir, "../src");
const lucyHome = process.env.LUCY_HOME ?? resolve(import.meta.dir, "../../../../penner");
const lucyDir = join(lucyHome, "research/statechart-verification/lucy");
const compiler = join(lucyDir, "statechart/main.ts");
const formatter = join(lucyDir, "vscode/formattingCli.ts");
const check = process.argv.includes("--check");

if (!existsSync(compiler) || !existsSync(formatter)) {
  console.error(`Lucy not found under ${lucyDir}. Set LUCY_HOME to a penner checkout.`);
  process.exit(2);
}

function run(script: string, args: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", script, ...args], { cwd: srcDir, stderr: "inherit" });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

let failed = false;
for (const name of machines) {
  const source = `${name}.lucy`;
  const formatted = run(formatter, check ? ["--check", source] : [source]);
  if (formatted.exitCode !== 0) {
    console.error(`${source} needs formatting. Run bun run lucy:gen.`);
    failed = true;
  }

  const outputs = [
    [`${name}.xstate.machine.ts`, run(compiler, [source])],
    [`${name}.native.machine.ts`, run(compiler, ["--target", "ts-native", source])],
    [`${name}.laws.txt`, run(compiler, ["--laws", source])],
  ] as const;
  if (outputs[0][1].exitCode !== 0 || outputs[1][1].exitCode !== 0) {
    console.error(`${source}: compile failed`);
    failed = true;
    continue;
  }

  const unproven = unprovenLaws(source);
  if (unproven.length > 0) {
    console.error(`${source}: laws not proven:\n${unproven.join("\n")}`);
    failed = true;
  }

  for (const [file, { stdout }] of outputs) {
    const path = join(srcDir, file);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== stdout) {
        console.error(`${file} is stale. Run bun run lucy:gen.`);
        failed = true;
      }
    } else {
      writeFileSync(path, stdout);
    }
  }
}

// The text report formats proven and refuted laws differently, and exits 0
// for unsupported ones, so verdicts come from the JSON report.
function unprovenLaws(source: string): string[] {
  const report = JSON.parse(run(compiler, ["--laws", "--json", source]).stdout) as {
    laws: { name: string; status: string }[];
  };
  return report.laws
    .filter((law) => law.status !== "proven")
    .map((law) => `  ${law.name}: ${law.status}`);
}

process.exit(failed ? 1 : 0);
