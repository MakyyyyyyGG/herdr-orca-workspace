const clean = r => r.stdout.trimEnd();

export async function pushInfo(git, preferred) {
  const [head, remotesResult] = await Promise.all([git(["symbolic-ref","-q","HEAD"]),git(["remote"])]);
  if (head.code !== 0) return { message:"Switch to a branch to push." };
  if (remotesResult.code !== 0) throw Error(remotesResult.stderr);
  const ref = clean(head), branch = ref.replace(/^refs\/heads\//,"");
  const fmt = "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push)%00%(push:remotename)%00%(push:remoteref)";
  const details = await git(["for-each-ref","--format="+fmt,ref]);
  if (details.code !== 0) throw Error(details.stderr);
  const row = clean(details).split("\n").map(line=>line.split("\0")).find(r=>r[0]===ref);
  if (!row) return { branch, message:"Create the first commit to push this branch." };
  const remotes = clean(remotesResult).split(/\r?\n/).filter(Boolean);
  if (!remotes.length) return { branch, message:"Add a Git remote to push this branch." };
  const [,oid,upTrack,upRemote,upRef,pushTrack,pushRemote,pushRef] = row;
  const remote = [preferred,pushRemote,upRemote,"origin",remotes.length === 1 ? remotes[0] : null].find(r=>remotes.includes(r));
  if (!remote) return { branch, remotes, message:"Choose a remote to push to." };
  const dest = (remote === pushRemote && pushRef) || (remote === upRemote && upRef) || ref;
  if (!dest.startsWith("refs/heads/")) return { branch,remotes,message:"The configured destination is not a branch." };
  const destName = dest.slice(11);
  const tracking = (remote === pushRemote && pushRef === dest && pushTrack) || (remote === upRemote && upRef === dest && upTrack) || ("refs/remotes/"+remote+"/"+destName);
  const counts = await git(["rev-list","--left-right","--count",ref+"..."+tracking]);
  const [ahead,behind] = counts.code === 0 ? clean(counts).split(/\s+/).map(Number) : [null,null];
  return { branch,ref,oid,remote,dest,destName,remotes,ahead,behind,tracking:counts.code === 0 ? tracking : null,track:!upRemote,
    ready: !behind && ahead !== 0,
    message: behind ? "Integrate "+behind+" remote "+(behind===1?"commit":"commits")+" before pushing." :
      ahead === 0 ? "Up to date" : ahead == null ? "Publish branch" : ahead+" outgoing "+(ahead===1?"commit":"commits") };
}

export async function pushBranch(git, expected) {
  if (!expected?.ready) throw Error(expected?.message || "No branch is ready to push.");
  const current = await pushInfo(git,expected.remote);
  if (!current.ready || current.remote !== expected.remote || current.ref !== expected.ref || current.dest !== expected.dest || current.oid !== expected.oid)
    throw Error("The branch or destination changed. Review the refreshed status before pushing.");
  const args = ["push","--porcelain","--no-force","--no-follow-tags","--recurse-submodules=no",
    ...(current.track ? ["--set-upstream"] : []),"--",current.remote,current.ref+":"+current.dest];
  const r = await git(args,120000);
  if (r.code !== 0) {
    const output = (r.stderr || "") + "\n" + (r.stdout || "");
    if (/non-fast-forward|fetch first|behind its remote/i.test(output)) throw Error("Push rejected. Fetch and integrate the remote changes, then retry.");
    throw Error((output.trim() || "Push failed.").replace(/(https?:\/\/)[^@\s/]+@/gi,"$1").slice(0,400));
  }
  return "Pushed to " + current.remote + "/" + current.destName;
}
