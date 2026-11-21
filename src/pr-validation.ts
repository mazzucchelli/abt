import { LineCounter, parseDocument } from "yaml";
import type { OpenPr, PrHost } from "./codehost/contract.ts";
import { AdapterConfigError, parseAdapterDoc } from "./tracker/config.ts";
import { LayeredTrees, type LoadedTree, type TreeStore } from "./trees.ts";
import { validateWithUses, type Diagnostic } from "./validate.ts";

/** The commit status the runner posts on PRs that touch abt files. */
export const VALIDATE_CONTEXT = "abt/validate";

const ABT_DIR = ".agents/abt";
const TREES_DIR = `${ABT_DIR}/trees`;
const ADAPTER_DOC = `${ABT_DIR}/workflow.md`;
const POLICY = `${ABT_DIR}/policy.yaml`;
const CHECKS_DIR = `${ABT_DIR}/checks/`;
const DESCRIPTION_MAX = 140;

/** Trees, merge policy, adapter doc and check scripts: the files the runner validates. */
export function isAbtFile(path: string): boolean {
  return isTree(path) || path === ADAPTER_DOC || path === POLICY || path.startsWith(CHECKS_DIR);
}

function isTree(path: string): boolean {
  return path.startsWith(`${TREES_DIR}/`) && path.endsWith(".yaml") && !path.slice(TREES_DIR.length + 1).includes("/");
}

/** Trees as they are at a PR's head: `use:` names resolve in the PR first, then in the plugin's defaults. */
class PrTrees implements TreeStore {
  readonly #host: PrHost;
  readonly #pr: OpenPr;
  constructor(host: PrHost, pr: OpenPr) {
    this.#host = host;
    this.#pr = pr;
  }
  async read(name: string): Promise<LoadedTree | undefined> {
    const file = `${TREES_DIR}/${name}.yaml`;
    const source = await this.#host.readFile(this.#pr, file);
    return source === undefined ? undefined : { source, file };
  }
}

const at = (file: string, line: number, col: number, text: string): Diagnostic => ({ file, line, col, text, message: `${file}:${line}:${col} ${text}` });

/** The problems in a PR's abt files, or undefined when it touches none. */
export async function validatePr(host: PrHost, pr: OpenPr, plugin: TreeStore): Promise<Diagnostic[] | undefined> {
  const files = pr.files.filter(isAbtFile);
  if (files.length === 0) return undefined;
  const trees = new LayeredTrees(new PrTrees(host, pr), plugin);
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    const source = await host.readFile(pr, file);
    if (source === undefined) continue; // deleted by the PR
    if (isTree(file)) diagnostics.push(...(await validateWithUses(source, file, trees)));
    else if (file === ADAPTER_DOC) {
      try {
        parseAdapterDoc(source);
      } catch (e) {
        if (!(e instanceof AdapterConfigError)) throw e;
        diagnostics.push(at(file, 1, 1, e.message));
      }
    } else if (file === POLICY) {
      const lines = new LineCounter();
      for (const err of parseDocument(source, { lineCounter: lines }).errors) {
        const { line, col } = lines.linePos(err.pos[0]);
        diagnostics.push(at(file, line, col, err.message.split("\n")[0] ?? err.message));
      }
    }
  }
  return diagnostics;
}

function describe(diagnostics: Diagnostic[]): string {
  const first = diagnostics[0]!.message;
  const more = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
  const room = DESCRIPTION_MAX - more.length;
  return `${first.length > room ? `${first.slice(0, room - 1)}…` : first}${more}`;
}

export interface PrValidatorDeps {
  host: PrHost;
  /** The plugin's default trees, which `use:` falls back to. */
  plugin: TreeStore;
  onError?: (error: unknown, where: string) => void;
}

/**
 * Validates PRs that touch abt files and posts an `abt/validate` status on their head commit, so
 * the project repo needs no CI workflow for it. Each head commit is validated once; a PR that touches
 * no abt file gets no status.
 */
export class PrValidator {
  readonly #d: PrValidatorDeps;
  readonly #done = new Set<string>();

  constructor(deps: PrValidatorDeps) {
    this.#d = deps;
  }

  /** Validates every open PR whose head has not been validated yet. A host error leaves that PR for the next sweep. */
  async sweep(): Promise<void> {
    const prs = await this.#d.host.openPrs();
    for (const pr of prs) {
      if (this.#done.has(pr.headSha)) continue;
      try {
        const diagnostics = await validatePr(this.#d.host, pr, this.#d.plugin);
        if (diagnostics === undefined) {
          this.#done.add(pr.headSha);
          continue;
        }
        await this.#d.host.postStatus(
          pr.headSha,
          diagnostics.length === 0
            ? { context: VALIDATE_CONTEXT, state: "success", description: "abt files are valid", targetUrl: pr.url }
            : { context: VALIDATE_CONTEXT, state: "failure", description: describe(diagnostics), targetUrl: pr.url },
        );
        this.#done.add(pr.headSha);
      } catch (e) {
        this.#d.onError?.(e, `validate PR ${pr.number}`);
      }
    }
  }
}
