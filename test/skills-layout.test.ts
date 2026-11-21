import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The YAML frontmatter as flat `key: value` pairs, or undefined when the file has none. */
function frontmatter(text: string): Record<string, string> | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const PROCEDURES = [
  "implement", "tdd", "code-review", "diagnosing-bugs", "research", "spike", "pr", "refactoring",
  "setup-pre-commit", "setup-ts-deep-modules", "grilling", "domain-modeling", "spec-writing", "ticket-splitting", "triaging",
];
const COMMANDS = ["enqueue", "grill", "domain-model", "to-spec", "to-tickets", "triage"];
const REFERENCES = ["codebase-design", "writing-for-agents", "experience-first"];

test("plugin.json registers every procedure folder and nothing else as a skill", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { skills: string[] };
  assert.deepEqual([...plugin.skills].sort(), PROCEDURES.map((p) => `./procedures/${p}`).sort());
});

test("every procedure is a folder with a SKILL.md that is hidden from the /abt: menu", () => {
  assert.deepEqual(readdirSync(join(root, "procedures")).sort(), [...PROCEDURES].sort());
  for (const name of PROCEDURES) {
    const fm = frontmatter(read(`procedures/${name}/SKILL.md`));
    assert.ok(fm, `${name} has frontmatter`);
    assert.equal(fm.name, name);
    assert.ok(fm.description && fm.description.length > 0, `${name} has a description`);
    assert.equal(fm["user-invocable"], "false", `${name} is hidden`);
  }
});

test("the commands folder is the whole menu, and each command is a thin visible wrapper", () => {
  const files = readdirSync(join(root, "commands")).sort();
  assert.deepEqual(files, COMMANDS.map((c) => `${c}.md`).sort());
  for (const c of COMMANDS) {
    const text = read(`commands/${c}.md`);
    const fm = frontmatter(text);
    assert.ok(fm?.description, `${c} has a description`);
    assert.notEqual(fm["user-invocable"], "false", `${c} is user-invocable`);
    if (c !== "enqueue") {
      const m = /procedures\/([a-z-]+)\/SKILL\.md/.exec(text);
      assert.ok(m && PROCEDURES.includes(m[1]!), `${c} runs a procedure`);
      assert.ok(text.split("\n").length < 25, `${c} stays thin`);
    }
  }
});

test("no command shares a name with a procedure, so abt:<name> always resolves to one thing", () => {
  // A worker invokes abt:<procedure> through the Skill tool; a command of the same name could load in its place.
  for (const c of COMMANDS) assert.ok(!PROCEDURES.includes(c), `command ${c} clashes with a procedure`);
  assert.match(read("commands/grill.md"), /procedures\/grilling\/SKILL\.md/);
  assert.match(read("commands/domain-model.md"), /procedures\/domain-modeling\/SKILL\.md/);
  assert.match(read("commands/to-spec.md"), /procedures\/spec-writing\/SKILL\.md/);
  assert.match(read("commands/to-tickets.md"), /procedures\/ticket-splitting\/SKILL\.md/);
  assert.match(read("commands/triage.md"), /procedures\/triaging\/SKILL\.md/);
});

test("principles are plain files: an index entry and a trigger each, registered nowhere", () => {
  const index = read("principles/index.md");
  const files = readdirSync(join(root, "principles")).filter((f) => f !== "index.md").sort();
  assert.ok(files.length >= 10);
  for (const f of files) {
    const name = f.replace(/\.md$/, "");
    assert.ok(index.includes(`[${name}](${f})`), `${name} is in the index`);
    const text = read(`principles/${f}`);
    assert.equal(frontmatter(text), undefined, `${name} is not a skill`);
    assert.match(text, /\*\*When to apply:\*\* .+/, `${name} has a trigger`);
  }
  for (const m of index.matchAll(/\]\(([^)]+\.md)\)/g)) assert.ok(files.includes(m[1]!), `index links ${m[1]}`);
  assert.doesNotMatch(index, /never-block-on-the-human/);
  assert.ok(!existsSync(join(root, "principles/never-block-on-the-human.md")));
});

test("the principle index states precedence: project CLAUDE.md first, a deviation named", () => {
  const index = read("principles/index.md");
  assert.match(index, /CLAUDE\.md.*principles.*skill advice/s);
  assert.match(index, /deviation/i);
});

test("reference files are plain files", () => {
  for (const r of REFERENCES) assert.ok(existsSync(join(root, `reference/${r}.md`)), r);
});

test("no -afk fork and no mode frontmatter ships", () => {
  for (const f of walk("procedures").filter((f) => f.endsWith("SKILL.md"))) {
    assert.doesNotMatch(f, /-afk/);
    assert.equal(frontmatter(read(f))?.mode, undefined, `${f} has no mode`);
  }
});

test("a worker's ask rule lives in the runner: no procedure branches on who is running it", () => {
  for (const f of walk("procedures").filter((f) => f.endsWith(".md"))) {
    assert.doesNotMatch(read(f), /worker mode|human mode/i, f);
  }
});

// ---- CREDITS.md: pins, one row per shipped file, one line per reviewed playbook ----

