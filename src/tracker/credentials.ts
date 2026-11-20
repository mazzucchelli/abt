import { execFileSync } from "node:child_process";
import type { CredentialRef } from "./config.ts";

export interface CredentialSources {
  env: Record<string, string | undefined>;
  /** Reads a generic-password item from the macOS Keychain. */
  keychain: (item: string) => string | undefined;
}

export const systemSources: CredentialSources = {
  env: process.env,
  keychain(item) {
    try {
      return execFileSync("security", ["find-generic-password", "-s", item, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  },
};

/** Resolve a credential reference to its secret at the moment of use. Never cached or written. */
export function resolveCredential(ref: CredentialRef, sources: CredentialSources = systemSources): string {
  const secret = "env" in ref ? sources.env[ref.env] : sources.keychain(ref.keychain);
  if (!secret) {
    const where = "env" in ref ? `environment variable ${ref.env}` : `Keychain item "${ref.keychain}"`;
    throw new Error(`tracker credential not found: set ${where}`);
  }
  return secret;
}
