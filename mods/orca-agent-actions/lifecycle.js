export const sleepLabel = "orca.sleep";
const mark = t => String(t.created_ms) + "/" + String(t.turn ?? 0);
const state = t => t.status?.state || (typeof t.status === "string" ? t.status : "");
export const asleep = t => Boolean(t && state(t) !== "working" && t.labels?.[sleepLabel] === mark(t));

export async function changeAgent(command, target, get, call) {
  const term = await get();
  if (term.created_ms !== target.created || (term.state === "live" && target.foreground && term.foreground?.pid !== target.foreground) || (term.state === "live" && target.app && term.status?.app !== target.app))
    throw Error("The terminal has changed. Open the agent menu again.");
  if (command === "wake") {
    if (term.state !== "live") throw Error("This terminal already closed.");
    await call(["label", target.address, sleepLabel + "="]); return;
  }
  if (command === "sleep") {
    if (term.state !== "live") throw Error("This terminal already closed.");
    let current = term;
    if (!["idle", "done"].includes(state(term))) {
      if (!state(term)) throw Error("This agent has not reported its state yet.");
      await call(["interrupt", "--timeout", "8", target.address]);
      current = await get();
    }
    if (current.created_ms !== target.created || current.state !== "live" || !["idle", "done"].includes(state(current)))
      throw Error("The agent did not report an idle session. Check its terminal.");
    await call(["label", target.address, sleepLabel + "=" + mark(current)]); return;
  }
  if (command !== "close" && command !== "delete") throw Error("Unknown action.");
  if (term.state === "live") await call(["kill", target.address]);
  if (command === "close" || term.rm) return;
  const ended = await get();
  if (ended.created_ms !== target.created || ended.state === "live") throw Error("The terminal is still present. Check its state before retrying.");
  await call(["rm", target.address]);
}