const credits = read("CREDITS.md");

interface Row { file: string; upstream: string; action: string; divergence: string }
function rows(): Row[] {
  return credits
    .split("\n")
    .filter((l) => /^\| `[a-z-]+\//.test(l))
    .map((l) => {
      const c = l.split("|").map((x) => x.trim());
      return { file: c[1]!.replace(/`/g, ""), upstream: c[2]!, action: c[3]!, divergence: c[4]! };
    });
}

function pins(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of credits.split("\n")) {
    const m = /^\| `([a-z-]+)` \|.*`([0-9a-f]{40})`/.exec(l);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const PLAYBOOKS = [
  "bug-fix", "feature", "investigation", "prototype", "opening-a-pr", "authoring-a-skill", "refactoring",
  "autopilot-full", "autopilot-stack", "babysit", "shipping", "autonomous-run", "pause-safely", "session-pickup",
  "worktree-cleanup", "multi-phase-plan", "perf-issue", "visual-parity", "eval", "hillclimb",
  "runtime-forensics", "trace-forensics",
];

test("CREDITS.md pins both upstreams to a full SHA", () => {
  const p = pins();
  assert.match(p["mattpocock-skills"] ?? "", /^[0-9a-f]{40}$/);
  assert.match(p["pstack"] ?? "", /^[0-9a-f]{40}$/);
});

test("CREDITS.md has exactly one row for every shipped file, with a known action", () => {
  const shipped = ["commands", "procedures", "principles", "reference"].flatMap(walk).sort();
  const listed = rows().map((r) => r.file).sort();
  assert.deepEqual(listed, shipped);
  for (const r of rows()) {
    assert.match(r.action, /^(verbatim|adapted|original)$/, r.file);
    if (r.action !== "verbatim") assert.ok(r.divergence.length > 0, `${r.file} notes its divergence`);
    assert.doesNotMatch(r.divergence, /PREVIEW|STUB/, r.file);
  }
});

test("CREDITS.md has one line per reviewed playbook", () => {
  for (const name of PLAYBOOKS) {
    assert.match(credits, new RegExp(`^- ${name}: .{10,}`, "m"), `playbook ${name}`);
  }
});

test("CREDITS.md records every procedure and principle against the runner's checks, and what was dropped", () => {
  const review = credits.slice(credits.indexOf("## Review against the runner's checks"));
  assert.ok(review.length > 100, "the review section exists");
  for (const p of PROCEDURES) assert.match(review, new RegExp(`^- ${p}: `, "m"), p);
  assert.match(review, /Principles: all \d+ shipped ones/);
  assert.match(review, /^Dropped:$/m);
  assert.match(review, /never-block-on-the-human/);
});

test("no shipped file is still a stub", () => {
  for (const f of ["commands", "procedures", "principles", "reference"].flatMap(walk)) {
    assert.doesNotMatch(read(f), /^STUB\b/m, f);
  }
});

// ---- the pin test: every verbatim file matches upstream at its pin ----

const INSTALLED = join(homedir(), ".claude/plugins/installed_plugins.json");

/** Reads `path` from the upstream at its pinned SHA, or undefined when no copy of that upstream is at hand. */
function upstreamFile(key: string, sha: string, path: string): string | undefined {
  const env = process.env[`ABT_UPSTREAM_${key.toUpperCase().replace(/-/g, "_")}`];
  if (env) {
    try {
      return execFileSync("git", ["-C", env, "show", `${sha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  }
  if (key === "mattpocock-skills" && existsSync(INSTALLED)) {
    const entries = (JSON.parse(readFileSync(INSTALLED, "utf8")).plugins?.["mattpocock-skills@claude-plugins-official"] ?? []) as { installPath: string; gitCommitSha?: string }[];
    const hit = entries.find((e) => e.gitCommitSha === sha);
    if (hit && existsSync(join(hit.installPath, path))) return readFileSync(join(hit.installPath, path), "utf8");
  }
  return undefined;
}

test("every verbatim file matches its upstream at the pin", (t) => {
  const verbatim = rows().filter((r) => r.action === "verbatim");
  assert.ok(verbatim.length > 0, "at least one verbatim file ships, or the pin test covers nothing");
  const p = pins();
  let checked = 0;
  for (const r of verbatim) {
    const m = /^`([a-z-]+)`@([0-9a-f]{7,40}) (\S+)$/.exec(r.upstream);
    assert.ok(m, `${r.file}: a verbatim row names exactly one upstream as \`key\`@sha path`);
    const [, key, short, path] = m;
    assert.ok(p[key!]?.startsWith(short!), `${r.file}: ${key}@${short} is the pin`);
    const up = upstreamFile(key!, p[key!]!, path!);
    if (up === undefined) continue;
    checked++;
    assert.equal(read(r.file), up, `${r.file} differs from ${key}@${short} ${path}`);
  }
  if (checked === 0) t.skip(`no upstream copy at hand; set ABT_UPSTREAM_<KEY> to a git checkout (${relative(root, INSTALLED) || INSTALLED})`);
});
