export const sections = ["Uncommitted", "Staged", "Committed"];

export function reviewFiles(records) {
  const files = [];
  for (const record of records) {
    const xy = record.slice(0,2), path = record.slice(3);
    const conflict = /^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy);
    if (conflict || xy === "??" || xy[1] !== " ") files.push({section:"Uncommitted", path, conflict});
    if (!conflict && xy !== "??" && xy[0] !== " ") files.push({section:"Staged", path});
  }
  return files;
}

export async function committedFiles(git, destination) {
  if (destination.ahead === 0) return [];
  const head = destination.oid || (await git(["rev-parse","--verify","-q","HEAD"])).stdout.trim();
  if (!head) return [];
  let base;
  if (destination.tracking) {
    const common = await git(["merge-base",head,destination.tracking]);
    if (common.code > 1) throw Error(common.stderr);
    if (common.code === 0) base = common.stdout.trim();
  } else {
    // An unpublished branch may start at a commit already present on a remote.
    const refs = await git(["for-each-ref","--count=1","--format=%(objectname)","refs/remotes"]);
    if (refs.code !== 0) throw Error(refs.stderr);
    if (refs.stdout.trim()) {
      const local = await git(["rev-list","--first-parent","--boundary",head,"--not","--remotes"]);
      if (local.code !== 0) throw Error(local.stderr);
      if (!local.stdout.trim()) return [];
      base = local.stdout.split(/\r?\n/).find(line => line.startsWith("-"))?.slice(1);
    }
  }
  const names = base
    ? await git(["diff","--name-only","--no-renames","--no-ext-diff","--no-textconv","-z",base,head,"--"])
    : await git(["ls-tree","-r","--name-only","-z",head]);
  if (names.code !== 0) throw Error(names.stderr);
  return names.stdout.split("\0").filter(Boolean).map(path => ({section:"Committed",path}));
}
