#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_ONLY_PATHS, SKIP_PATHS, transform } from "./brand-rename.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Usage: node scripts/sync-upstream.mjs <command> [options]

Commands:
  status [--ref <ref>]            Show version and commit gap against upstream (default: upstream/main).
  resolve [--dry-run] [--apply-brand]
                                  Auto-resolve brand-rename-only and non-overlapping 3-way merge conflicts.
                                  Remaining semantic conflicts are rewritten without brand-rename noise.
  verify [--update-goldens]       Run brand, typecheck, lint, i18n, electron, and fork-guard checks in one pass.

Options:
  --help, -h                      Show this help message.
  --dry-run                       Inspect and classify conflicts without modifying files or the git index.
  --apply-brand                   Run scripts/brand-rename.mjs --apply after resolving conflicts.
  --update-goldens                Regenerate agents-catalog goldens if that test fails, then re-verify.
  --ref <git-ref>                 Upstream git ref to compare against (default: upstream/main).
`;

const GUARD_TESTS = [
  "src/lib/brand-name.test.ts",
  "server/drivers/agents-catalog-wire.test.ts",
  "src/locales/vocabulary.test.ts",
  "scripts/testing/file-size-ratchet.test.ts",
  "src/lib/plan-billing-removed.test.ts",
  "server/system-prompt.test.ts",
  "server/host/bitwarden-vault.test.ts",
  "server/workspace-backup-essentials.test.ts",
  "server/host/external-browser-guard.test.ts",
  "electron/hang-diagnostics.test.ts",
];

function git(args, { allowFail = false, encoding = "utf8" } = {}) {
  const res = spawnSync("git", ["-C", ROOT, ...args], { encoding, maxBuffer: 1 << 28 });
  if (res.status !== 0 && !allowFail) {
    const detail = (res.stderr || res.stdout || "").toString().trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return res;
}

function gitStageBuffer(stage, path) {
  const res = git(["show", `:${stage}:${path}`], { allowFail: true, encoding: "buffer" });
  return res.status === 0 ? res.stdout : null;
}

function isBinary(buf) {
  return buf.includes(0);
}

function normalizeForBrand(path, text) {
  if (SKIP_PATHS.some((re) => re.test(path))) return text;
  const entryOnly = ENTRY_ONLY_PATHS.some((re) => re.test(path));
  return transform(text, { entryOnly });
}

function threeWayMerge(ours, base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), "omb-sync-merge-"));
  try {
    const pOurs = join(dir, "ours");
    const pBase = join(dir, "base");
    const pTheirs = join(dir, "theirs");
    writeFileSync(pOurs, ours);
    writeFileSync(pBase, base);
    writeFileSync(pTheirs, theirs);
    const res = spawnSync(
      "git",
      ["merge-file", "-p", "-L", "HEAD (fork)", "-L", "base (brand-normalized)", "-L", "upstream (brand-normalized)", pOurs, pBase, pTheirs],
      { encoding: "utf8", maxBuffer: 1 << 28 },
    );
    const conflictCount = (res.stdout.match(/^<<<<<<< /gm) || []).length;
    return { status: res.status ?? 1, text: res.stdout, conflictCount };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function unmergedPaths() {
  const out = git(["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
  return out ? out.split("\n").filter(Boolean) : [];
}

function mergeInProgress() {
  return git(["rev-parse", "--verify", "MERGE_HEAD"], { allowFail: true }).status === 0;
}

function packageVersionAt(ref) {
  const res = git(["show", `${ref}:package.json`], { allowFail: true });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout).version ?? null;
  } catch {
    return null;
  }
}

function cmdStatus(ref) {
  const refCheck = git(["rev-parse", "--verify", ref], { allowFail: true });
  if (refCheck.status !== 0) {
    console.error(JSON.stringify({
      error: `Ref '${ref}' not found. Run 'git fetch upstream' or pass --ref <valid-ref>.`,
    }, null, 2));
    process.exit(1);
  }
  const counts = git(["rev-list", "--left-right", "--count", `HEAD...${ref}`]).stdout.trim().split(/\s+/);
  const unmerged = unmergedPaths();
  console.log(JSON.stringify({
    ref,
    headVersion: packageVersionAt("HEAD"),
    upstreamVersion: packageVersionAt(ref),
    forkAheadCommits: Number(counts[0] || 0),
    upstreamBehindCommits: Number(counts[1] || 0),
    mergeInProgress: mergeInProgress(),
    unmergedCount: unmerged.length,
    unmerged,
  }, null, 2));
}

function cmdResolve({ dryRun, applyBrand }) {
  if (!mergeInProgress()) {
    console.error(JSON.stringify({
      error: "No active git merge found (MERGE_HEAD missing). Start one with 'git merge --no-commit upstream/main' first.",
    }, null, 2));
    process.exit(1);
  }

  const paths = unmergedPaths();
  const brandOnly = [];
  const cleanThreeWay = [];
  const semanticConflicts = [];
  const special = [];

  for (const path of paths) {
    const b1 = gitStageBuffer(1, path);
    const b2 = gitStageBuffer(2, path);
    const b3 = gitStageBuffer(3, path);

    if (!b1 || !b2 || !b3) {
      const reason =
        b1 && !b2 && b3
          ? "deleted-in-fork"
          : b1 && b2 && !b3
            ? "deleted-in-upstream"
            : !b1 && b2 && b3
              ? "added-both"
              : "missing-stage";
      special.push({ path, reason, stages: [Boolean(b1), Boolean(b2), Boolean(b3)] });
      continue;
    }
    if (isBinary(b1) || isBinary(b2) || isBinary(b3)) {
      special.push({ path, reason: "binary" });
      continue;
    }

    const base = b1.toString("utf8");
    const ours = b2.toString("utf8");
    const theirs = b3.toString("utf8");
    const normBase = normalizeForBrand(path, base);
    const normTheirs = normalizeForBrand(path, theirs);

    if (ours === normBase) {
      brandOnly.push(path);
      if (!dryRun) {
        writeFileSync(join(ROOT, path), normTheirs);
        git(["add", "--", path]);
      }
      continue;
    }

    const merged = threeWayMerge(ours, normBase, normTheirs);
    if (merged.status === 0 && merged.conflictCount === 0) {
      cleanThreeWay.push(path);
      if (!dryRun) {
        writeFileSync(join(ROOT, path), merged.text);
        git(["add", "--", path]);
      }
      continue;
    }

    semanticConflicts.push({ path, hunks: merged.conflictCount });
    if (!dryRun) {
      writeFileSync(join(ROOT, path), merged.text);
    }
  }

  let brandRenameOutput = null;
  if (applyBrand && !dryRun) {
    brandRenameOutput = execFileSync(process.execPath, [join(ROOT, "scripts/brand-rename.mjs"), "--apply"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  }

  const autoResolvedCount = brandOnly.length + cleanThreeWay.length;
  console.log(JSON.stringify({
    dryRun,
    totalUnmergedBefore: paths.length,
    autoResolvedCount,
    remainingCount: semanticConflicts.length + special.length,
    brandOnly,
    cleanThreeWay,
    semanticConflicts,
    special,
    brandRenameOutput,
  }, null, 2));
}

function runCheck(name, command, args, env = process.env) {
  const startedAt = Date.now();
  const res = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", env, maxBuffer: 1 << 28 });
  const durationMs = Date.now() - startedAt;
  const combined = `${res.stdout || ""}${res.stderr || ""}`.trim();
  const tail = combined.split("\n").slice(-20).join("\n");
  return { name, ok: res.status === 0, exitCode: res.status ?? 1, durationMs, tail };
}

function cmdVerify({ updateGoldens }) {
  const checks = [];
  checks.push(runCheck("brand-rename", process.execPath, [join(ROOT, "scripts/brand-rename.mjs"), "--check"]));
  checks.push(runCheck("tsc-client", "npx", ["tsc", "-b", "--noEmit"]));
  checks.push(runCheck("tsc-server", "npx", ["tsc", "-p", "tsconfig.server.json", "--noEmit"]));
  checks.push(runCheck("lint", "pnpm", ["lint"]));
  checks.push(runCheck("i18n", "pnpm", ["i18n:check"]));
  checks.push(runCheck("check-electron", "pnpm", ["check:electron"]));

  const existingGuards = GUARD_TESTS.filter((file) => existsSync(join(ROOT, file)));
  let guardResult = runCheck("fork-guards", "npx", ["vitest", "run", ...existingGuards]);
  if (!guardResult.ok && updateGoldens && guardResult.tail.includes("agents-catalog-wire.test.ts")) {
    runCheck("update-agents-catalog-goldens", "npx", ["vitest", "run", "server/drivers/agents-catalog-wire.test.ts"], {
      ...process.env,
      UPDATE_AGENTS_CATALOG_GOLDENS: "1",
    });
    guardResult = runCheck("fork-guards", "npx", ["vitest", "run", ...existingGuards]);
  }
  checks.push(guardResult);

  const allOk = checks.every((c) => c.ok);
  console.log(JSON.stringify({
    ok: allOk,
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
    checks,
  }, null, 2));
  process.exit(allOk ? 0 : 1);
}

function parseArgs(argv) {
  const flags = { help: false, dryRun: false, applyBrand: false, updateGoldens: false, ref: "upstream/main" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--apply-brand") flags.applyBrand = true;
    else if (arg === "--update-goldens") flags.updateGoldens = true;
    else if (arg === "--ref" && argv[i + 1]) flags.ref = argv[++i];
    else positional.push(arg);
  }
  return { command: positional[0], flags };
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || !command) {
    console.log(HELP);
    process.exit(command ? 0 : 1);
  }
  if (command === "status") return cmdStatus(flags.ref);
  if (command === "resolve") return cmdResolve(flags);
  if (command === "verify") return cmdVerify(flags);
  console.error(JSON.stringify({
    error: `Unknown command '${command}'. Run 'node scripts/sync-upstream.mjs --help' for valid commands (status, resolve, verify).`,
  }, null, 2));
  process.exit(1);
}

main();
