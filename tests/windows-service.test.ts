// The service on Windows: a Run key, a hidden watchdog, a pid file held open. Failure cases: the key names this install
// but stops or removes another's; a second watchdog starts a second hub beside the first; a removed service leaves its
// key, its script or its processes behind; a stop is missed because no signal reaches a Windows process; a pid file
// trusted by its number alone is believed after its writer is gone and the number is someone else's; a hard-killed hub
// is never brought back; the login script a home with writing in its path turns to mojibake; the uninstaller takes a
// command or a junction that isn't its own, or empties what its junction pointed at.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const only = process.platform === "win32";
// The service's own processes hold the home as their cwd, so they must be gone before setup's cleanup takes the home
// away. Hooks run in the order they were registered, and one that throws keeps the ones after it from running, so this
// is registered before setup's.
let stop: (() => void) | undefined;
if (only) after(() => stop?.());
const home = only ? setup("windows-service") : "";
const { installService, removeService, runningUp, serviceRunning, startVbs, stopUp } = only
  ? await import("../host/service.ts")
  : ({} as any);
if (only)
  stop = () => {
    try {
      removeService();
    } catch {}
    rmSync(path.join(home, "stopped"), { force: true });
  };

/** Real registry, real processes: what a person's login will actually do, done to a home of this test's own. */
const label = only ? `agent-autoloop-${createHash("sha256").update(home).digest("hex").slice(0, 8)}` : "";
const keyThere = () =>
  spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", label], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
const wait = async (until: () => boolean, seconds = 20, what = "it") => {
  const end = Date.now() + seconds * 1000;
  while (!until()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

if (only) {
  // What `up` needs to stay up: a hub of its own on a port of its own choosing.
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", hub: { listen: "127.0.0.1:0" } }),
  );
}

test("nothing installed says so, and no key of this test's own is there", { skip: !only }, () => {
  assert.equal(serviceRunning(), false);
  assert.equal(runningUp(), null);
  assert.notEqual(keyThere().status, 0);
});

test("install starts the watchdog and the hub, under this install's own name", { skip: !only }, async () => {
  installService();
  const said = keyThere().stdout;
  assert.match(said, /wscript\.exe/, "the key runs the script host");
  assert.ok(said.includes(path.join(home, "start.vbs")), "the key names this home's script");
  assert.ok(existsSync(path.join(home, "service.env")));
  await wait(serviceRunning, 20, "the watchdog");
  await wait(() => runningUp() !== null, 20, "the hub it watches");
  // A second watchdog of the same install takes itself away: one hub, not two beside each other.
  const before = runningUp();
  installService();
  await wait(serviceRunning, 20, "the watchdog again");
  assert.equal(runningUp(), before, "the hub was started again beside itself");
});

test("the login script is written the way Script Host reads any home's writing", { skip: !only }, () => {
  const script = startVbs();
  assert.ok(script.includes(home), "the home is in it");
  assert.ok(script.includes(process.execPath), "the node that runs the watchdog is in it");
  assert.ok(script.includes(path.join("host", "stayup.ts")), "the watchdog is in it");
  assert.match(script, /shell\.Run ".*", 0, False/, "it starts hidden");
  // Not this text's code page but Unicode is what carries a home with other writing in its name.
  const written = readFileSync(path.join(home, "start.vbs"));
  assert.deepEqual([...written.slice(0, 2)], [0xff, 0xfe], "a byte order mark says which");
});

test("a stop stops the hub by a file, not a signal no one would bring", { skip: !only }, async () => {
  stopUp();
  await wait(() => runningUp() === null, 20, "the hub to stop");
});

test("remove takes the key, the script and both processes away", { skip: !only }, async () => {
  installService();
  await wait(() => runningUp() !== null, 20, "the hub back up");
  removeService();
  assert.notEqual(keyThere().status, 0);
  await wait(() => !serviceRunning(), 20, "the watchdog to go");
  assert.equal(runningUp(), null);
  assert.ok(!existsSync(path.join(home, "start.vbs")));
  assert.ok(!existsSync(path.join(home, "stopped")));
});

test("a hub gone without cleanup is not its number, and is brought back", { skip: !only }, async () => {
  installService();
  await wait(() => runningUp() !== null, 20, "the hub");
  const pid = runningUp();
  execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  rmSync(path.join(home, "stopped"), { force: true }); // the stop file said go; the watchdog may not have read it yet
  assert.equal(runningUp(), null, "the number alone said nothing");
  await wait(() => runningUp() !== null && runningUp() !== pid, 20, "the watchdog to bring it back");
});

test("the uninstaller takes its own command and its own junction, and no one else's anything", { skip: !only }, () => {
  const dir = path.join(tmpdir(), `agent-autoloop-uninstall-${Date.now()}`);
  const program = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
  const skills = path.join(import.meta.dirname, "..", "skills", "agent-autoloop");
  const mine = path.join(dir, "mine");
  const theirs = path.join(dir, "theirs");
  for (const place of [mine, theirs]) mkdirSync(place, { recursive: true });
  writeFileSync(
    path.join(mine, "agent-autoloop.cmd"),
    `@echo off\r\n"<a node>" --disable-warning=ExperimentalWarning "${program}" %*\r\n`,
  );
  writeFileSync(
    path.join(theirs, "agent-autoloop.cmd"),
    `@echo off\r\n"<a node>" --disable-warning=ExperimentalWarning "${path.join(dir, "elsewhere")}" %*\r\n`,
  );
  const skill = path.join(dir, ".claude", "skills", "agent-autoloop");
  mkdirSync(path.dirname(skill), { recursive: true });
  symlinkSync(skills, skill, "junction");
  const done = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", program, "uninstall", "--yes"], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      AGENT_AUTOLOOP_HOME: path.join(dir, "home"),
      USERPROFILE: dir,
      PATH: `${mine}${path.delimiter}${theirs}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(!existsSync(path.join(mine, "agent-autoloop.cmd")), "our command stayed");
  assert.ok(existsSync(path.join(theirs, "agent-autoloop.cmd")), "someone else's command was taken");
  assert.ok(!existsSync(skill), "the junction stayed");
  assert.ok(existsSync(skills), "what the junction pointed at was emptied");
  rmSync(dir, { recursive: true, force: true });
});
