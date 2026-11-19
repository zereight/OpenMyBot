import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import type { BrowserChromeStatus } from "../browser/chrome/updater.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createStatusRoutes, type StatusRouteDeps } from "./status.ts";
import { dispatchRoutes } from "./table.ts";

const sampleStatus: BrowserChromeStatus = {
  currentVersion: "157.0.8103.51",
  currentSource: "installed",
  currentDescription: "Google Chrome 157.0.8103.51",
  latestVersion: "158.0.8127.36",
  latestCheckedAt: "2026-11-19T00:00:00.000Z",
  latestError: null,
  updatable: true,
  notUpdatableReason: null,
  updateAvailable: true,
  profiles: { total: 1, maxVersion: "158.0.8127.36", mismatchedCount: 1 },
  updating: false,
  phase: "idle",
  progress: null,
  error: null,
  lastUpdatedAt: null,
  closedSessions: 0,
  deferredSessions: 0,
};

async function withServer(
  auth: RequestAuth,
  chromeUpdater: NonNullable<StatusRouteDeps["chromeUpdater"]>,
  run: (baseUrl: string) => Promise<void>,
) {
  const routes = [createStatusRoutes({
    staticDir: null,
    sharedWorkspaceFullAccessEnabled: () => false,
    chromeUpdater,
  } as unknown as StatusRouteDeps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

describe("browser-chrome status and update routes", () => {
  const ownerAuth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const serviceAuth: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };

  it("rejects non-admin callers on both status and update endpoints", async () => {
    const updater = {
      status: vi.fn(async () => sampleStatus),
      startUpdate: vi.fn(() => ({ started: true as const, status: { ...sampleStatus, updating: true, phase: "checking" as const } })),
    };
    await withServer(serviceAuth, updater, async (base) => {
      expect((await fetch(`${base}/api/browser-chrome/status`)).status).toBe(403);
      expect((await fetch(`${base}/api/browser-chrome/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })).status).toBe(403);
    });
    expect(updater.status).not.toHaveBeenCalled();
    expect(updater.startUpdate).not.toHaveBeenCalled();
  });

  it("returns status with cache-control no-store and forwards refresh=1", async () => {
    const updater = {
      status: vi.fn(async () => sampleStatus),
      startUpdate: vi.fn(() => ({ started: true as const, status: sampleStatus })),
    };
    await withServer(ownerAuth, updater, async (base) => {
      const res = await fetch(`${base}/api/browser-chrome/status?refresh=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(sampleStatus);
    });
    expect(updater.status).toHaveBeenCalledWith({ forceCheck: true });
  });

  it("enforces JSON content-type, returns 409 when not updatable, and 202 when started", async () => {
    const updater = {
      status: vi.fn(async () => sampleStatus),
      startUpdate: vi.fn()
        .mockReturnValueOnce({ started: false, conflict: "Browser executable is pinned by environment variable.", status: { ...sampleStatus, updatable: false } })
        .mockReturnValueOnce({ started: true, status: { ...sampleStatus, updating: true, phase: "checking" } }),
    };
    await withServer(ownerAuth, updater, async (base) => {
      const badMedia = await fetch(`${base}/api/browser-chrome/update`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
      expect(badMedia.status).toBe(415);

      const conflict = await fetch(`${base}/api/browser-chrome/update`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(conflict.status).toBe(409);
      expect((await conflict.json() as { error: string }).error).toContain("pinned");

      const accepted = await fetch(`${base}/api/browser-chrome/update`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(accepted.status).toBe(202);
      expect((await accepted.json() as { updating: boolean }).updating).toBe(true);
    });
  });
});
