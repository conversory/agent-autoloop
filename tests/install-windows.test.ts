// install.cmd with scripts/install-windows.ts, in a throwaway home whose PATH is made of nothing but temporary folders.
// The program they set up is a real git clone of a committed copy of this one, so nothing needs committing and no real
// folder is written to. Failure cases: the command goes somewhere that isn't on PATH, so `agent-autoloop` isn't found
// right after installing; someone's own agent-autoloop.cmd is overwritten; running it again redoes the setup, or sets
// up a service after --no-service; a Node older than 24 is accepted and the program crashes where it stands; a Node 24
// this user's own folders hold is passed over for PATH's; the advice for a machine with no Node 24 can't be followed
// as written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const only = process.platform === "win32";
const repo = path.join(import.meta.dirname, "..");
const script = path.join(repo, "install.cmd");
const dir = only ? mkdtempSync(path.join(tmpdir(), "agent-autoloop-install-windows-")) : "";

/** A copy of this program, committed, so a real `git clone` can hand it to a real installer. */
const source = only ? path.join(dir, "the-program") : "";
if (only) {
  for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
    cpSync(path.join(repo, part), path.join(source, part), { recursive: true });
  }
  const said = (args: string[]) => spawnSync("git", ["-C", source, ...args], { stdio: "ignore", windowsHide: true });
  said(["init", "--quiet"]);
  said(["add", "-A"]);
  said(["-c", "user.email=install@test", "-c", "user.name=install", "commit", "--quiet", "-m", "the program"]);
}

