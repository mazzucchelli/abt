import { readFileSync } from "node:fs";
import { validate } from "./validate.ts";

const STUBS = ["run", "log", "onboard", "upgrade"];
const USAGE = `usage: abt <command>

commands:
  run        run a behavior tree (not implemented)
  log        inspect run logs (not implemented)
  onboard    onboard a repo (not implemented)
  validate   validate a behavior-tree YAML file
  upgrade    upgrade abt (not implemented)
`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (command === "validate") {
    const file = rest[0];
    if (!file) {
      console.error("usage: abt validate <file>");
      return 2;
    }
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (e) {
      console.error(`abt: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? e}`);
      return 2;
    }
    const diagnostics = validate(source, file);
    for (const d of diagnostics) console.error(d.message);
    return diagnostics.length === 0 ? 0 : 1;
  }

  if (command && STUBS.includes(command)) {
    console.error(`abt ${command}: not implemented`);
    return 2;
  }

  console.error(USAGE.trimEnd());
  return 2;
}

process.exitCode = main(process.argv.slice(2));
