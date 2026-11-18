const slash = path => path.replace(/\\/g, "/").replace(/\/+$/, "");
export const comparable = path => /^[a-z]:|^[/\\]{2}/i.test(path) ? slash(path).toLowerCase() : slash(path);

export function repository(text) {
  const url = text.trim().replace(/^git\s+clone\s+/i, "").trim().replace(/\/+$/, "");
  const remote = /^(https?|ssh):\/\/([^/?#]+)\/([^?#]+)$/i.exec(url);
  const scp = /^([a-z0-9._-]+@[a-z0-9._-]+):([^?#]+)$/i.exec(url);
  if ((!remote && !scp) || /[\s\\\x00-\x1f\x7f]/.test(url)) throw new Error("Paste an HTTPS or SSH repository clone URL.");
  if (remote && !/^(?:[a-z0-9._-]+@)?(?:[a-z0-9._-]+|\[[a-f0-9:]+\])(?::\d+)?$/i.test(remote[2])) throw new Error("Check the repository host and port.");
  if (remote && /^https?$/i.test(remote[1]) && remote[2].includes("@")) throw new Error("Use the clone URL without embedded credentials. Git uses your saved sign-in.");
  const path = remote ? remote[3] : scp[2];
  let name;
  try { name = decodeURIComponent(path.split("/").pop()).replace(/\.git$/i, ""); } catch { throw new Error("The repository name has an invalid URL escape."); }
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("The URL needs a repository name that can be used as a folder.");
  return { url, name };
}

export async function cloneOrReuse(text, parent, git) {
  const { url, name } = repository(text);
  const dest = slash(parent) + "/" + name;
  const top = await git(["-C", dest, "rev-parse", "--show-toplevel"]);
  if (top.code === 0 && comparable(top.stdout.trimEnd()) === comparable(dest)) {
    const origin = await git(["-C", dest, "config", "--get", "remote.origin.url"]);
    const identity = value => value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
    if (origin.code === 0 && identity(origin.stdout) === identity(url)) return dest;
    throw new Error("A different checkout already uses this folder. Choose another destination.");
  }
  const result = await git(["clone", "--", url, dest], 600000);
  if (result.code !== 0) {
    const detail = (result.stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 340);
    throw new Error(detail || "Git could not clone this repository.");
  }
  return dest;
}

