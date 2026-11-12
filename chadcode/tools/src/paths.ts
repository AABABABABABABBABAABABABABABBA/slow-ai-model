// Path helpers. Resolve every user-supplied path against the session cwd so
// a tool can't be tricked into walking outside the tree with "..", and
// surface whether a resolved path is in-tree or not so the approval prompt
// can escalate.

import path from 'node:path';

export interface ResolvedPath {
  abs: string;        // absolute canonical path
  rel: string;        // path relative to cwd (may start with "../")
  inTree: boolean;    // true if abs stays under cwd
}

export function resolvePath(input: string, cwd: string): ResolvedPath {
  const abs = path.resolve(cwd, input);
  const rel = path.relative(cwd, abs);
  const inTree = !rel.startsWith('..') && !path.isAbsolute(rel);
  return { abs, rel: rel || '.', inTree };
}

export function describePath(r: ResolvedPath): string {
  return r.inTree ? r.rel : r.abs;
}
