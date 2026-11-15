// @vitest-environment node
// Guards the OpenMausBot -> OpenMyBot rename (scripts/brand-rename.mjs).
//  1. Nothing the rename covers may still say OpenMausBot (an upstream merge brings it back).
//  2. The values that other parties read must still be the old name (the rename must not touch them).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { leftovers, transform, renamePath } from "../../scripts/brand-rename.mjs";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("brand name", () => {
  it("leaves no OpenMausBot outside the keep list", () => {
    const left = leftovers(root) as { path: string; line: number; text: string }[];
    const shown = left.slice(0, 15).map((l) => `${l.path}:${l.line} ${l.text}`).join("\n");
    expect(left.length, `Run \`node scripts/brand-rename.mjs --apply\`.\n${shown}`).toBe(0);
  });

  it("renames the product name, the entry file and nothing else it should keep", () => {
    expect(transform("Welcome to OpenMausBot")).toBe("Welcome to OpenMyBot");
    expect(transform("class OpenMausBotApiError {}")).toBe("class OpenMyBotApiError {}");
    expect(transform("node server/openmausbot.ts")).toBe("node server/openmybot.ts");
    expect(renamePath("server/openmausbot.ts")).toBe("server/openmybot.ts");
    for (const kept of [
      "https://github.com/milind-soni/OpenMausBot/releases",
      "X-OpenMausBot-Desktop-Owner",
      "/Applications/OpenMausBot.app",
      "OpenMausBot-${version}-${arch}.${ext}",
      "~/Library/Application Support/OpenMausBot",
      "OpenMausBot Safe Storage",
      "OpenMausBot phone credential v1",
      "[QA](OpenMausBot://thread/qa-245)",
      "https://C-Opaque.OpenMausBot.Test/",
      "electron/resources/OpenMausBot Speech.app",
      'path.join(app, "Contents", "MacOS", "OpenMausBot")',
      'repo: "OpenMausBot"',
      '"electron.app.OpenMausBot"',
      "https://cloud.openmausbot.com",
      "~/.openmausbot",
      "OPENMAUSBOT_URL",
      "openmausbot://pair",
      "x-openmausbot-companion",
      "@openmausbot/docs",
    ]) expect(transform(kept), kept).toBe(kept);
  });

  it("keeps the names that already installed apps, other servers and the user's disk rely on", () => {
    const expectations: [string, string][] = [
      ["electron/control-plane-client.mjs", 'payload.service !== "openmausbot-control-plane"'],
      ["companion/src/index.ts", "_openmausbot._tcp"],
      ["electron/open-at-login.mjs", "\"autostart\", \"openmausbot.desktop\""],
      ["electron/main.mjs", 'setAsDefaultProtocolClient("openmausbot")'],
      ["electron/desktop-server-auth.cjs", "X-OpenMausBot-Desktop-Owner"],
      ["electron-builder.yml", "productName: OpenMausBot"],
      ["electron-builder.yml", "appId: com.openmausbot.app"],
      ["Dockerfile", "ln -s openmybot /usr/local/bin/openmausbot"],
      ["NOTICE", "OpenMausBot"],
    ];
    for (const [file, needle] of expectations) {
      expect(existsSync(resolve(root, file)), `${file} exists`).toBe(true);
      expect(read(file), `${file} keeps ${needle}`).toContain(needle);
    }
  });
});