let people = 0;
/** Somebody's computer: a home, a LOCALAPPDATA of its own, and a PATH of the folders it would really have. */
function computer({ node = "real" }: { node?: "real" | "old" | "local" | "none" } = {}) {
  const person = path.join(dir, `person-${++people}`);
  const windowsApps = path.join(person, "localappdata", "Microsoft", "WindowsApps");
  mkdirSync(windowsApps, { recursive: true });
  // Only the folders the test really needs from this machine's PATH — the one with cmd.exe, so the child shell itself
  // can be started, and the one with git.exe, so a real clone can happen. Everything else real is left out: Windows
  // can't tell a writable folder from access(), and a broken installer must never drop a shim somewhere real.
  const system = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((place) => existsSync(path.join(place, "cmd.exe")) || existsSync(path.join(place, "git.exe")));
  let early: string[] = [path.dirname(process.execPath)];
  let pathnode = "";
  if (node === "old") {
    // A `node` that answers as 22 would: the kind install.cmd has to refuse, not run the program with.
    const fake = path.join(person, "old-node");
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, "node.cmd"), "@echo off\r\necho 22.23.2\r\n");
    early = [fake];
  }
  if (node === "none") early = [];
  if (node === "local") {
    // A Node 24 this user's own folders hold, as an earlier install would have left it, and another good one on PATH
    // to be preferred over: hard links, not copies.
    const link = (file: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      try {
        linkSync(process.execPath, file);
      } catch {
        cpSync(process.execPath, file);
      }
    };
    link(path.join(person, "localappdata", "agent-autoloop", "node-v24.0.0", "node.exe"));
    pathnode = path.join(person, "on-path");
    link(path.join(pathnode, "node.exe"));
    early = [];
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_REPO: source,
    AGENT_AUTOLOOP_HOME: path.join(person, ".agent-autoloop"),
    USERPROFILE: person,
    LOCALAPPDATA: path.join(person, "localappdata"),
  };
  delete env.AGENT_AUTOLOOP_NODE;
  const run = (pathOrder: string[]) =>
    spawnSync("cmd.exe", ["/d", "/s", "/c", script, "--no-service", "--command", "true", "--port", "0"], {
      env: { ...env, PATH: [...pathOrder, ...early, ...system].join(path.delimiter) },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
  return { person, windowsApps, env, pathnode, run };
}

test(
  "the command goes in WindowsApps when that's on PATH, even behind another place it could go",
  { skip: !only },
  () => {
    const it = computer();
    const other = path.join(it.person, "other");
    mkdirSync(other, { recursive: true });
    const done = it.run([other, it.windowsApps]);
    assert.equal(done.status, 0, done.stderr + done.stdout);
    const shim = path.join(it.windowsApps, "agent-autoloop.cmd");
    assert.ok(existsSync(shim), "the command was placed");
    const program = path.join(it.person, ".agent-autoloop", "app", "bin", "agent-autoloop.ts");
    assert.ok(readFileSync(shim, "utf8").includes(program), "the command runs this install's program");
    assert.ok(!existsSync(path.join(other, "agent-autoloop.cmd")), "the first place on PATH was passed over");
    assert.match(done.stdout, /先运行 agent-autoloop up 启动中台，再开一个终端运行 agent-autoloop try/);
    assert.doesNotMatch(done.stdout, /直接打 agent-autoloop 运行不了/);
    const config = JSON.parse(readFileSync(path.join(it.person, ".agent-autoloop", "config.json"), "utf8"));
    assert.equal(config.hub.listen, "127.0.0.1:0");
  },
);

test("someone's own agent-autoloop.cmd stays as it was, and the next place takes this one", { skip: !only }, () => {
  const it = computer();
  const foreign = "@echo off\r\nrem someone else's own\r\n";
  writeFileSync(path.join(it.windowsApps, "agent-autoloop.cmd"), foreign);
  const after = path.join(it.person, "after");
  mkdirSync(after, { recursive: true });
  const done = it.run([it.windowsApps, after]);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(readFileSync(path.join(it.windowsApps, "agent-autoloop.cmd"), "utf8"), foreign);
  assert.ok(existsSync(path.join(after, "agent-autoloop.cmd")), "the next place on PATH took it");
});

test("running it again updates and doesn't set anything up over what's there", { skip: !only }, () => {
  const it = computer();
  assert.equal(it.run([it.windowsApps]).status, 0);
  const hub = path.join(it.person, ".agent-autoloop");
  writeFileSync(path.join(hub, "rules.json"), "my rules");
  const config = readFileSync(path.join(hub, "config.json"), "utf8");
  const again = it.run([it.windowsApps]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /更新好了/);
  assert.equal(readFileSync(path.join(hub, "rules.json"), "utf8"), "my rules");
  assert.equal(readFileSync(path.join(hub, "config.json"), "utf8"), config);
  assert.ok(!existsSync(path.join(hub, "start.vbs")), "no service was set up after --no-service");
});

test("a Node 24 in the user's own folders is preferred over a good one on PATH", { skip: !only }, () => {
  const it = computer({ node: "local" });
  const own = path.join(it.person, "localappdata", "agent-autoloop", "node-v24.0.0", "node.exe");
  // PATH starts with a perfectly good Node 24; the install should still run on the user's own.
  const done = it.run([it.windowsApps, it.pathnode]);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  const shim = readFileSync(path.join(it.windowsApps, "agent-autoloop.cmd"), "utf8");
  assert.ok(shim.includes(`"${own}"`), `the command runs on the user's own Node: ${shim}`);
});

test("a Node older than 24 on PATH is refused, and nothing is set up", { skip: !only }, () => {
  const it = computer({ node: "old" });
  const done = it.run([]);
  assert.equal(done.status, 1);
  assert.ok(done.stdout.includes("Node.js 24 or newer is required"), `said instead: ${done.stdout}${done.stderr}`);
  assert.match(done.stdout, /nodejs\.org\/dist\/v[\d.]+\/node-v[\d.]+-win-x64\.zip/);
  assert.ok(!existsSync(path.join(it.person, ".agent-autoloop")), "nothing is set up");
});

test(
  "with no Node 24 anywhere the same advice comes out, and it names this user's own folders",
  { skip: !only },
  () => {
    const it = computer({ node: "none" });
    const done = it.run([]);
    assert.equal(done.status, 1);
    const local = path.join(it.person, "localappdata");
    assert.ok(
      done.stdout.includes(`tar -xf "${local}\\agent-autoloop\\node.zip"`),
      `said instead: ${done.stdout}${done.stderr}`,
    );
    assert.ok(!existsSync(path.join(it.person, ".agent-autoloop")), "nothing is set up");
  },
);

after(() => {
  if (only) rmSync(dir, { recursive: true, force: true });
});
