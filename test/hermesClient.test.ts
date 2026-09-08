import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesClient } from "../src/hermesClient.js";
import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
} from "../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const credentials = { accessToken: "test-token", storeId: "store-1" };

describe("HermesClient", () => {
  it("sends the credential headers and unwraps the {data} envelope", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/themes/active");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["X-Store-Id"]).toBe("store-1");
      return new Response(JSON.stringify({ data: { id: "t1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HermesClient("https://hermes.test", credentials);
    const result = await client.request("GET", "/api/v1/themes/active");

    expect(result).toEqual({ id: "t1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("appends query params and sends a JSON body when provided", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/widgets/w1?display=true");
      expect(init.body).toBe(JSON.stringify({ display: true }));
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return new Response(JSON.stringify({ data: { id: "w1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HermesClient("https://hermes.test", credentials);
    await client.request("PUT", "/api/v1/widgets/w1", {
      query: { display: "true" },
      body: { display: true },
    });
  });

  it("returns the raw payload when there is no {data} envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ id: "1" }]), { status: 200 }))
    );
    const client = new HermesClient("https://hermes.test", credentials);
    expect(await client.request("GET", "/x")).toEqual([{ id: "1" }]);
  });

  it("returns null for a 204 and for an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const client = new HermesClient("https://hermes.test", credentials);
    expect(await client.request("DELETE", "/x")).toBeNull();
  });

  it("maps 401/403/404/4xx/5xx to their typed errors", async () => {
    const client = new HermesClient("https://hermes.test", credentials);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnauthenticatedError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesForbiddenError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesNotFoundError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad payload", { status: 422 })));
    await expect(client.request("POST", "/x")).rejects.toThrow(HermesRejectedError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnavailableError);
  });

  it("maps a network failure to HermesUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    const client = new HermesClient("https://hermes.test", credentials);
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnavailableError);
  });

  it("never puts the access token in a thrown error's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const client = new HermesClient("https://hermes.test", credentials);
    try {
      await client.request("GET", "/api/v1/themes/active");
      throw new Error("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("test-token");
    }
  });
});
