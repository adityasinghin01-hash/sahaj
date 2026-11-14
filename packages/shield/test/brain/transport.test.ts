import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ http: vi.fn(), https: vi.fn() }));
vi.mock("node:http", () => ({ request: mocks.http }));
vi.mock("node:https", () => ({ request: mocks.https }));
import { pinnedRequest } from "../../src/brain/sandbox.js";

function fakeRequest(remoteAddress: string) {
  const response = { statusCode: 200, headers: {}, destroy: vi.fn() };
  const socket = Object.assign(new EventEmitter(), { connecting: true, remoteAddress });
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(), destroy: vi.fn(),
  });
  let destroyed = false;
  const implementation = (_url: URL, _options: unknown, onResponse: (r: typeof response) => void) => {
    req.destroy.mockImplementation((error?: Error) => { destroyed = true; if (error) req.emit("error", error); });
    req.end.mockImplementation(() => queueMicrotask(() => {
      req.emit("socket", socket); socket.emit("connect"); if (!destroyed) onResponse(response);
    }));
    return req;
  };
  return { implementation, response, req };
}
describe("production pinned transport without network", () => {
  it.each(["http", "https"])("pins %s DNS and verifies the connected address, retaining the original hostname and no body reader", async protocol => {
    const fake = fakeRequest("93.184.216.34");
    const mock = protocol === "http" ? mocks.http : mocks.https; mock.mockImplementation(fake.implementation);
    const validateConnection = vi.fn();
    await expect(pinnedRequest(new URL(`${protocol}://bit.ly/a`), {
      address: "93.184.216.34", family: 4, method: "HEAD", signal: new AbortController().signal, validateConnection,
    })).resolves.toEqual({ status: 200, location: undefined });
    const [url, options] = mock.mock.calls.at(-1)!;
    expect(url.hostname).toBe("bit.ly"); expect(options.agent).toBe(false); expect(options.family).toBe(4);
    const callback = vi.fn(); options.lookup("bit.ly", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(validateConnection).toHaveBeenCalledWith("93.184.216.34"); expect(fake.response.destroy).toHaveBeenCalledOnce();
  });
  it("destroys a rebound connection before accepting its response", async () => {
    const fake = fakeRequest("127.0.0.1"); mocks.http.mockImplementation(fake.implementation);
    await expect(pinnedRequest(new URL("http://bit.ly/a"), {
      address: "93.184.216.34", family: 4, method: "HEAD", signal: new AbortController().signal,
      validateConnection: () => { throw new Error("unsafe"); },
    })).rejects.toThrow(/connected address/);
    expect(fake.req.destroy).toHaveBeenCalledOnce(); expect(fake.response.destroy).not.toHaveBeenCalled();
  });
});
