/** The project facts onboarding probes, and the contract for reading them. A fact left out is a fact that is unknown. */

export interface ProjectFacts {
  /** `<owner>__<repo>`, from the GitHub remote. */
  id: string;
  default_branch: string;
  visibility?: "private" | "public" | "internal";
  plan?: string;
  /** Branch protection and rulesets on the default branch. `enforced` is whether the host blocks a merge that breaks them. */
  protection?: { enforced: boolean; required_checks: string[]; approvals: number };
  allow_auto_merge?: boolean;
  merge_queue_available?: boolean;
  /** Logins with write access, the owner included. */
  write_collaborators?: string[];
  /** Apps and deploy keys with write access. */
  write_apps?: string[];
  ci?: { jobs: string[]; aggregator?: string };
  test_tooling?: string[];
  preview_deployments?: boolean;
}

/** Facts that must be known before anything but pr-only may be proposed. */
export const REQUIRED_FACTS = ["visibility", "protection", "write_collaborators", "write_apps", "ci", "test_tooling"] as const;

export const missingFacts = (f: ProjectFacts): string[] => REQUIRED_FACTS.filter((k) => f[k] === undefined);

export interface FactsProbe {
  facts(): Promise<ProjectFacts>;
  /** Every path committed on the default branch. */
  files(): Promise<string[]>;
}

/** `<owner>__<repo>` from a GitHub remote URL (https or ssh); undefined for any other remote. */
export function projectIdFromRemote(url: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}__${m[2]}` : undefined;
}

/** `owner/repo`, as `gh` names a repository, from a project ID. */
export const repoSlug = (projectId: string): string => projectId.replace("__", "/");
