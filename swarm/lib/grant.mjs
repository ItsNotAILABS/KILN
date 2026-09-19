/**
 * Capability grants, mirroring contracts/KilnOwnershipRegistry.sol semantics
 * (in-process enforcement; chain uses block.timestamp, here we use unix time).
 *
 *   CAP_COMMIT   = 1  (enforced: git.commit, and on-chain commitProject)
 *   CAP_RELEASE  = 2  (enforced: project.release — running a repo's release command)
 *   CAP_PROPOSE  = 4  (enforced: swarm.submit — proposing work)
 *   CAP_DELEGATE = 8  (enforced: swarm.spawn / delegateGrant — spawning child nodes)
 */
export const CAP_COMMIT = 1;
export const CAP_RELEASE = 2;
export const CAP_PROPOSE = 4;
export const CAP_DELEGATE = 8;
export const CAP_ALL = CAP_COMMIT | CAP_RELEASE | CAP_PROPOSE | CAP_DELEGATE;

export const CAP_NAMES = {
  [CAP_COMMIT]: "commit",
  [CAP_RELEASE]: "release",
  [CAP_PROPOSE]: "propose",
  [CAP_DELEGATE]: "delegate",
};

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function capsToNames(caps) {
  const names = [];
  for (const bit of [CAP_COMMIT, CAP_RELEASE, CAP_PROPOSE, CAP_DELEGATE]) {
    if (caps & bit) names.push(CAP_NAMES[bit]);
  }
  const known = CAP_COMMIT | CAP_RELEASE | CAP_PROPOSE | CAP_DELEGATE;
  if (caps & ~known) names.push(`reserved(0x${(caps & ~known).toString(16)})`);
  return names;
}

export function parseCaps(spec) {
  if (typeof spec === "number") return spec >>> 0;
  const s = String(spec).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10) >>> 0;
  let caps = 0;
  for (const part of s.split(/[|,+\s]+/)) {
    const p = part.toLowerCase();
    if (!p) continue;
    const bit = { commit: CAP_COMMIT, release: CAP_RELEASE, propose: CAP_PROPOSE, delegate: CAP_DELEGATE }[p];
    if (bit === undefined) throw new Error(`grant: unknown capability "${part}"`);
    caps |= bit;
  }
  return caps >>> 0;
}

export class GrantError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Enforce a live grant carrying the required capability bits. Throws GrantError. */
export function checkGrant(grant, requiredCaps, what = "action") {
  if (!grant) throw new GrantError("NO_GRANT", `${what}: node holds no grant`);
  if (typeof grant.expiresAt !== "number" || grant.expiresAt <= nowSec()) {
    throw new GrantError("GRANT_EXPIRED", `${what}: grant expired at ${grant.expiresAt}`);
  }
  if ((grant.capabilities & requiredCaps) !== requiredCaps) {
    throw new GrantError(
      "MISSING_CAPABILITY",
      `${what}: needs [${capsToNames(requiredCaps)}], grant has [${capsToNames(grant.capabilities)}]`
    );
  }
}

/**
 * Validate a delegation request, mirroring KilnOwnershipRegistry.delegateGrant:
 * parent grant must be live and carry CAP_DELEGATE; child caps must be a
 * subset of the parent's; child expiry must be <= parent's expiry.
 * Returns the child grant {capabilities, expiresAt, parent}.
 */
export function delegateGrant(parentGrant, parentId, capabilities, expiresAt) {
  checkGrant(parentGrant, CAP_DELEGATE, "delegateGrant");
  if (!Number.isInteger(capabilities) || capabilities < 0) {
    throw new GrantError("BAD_CAPABILITIES", "delegateGrant: capabilities must be a non-negative integer");
  }
  if (capabilities & ~parentGrant.capabilities) {
    throw new GrantError(
      "EXCEEDS_PARENT_GRANT",
      `delegateGrant: child caps [${capsToNames(capabilities)}] exceed parent [${capsToNames(parentGrant.capabilities)}]`
    );
  }
  if (!Number.isInteger(expiresAt) || expiresAt <= nowSec()) {
    throw new GrantError("GRANT_EXPIRED", "delegateGrant: child expiry must be in the future");
  }
  if (expiresAt > parentGrant.expiresAt) {
    throw new GrantError(
      "EXCEEDS_PARENT_GRANT",
      `delegateGrant: child expiry ${expiresAt} exceeds parent expiry ${parentGrant.expiresAt}`
    );
  }
  return { capabilities: capabilities >>> 0, expiresAt, parent: parentId };
}
