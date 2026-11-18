export const sections = ["Conflicts", "Staged", "Unstaged"];

export async function recentCommits(git) {
  const result = await git(["log", "--first-parent", "-12", "-z", "--format=%H%x00%P%x00%s%x00%an%x00%as", "HEAD", "--"]);
  if (result.code !== 0) {
    if ((await git(["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) return [];
    throw Error(result.stderr);
  }
  const fields = result.stdout.split("\0"), commits = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const [oid, parents, subject, author, date] = fields.slice(i, i + 5);
    commits.push({id: "commit:" + oid, oid, parent: parents.split(" ")[0], subject: subject || "(no subject)", author, date});
  }
  return commits;
}

export async function committedFiles(git, destination, head) {
  if (!head) return {files:[], label:""};
  let base = head.parent, label = "Latest commit";
  if (destination.tracking && destination.ahead > 0) {
    const common = await git(["merge-base", head.oid, destination.tracking]);
    if (common.code === 0) {
      base = common.stdout.trim();
      label = "Ahead of " + destination.remote + "/" + destination.destName;
    }
  }
  const range = base ? ["diff", base, head.oid] : ["show","--root","--format=",head.oid];
  const args = [...range, "--no-renames", "--no-ext-diff", "--no-textconv", "-z"];
  const names = await git([...args, "--name-status", "--"]);
  if (names.code !== 0) throw Error(names.stderr);
  const fields = names.stdout.split("\0"), files = [];
  for (let i=0; i+1<fields.length; i+=2) {
    const path = fields[i+1];
    files.push({id:"committed:"+head.oid+":"+path,section:"Committed",status:fields[i],path});
  }
  return {files,label};
}

export function reviewFiles(records) {
  const groups = sections.map(() => []);
  for (const record of records) {
    const xy = record.slice(0, 2), path = record.slice(3);
    const add = (section, status) => groups[section].push({
      id: section + ":" + path, section: sections[section], status, path
    });
    if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy)) add(0, "U");
    else if (xy === "??") add(2, "?");
    else {
      if (xy[0] !== " ") add(1, xy[0]);
      if (xy[1] !== " ") add(2, xy[1]);
    }
  }
  return groups.flat();
}
