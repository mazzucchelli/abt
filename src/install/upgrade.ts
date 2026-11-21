import { mkdirSync, renameSync, rmSync } from "node:fs";
import { InstallStore } from "./store.ts";

/** Seam: puts the source of one release tag into a directory. */
export interface InstallSource {
  fetch(tag: string, dir: string): Promise<void>;
}

export interface SelfTestVerdict {
  ok: boolean;
  /** One line per failed check. */
  failures: string[];
}

/** Seam: the startup self-test, run against the freshly installed copy. */
export type InstallSelfTest = (dir: string, tag: string) => Promise<SelfTestVerdict>;

export interface UpgradeDeps {
  store: InstallStore;
  source: InstallSource;
  selfTest: InstallSelfTest;
}

export type UpgradeResult =
  | { status: "upgraded"; from: string | undefined; to: string }
  /** Switched to a tag that was already installed: it passed its self-test when it was installed. */
  | { status: "rolled-back"; from: string | undefined; to: string }
  | { status: "unchanged"; from: string; to: string }
  | { status: "failed"; tag: string; current: string | undefined; failures: string[] };

/**
 * `abt upgrade <tag>`: installs the tag, runs the startup self-test on it and switches `current`
 * only if the test passes. A failure leaves `current` as it was and keeps nothing of the attempt.
 * A tag that is already installed is a rollback: it only moves the pointer.
 */
export async function upgrade(tag: string, d: UpgradeDeps): Promise<UpgradeResult> {
  const { store } = d;
  const from = store.current();
  if (store.has(tag)) {
    if (from === tag) return { status: "unchanged", from: tag, to: tag };
    store.switchTo(tag);
    return { status: "rolled-back", from, to: tag };
  }

  const scratch = store.scratch(tag);
  const final = store.dir(tag);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    await d.source.fetch(tag, scratch);
    // An unverified install left by a crash is replaced, never trusted.
    rmSync(final, { recursive: true, force: true });
    renameSync(scratch, final);
    store.markUnverified(tag);
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    return { status: "failed", tag, current: from, failures: [`could not install ${tag}: ${(e as Error).message}`] };
  }

  // The test runs at the final path: the self-test checks that the pinned install is what loads.
  let verdict: SelfTestVerdict;
  try {
    verdict = await d.selfTest(final, tag);
  } catch (e) {
    verdict = { ok: false, failures: [`self-test could not run: ${(e as Error).message}`] };
  }
  if (!verdict.ok) {
    store.remove(tag);
    return { status: "failed", tag, current: from, failures: verdict.failures };
  }
  store.markVerified(tag);
  store.switchTo(tag);
  return { status: "upgraded", from, to: tag };
}
