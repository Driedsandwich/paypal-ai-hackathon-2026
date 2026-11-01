import type { Proposal } from "../proposals/store.js";

/** What a visitor sees of one of their proposals. The owner session id is never returned. */
export function publicProposal(p: Proposal) {
  const { owner: _owner, ...rest } = p;
  return rest;
}

export type PublicProposal = ReturnType<typeof publicProposal>;
