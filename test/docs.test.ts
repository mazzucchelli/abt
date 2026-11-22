import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { parse } from "yaml";

/** README.md and every markdown file under docs/. */
const pages = ["README.md", ...(readdirSync("docs", { recursive: true }) as string[]).filter((f) => f.endsWith(".md")).map((f) => join("docs", f))];

/** GitHub's heading anchor: lower-case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

function anchors(file: string): Set<string> {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!)));
}

test("every relative link in the README and docs/ points at a file and heading that exist", () => {
  const broken: string[] = [];
  for (const page of pages) {
    const text = readFileSync(page, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target!)) continue;
      const [path, anchor] = target!.split("#");
      const file = path === "" ? page : normalize(join(dirname(page), path!));
      if (!existsSync(file)) {
        broken.push(`${page}: ${target} (no such file)`);
        continue;
      }
      if (anchor && file.endsWith(".md") && statSync(file).isFile() && !anchors(file).has(anchor)) broken.push(`${page}: ${target} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});

test("the first-pass example runs against its fake world and ends ok", () => {
  const r = spawnSync("bin/abt", ["run", "docs/examples/trees/claim-and-open-pr.yaml", "FAKE-1", "--world", "docs/examples/worlds/first-pass.json"], {
    encoding: "utf8",
    env: { ...process.env, ABT_UNPINNED: "1", ABT_HOME: mkdtempSync(join(tmpdir(), "abt-docs-")) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /action open-pr\s+opened PR/);
  assert.match(r.stdout, /^pass \S+: ok$/m);
});

test("the trees quoted in docs/reference/shipped-trees.md match defaults/trees/", () => {
  const text = readFileSync("docs/reference/shipped-trees.md", "utf8");
  const quoted = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => parse(m[1]!) as { id: string });
  const shipped = readdirSync("defaults/trees").filter((f) => f.endsWith(".yaml"));
  assert.deepEqual(quoted.map((t) => `${t.id}.yaml`).sort(), shipped.sort(), "every shipped tree is quoted once");
  for (const tree of quoted) {
    assert.deepEqual(tree, parse(readFileSync(join("defaults/trees", `${tree.id}.yaml`), "utf8")), `${tree.id}.yaml`);
  }
});
