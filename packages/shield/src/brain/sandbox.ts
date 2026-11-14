import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { withDeadline } from "./deadline.js";

type Address = { address: string; family: 4 | 6 };
export type SandboxTransport = (url: URL, options: Address & {
  method: "HEAD" | "GET";
  signal: AbortSignal;
  validateConnection(address: string): void;
}) => Promise<{ status: number; location?: string }>;
export interface SandboxOptions {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: SandboxTransport;
}

export function isPublicAddress(address: string): boolean {
  if (address.includes("%")) return false;
  try {
    const parsed = ipaddr.parse(address);
    // Mapped IPv4 is normalized for socket comparisons, but never accepted as a target.
    if (parsed.kind() === "ipv6") {
      if (parsed.range() !== "unicast") return false;
      // Only globally routable IPv6; exclude transition/translation and special-use space.
      return parsed.match(ipaddr.parse("2000::"), 3);
    }
    return parsed.range() === "unicast";
  } catch { return false; }
}
function canonical(address: string): string {
  return ipaddr.process(address).toString();
}
export function publicUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsafe link URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new Error("Non-public link address");
  url.hash = "";
  return url;
}

/** No ambient proxy, connection pooling, second DNS lookup, automatic redirects or body reader. */
export const pinnedRequest: SandboxTransport = (url, options) => new Promise((resolve, reject) => {
  let verified = false;
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: options.method,
    agent: false,
    family: options.family, // Disable multi-address auto-selection; lookup returns one pinned address.
    signal: options.signal,
    // Keep the original URL hostname for Host, TLS SNI and certificate verification.
    // Connect only to the already validated address, even if DNS changes now.
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions && typeof lookupOptions === "object" && "all" in lookupOptions && lookupOptions.all) {
        (callback as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(null, [
          { address: options.address, family: options.family },
        ]);
        return;
      }
      callback(null, options.address, options.family);
    },
    headers: { "user-agent": "SahajShield-LinkCheck", accept: "*/*" },
  }, response => {
    if (!verified) {
      response.destroy(); request.destroy(new Error("Unverified link connection")); return;
    }
    const result = { status: response.statusCode ?? 0, location: response.headers.location };
    // Stop at headers. In particular, never parse/render a remote HTML/APK body.
    response.destroy();
    resolve(result);
  });
  request.once("socket", socket => {
    const check = () => {
      try {
        options.validateConnection(socket.remoteAddress ?? ""); verified = true;
      } catch { request.destroy(new Error("Non-public or unexpected connected address")); }
    };
    if (socket.connecting) socket.once("connect", check); else check();
  });
  request.once("error", reject);
  request.end();
});

export function createSandbox(options: SandboxOptions = {}) {
  const resolve = options.resolve ?? (async (hostname: string) => {
    const entries = await lookup(hostname, { all: true, verbatim: true });
    return entries.map(e => ({ address: e.address, family: e.family as 4 | 6 }));
  });
  const request = options.request ?? pinnedRequest;
  return {
    async unshorten(raw: string, outerSignal?: AbortSignal): Promise<string> {
      return withDeadline(2000, async signal => {
        let url = publicUrl(raw);
        let redirects = 0;
        for (;;) {
          signal.throwIfAborted();
          const host = url.hostname.replace(/^\[|\]$/g, "");
          // Resolve again on EVERY hop, even for a redirect within the same domain.
          const addresses: Address[] = ipaddr.isValid(host)
            ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 }]
            : await resolve(host);
          signal.throwIfAborted();
          if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error("Non-public DNS result");
          const address = addresses[0]!;
          const validateConnection = (remote: string) => {
            // Node can represent an IPv4 socket as ::ffff:a.b.c.d; normalize before checking.
            const actual = canonical(remote);
            if (!isPublicAddress(actual) || actual !== canonical(address.address)) throw new Error("Unsafe connected IP");
          };
          const config = { ...address, signal, validateConnection };
          let response = await request(url, { ...config, method: "HEAD" });
          if (response.status === 405 || response.status === 501) response = await request(url, { ...config, method: "GET" });
          signal.throwIfAborted();
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (!response.location) throw new Error("Redirect without location");
            if (redirects >= 5) throw new Error("Too many link redirects");
            url = publicUrl(new URL(response.location, url).href);
            redirects++;
            continue;
          }
          if (response.status < 200 || response.status >= 400) throw new Error("Link check failed");
          return url.href;
        }
      }, outerSignal);
    },
  };
}
