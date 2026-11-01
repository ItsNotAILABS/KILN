/**
 * KILN Pages — static serving of a repo's designated site, live from
 * the ref. A repo designates its pages source in its details
 * (pages: {enabled, branch, path} — see lib/repodetails.mjs); this
 * module turns one HTTP path under /pages/:owner/:repo/ into bytes
 * read from that branch's CURRENT tree on every request. There is no
 * build step and no staging area: a push IS the republish.
 *
 * Design rules (house law):
 *  - Reads go through git plumbing (lib/forge.mjs readContents) —
 *    never the filesystem, never a checkout. The URL path is joined
 *    onto the designated in-repo directory segment by segment after
 *    per-segment sanitizing, so path traversal is impossible by
 *    construction (and tested).
 *  - Visibility is the caller's job (httpapi enforces the same law as
 *    every other read: public repo → anyone; private → owner/operator).
 *    This module only answers "is pages on, and what are the bytes".
 *  - Missing means missing: a real 404, never a SPA fallback — a
 *    paper's broken asset link must fail loudly, not serve the index.
 */

import { repoPath, repoExists, validRepoName } from "./git.mjs";
import { repoPages } from "./repodetails.mjs";
import { readContents, resolveRef, defaultBranch, ForgeError } from "./forge.mjs";

export class PagesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PagesError";
    this.status = status;
  }
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
};

export function contentTypeFor(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

/**
 * Sanitize the raw URL remainder after /pages/:owner/:repo into clean
 * path segments. Every segment is percent-decoded individually, so an
 * encoded separator (%2f, %5c) or dot segment (%2e%2e) lands INSIDE one
 * segment and is rejected there — it can never become a path step.
 * Returns { segments } or throws PagesError (400 malformed encoding,
 * 404 for anything that smells like traversal: the answer to a probe
 * is the same nothing as a missing file).
 */
export function pageSegments(rawRest) {
  const parts = String(rawRest || "").split("/").filter((s) => s !== "");
  const segments = [];
  for (const part of parts) {
    let seg;
    try {
      seg = decodeURIComponent(part);
    } catch {
      throw new PagesError(400, "malformed percent-encoding in path");
    }
    if (
      seg === "" || seg === "." || seg === ".." ||
      seg.includes("/") || seg.includes("\\") || seg.includes("\0")
    ) {
      throw new PagesError(404, "not found");
    }
    segments.push(seg);
  }
  return segments;
}

function tryContents(gd, ref, path) {
  try {
    return readContents(gd, ref, path);
  } catch (e) {
    if (e instanceof ForgeError) return null; // missing, or a tree (dir)
    throw e;
  }
}

/**
 * Resolve one pages request to a response plan:
 *   { status: 200, contentType, buffer, commit, servedPath }
 *   { status: 301, location }            (directory without slash, or
 *                                         the bare repo root)
 * Throws PagesError for 404s (no repo, pages disabled, no such branch,
 * no such file, traversal, malformed names — a name the forge would
 * never accept names no servable repo, so it is a 404 like any other
 * absence) and 400s (malformed percent-encoding only).
 *
 * `rawRest` is the still-encoded URL remainder after the repo segment
 * ("" for the bare /pages/:owner/:repo, "/" for its slash form).
 * `requestPath` is the full request path, used to build redirects.
 */
export function planPage(dir, owner, repo, rawRest, requestPath) {
  if (!validRepoName(owner) || !validRepoName(repo)) {
    throw new PagesError(404, "not found");
  }
  if (!repoExists(dir, owner, repo)) {
    throw new PagesError(404, `no such repo: ${owner}/${repo}`);
  }
  const pages = repoPages(dir, owner, repo);
  if (!pages.enabled) {
    throw new PagesError(404, `pages is not enabled for ${owner}/${repo}`);
  }
  const gd = repoPath(dir, owner, repo);
  const branch = pages.branch || defaultBranch(gd);
  const commit = resolveRef(gd, `refs/heads/${branch}`);
  if (!commit) {
    throw new PagesError(404, `pages source branch "${branch}" has no commits`);
  }

  const segments = pageSegments(rawRest);
  const base = pages.path ? pages.path.split("/") : [];
  const rel = [...base, ...segments];
  const trailingSlash = String(rawRest || "").endsWith("/");

  // The bare repo root canonicalizes to its slash form so relative
  // links in the index resolve under the repo prefix.
  if (segments.length === 0 && rawRest === "") {
    return { status: 301, location: `${requestPath}/` };
  }

  // Directory request (root, or any path ending in "/"): the index.
  if (segments.length === 0 || trailingSlash) {
    const indexPath = [...rel, "index.html"].join("/");
    const hit = tryContents(gd, branch, indexPath);
    if (!hit) throw new PagesError(404, "not found");
    return {
      status: 200, contentType: contentTypeFor(indexPath),
      buffer: hit.buffer, commit, servedPath: indexPath,
    };
  }

  // File request.
  const filePath = rel.join("/");
  const hit = tryContents(gd, branch, filePath);
  if (hit) {
    return {
      status: 200, contentType: contentTypeFor(filePath),
      buffer: hit.buffer, commit, servedPath: filePath,
    };
  }
  // Not a file — a directory addressed without its slash redirects to
  // the slash form when (and only when) it actually has an index.
  const indexPath = [...rel, "index.html"].join("/");
  if (tryContents(gd, branch, indexPath)) {
    return { status: 301, location: `${requestPath}/` };
  }
  throw new PagesError(404, "not found");
}
