export function browserHost(p) {
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid listening port.");
  const bind = String(p.bind || "").trim();
  if (bind === "0.0.0.0") return "127.0.0.1";
  if (bind === "[::]" || bind === "::") return "[::1]";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bind) && bind.split(".").every(n=>Number(n)<=255)) return bind;
  const v6 = bind.replace(/^\[|\]$/g,"");
  if (v6.includes(":") && /^[\da-f:.]+(?:%\d+)?$/i.test(v6)) return "["+v6.replace("%","%25")+"]";
  throw Error("This listener has no local IP address.");
}

export async function webAddress(port, runCurl, present, nullOutput = "NUL") {
  const host = browserHost(port);
  if (!present()) throw Error("This listener has closed.");
  let plainBadRequest = null;
  for (const protocol of ([443,8443].includes(port.port) ? ["https","http"] : ["http","https"])) {
    const url = protocol + "://" + host + ":" + port.port + "/";
    // HEAD tests the protocol on the chosen socket. The browser handles redirects and certificate trust.
    const args = ["--disable","--noproxy","*","--silent","--head","--insecure","--connect-timeout","1","--max-time","2",
      "--output",nullOutput,"--write-out","%{http_code}","--url",url];
    const r = await runCurl(args);
    if (r.code === 0 && /^[1-5]\d\d$/.test(r.stdout.trim())) {
      if (!present()) throw Error("This listener has closed.");
      // Some TLS servers reply to cleartext HEAD with an HTTP 400 upgrade hint.
      if (protocol === "http" && r.stdout.trim() === "400") { plainBadRequest = url; continue; }
      return url;
    }
  }
  if (plainBadRequest && present()) return plainBadRequest;
  throw Error("This port did not answer HTTP or HTTPS.");
}
