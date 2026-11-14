import { describe, expect, it, vi } from "vitest";
import { createSandbox, isPublicAddress, type SandboxTransport } from "../../src/brain/sandbox.js";

const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
const transport = () => vi.fn<SandboxTransport>(async (_url, options) => {
  options.validateConnection(options.address); return { status: 200 };
});
describe("sandboxed link expansion", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00:ec2::254", "100.64.0.1", "0.1.2.3", "224.0.0.1", "192.168.1.1", "172.16.0.1", "fe80::1", "::ffff:127.0.0.1", "2002:7f00:1::", "2001:db8::1"])("rejects non-public IP %s without connecting", async ip => {
    expect(isPublicAddress(ip)).toBe(false);
    const request = transport();
    const url = `http://${ip.includes(":") ? `[${ip}]` : ip}/`;
    await expect(createSandbox({ resolve: resolver, request }).unshorten(url)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])("allows public IP %s", ip => { expect(isPublicAddress(ip)).toBe(true); });
  it("rejects a redirect to a private IP", async () => {
    const request = vi.fn<SandboxTransport>(async (_u, o) => { o.validateConnection(o.address); return { status: 302, location: "http://10.0.0.1/secret" }; });
    await expect(createSandbox({ resolve: resolver, request }).unshorten("https://bit.ly/abc")).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it("rejects the sixth redirect", async () => {
    const request = vi.fn<SandboxTransport>(async (_u, o) => { o.validateConnection(o.address); return { status: 302, location: "/again" }; });
    await expect(createSandbox({ resolve: resolver, request }).unshorten("https://bit.ly/abc")).rejects.toThrow(/redirect/i);
    expect(request).toHaveBeenCalledTimes(6);
  });
  it("re-resolves every redirect hop and refuses DNS rebinding before the next request", async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const request = vi.fn<SandboxTransport>(async () => ({ status: 302, location: "/next" }));
    await expect(createSandbox({ resolve, request }).unshorten("https://bit.ly/a")).rejects.toThrow();
    expect(resolve).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledOnce();
  });
  it("rejects mixed public/private DNS and an unexpected connected IP", async () => {
    const mixed = async () => [{ address: "93.184.216.34", family: 4 as const }, { address: "10.0.0.1", family: 4 as const }];
    const request = transport();
    await expect(createSandbox({ resolve: mixed, request }).unshorten("https://bit.ly/a")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    const rebound: SandboxTransport = async (_u, o) => { o.validateConnection("127.0.0.1"); return { status: 200 }; };
    await expect(createSandbox({ resolve: resolver, request: rebound }).unshorten("https://bit.ly/a")).rejects.toThrow();
  });
  it("uses HEAD, falls back to GET without a body API, and accepts five redirects", async () => {
    let redirects = 0;
    const request = vi.fn<SandboxTransport>(async (_u, o) => {
      o.validateConnection(o.address);
      if (redirects++ < 5) return { status: 301, location: `/next-${redirects}` };
      return { status: o.method === "HEAD" ? 405 : 200 };
    });
    const result = await createSandbox({ resolve: resolver, request }).unshorten("https://bit.ly/a");
    expect(result).toBe("https://bit.ly/next-5");
    expect(request.mock.calls.map(([, o]) => o.method)).toEqual(["HEAD", "HEAD", "HEAD", "HEAD", "HEAD", "HEAD", "GET"]);
  });
  it("limits the entire expansion including DNS to two seconds", async () => {
    vi.useFakeTimers();
    try {
      const promise = createSandbox({ resolve: async () => new Promise(() => {}), request: transport() }).unshorten("https://bit.ly/a");
      const check = expect(promise).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(2000); await check;
    } finally { vi.useRealTimers(); }
  });
  it.each(["http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/"])("rejects an alternate loopback representation %s", async url => {
    const request = transport();
    await expect(createSandbox({ resolve: resolver, request }).unshorten(url)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["file:///etc/passwd", "ftp://example.com/a", "https://user:pass@example.com/"])("refuses unsafe URL %s", async url => {
    await expect(createSandbox({ resolve: resolver, request: transport() }).unshorten(url)).rejects.toThrow();
  });
});
