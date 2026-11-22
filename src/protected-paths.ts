/**
 * The abt files a project's owner agrees to by hand: pinned outside the repo, and always high risk to touch.
 * The one list both the pins and the risk floors read.
 */
export const PROTECTED_GLOBS = [
  ".agents/abt/merge-policy.*",
  ".agents/abt/workflow.md",
  ".agents/abt/facts.yaml",
  ".agents/abt/trees/**",
  ".agents/abt/checks/**",
];
