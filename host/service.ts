// Keeping it running: launchd on a Mac, systemd on Linux, and on Windows a Run key with a hidden watchdog (stayup.ts)
// behind it. All three start it at login and restart it if it stops.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";

const WINDOWS = process.platform === "win32";
const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
/** Another install on this machine (another AGENT_AUTOLOOP_HOME) has a service of its own. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Windows' own names: the Run key says "start at login", the script it names starts the watchdog hidden, and the
 *  watchdog keeps `up` going. A stop is a file both of them watch for. A pid alone proves nothing — numbers are
 *  reused — so each of them writes a heartbeat beside its number while it lives, and a heart gone stale is checked
 *  against the number's own command line before anyone believes it or dismisses it. */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const vbsFile = () => path.join(HOME, "start.vbs");
const stoppedFile = () => path.join(HOME, "stopped");
const pidFile = (who: "up" | "stayup") => path.join(HOME, `${who}.pid`);
const beatFile = (who: "up" | "stayup") => path.join(HOME, `${who}.beat`);
const STAYUP = path.join(import.meta.dirname, "stayup.ts");
/** How long a heartbeat still counts as life: covers a machine that has just woken up. */
const BEAT_LIFE = 20_000;
/** What each of them looks like on a command line, for when the heart needs a second opinion. */
const LOOKS_LIKE: Record<"up" | "stayup", RegExp> = {
  up: /agent-autoloop(\.ts)"? up\b/,
  stayup: /stayup(\.ts)"?\s*$/,
};

function commandOf(pid: number) {
  const said = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  return said.stdout ?? "";
}

/** Whether one of this install's own is really running: a heart a moment old whose number still answers, or a stale
 *  one asked of its command line. */
export function windowsAlive(who: "up" | "stayup") {
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(pidFile(who), "utf8").trim());
  } catch {}
  let hearted = false;
  try {
    hearted = Date.now() - statSync(beatFile(who)).mtimeMs < BEAT_LIFE;
  } catch {}
  if (hearted) {
    if (!Number.isFinite(pid)) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  if (!Number.isFinite(pid)) return false;
  return LOOKS_LIKE[who].test(commandOf(pid));
}

/** The script the Run key starts: wscript runs it hidden, so no console window opens at every login. Written as
 *  UTF-16, because a home folder can carry writing Windows Script Host reads in no other single-byte way. */
export function startVbs() {
  const said = (text: string) => text.replaceAll('"', '""');
  const line = `"${process.execPath}" --disable-warning=ExperimentalWarning "${STAYUP}"`;
  return (
    `' Agent Autoloop. Started by this install's Run key at login; "service remove" and "uninstall" delete it.\n` +
    `Set shell = CreateObject("WScript.Shell")\n` +
    `shell.Environment("PROCESS")("AGENT_AUTOLOOP_HOME") = "${said(HOME)}"\n` +
    `shell.Run "${said(line)}", 0, False\n`
  );
}

/** Whether the Run key holds this install's entry. Names are ASCII and reg answers in the console's code page, so
 *  only the exit code is trusted, never the text. */
function runKeyOurs() {
  return spawnSync("reg", ["query", RUN_KEY, "/v", label()], { stdio: "ignore", windowsHide: true }).status === 0;
}

export function plist() {
  const logs = path.join(HOME, "logs");
  const systemPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const searchPath = [path.dirname(process.execPath), ...systemPaths].join(":");
  const program = [process.execPath, "--disable-warning=ExperimentalWarning", PROGRAM, "up"];
  const programArguments = program.map((part) => `<string>${xml(part)}</string>`).join("");
  const homeEntry = `<key>AGENT_AUTOLOOP_HOME</key><string>${xml(HOME)}</string>`;
  const pathEntry = `<key>PATH</key><string>${xml(searchPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array>${programArguments}</array>
  <key>EnvironmentVariables</key><dict>${homeEntry}${pathEntry}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit() {
  return `[Unit]
Description=Agent 自动化中台

[Service]
Environment=AGENT_AUTOLOOP_HOME=${HOME}
ExecStart=${process.execPath} --disable-warning=ExperimentalWarning ${PROGRAM} up
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const domain = () => `gui/${process.getuid!()}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (WINDOWS) {
    // The PATH of this moment is the one the Agents will need; login may bring a barer one.
    writeFileSync(path.join(HOME, "service.env"), `PATH=${process.env.PATH ?? ""}\n`);
    writeFileSync(vbsFile(), `﻿${startVbs()}`, "utf16le");
    rmSync(stoppedFile(), { force: true });
    execFileSync("reg", ["add", RUN_KEY, "/v", label(), "/t", "REG_SZ", "/d", `wscript.exe "${vbsFile()}"`, "/f"], {
      windowsHide: true,
    });
    // Started now, the way bootstrap and --now do; a second watchdog takes itself away.
    spawn(process.execPath, ["--disable-warning=ExperimentalWarning", STAYUP], {
      cwd: HOME,
      env: { ...process.env, AGENT_AUTOLOOP_HOME: HOME },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // bootout returns before the old one is gone; loading before that fails and leaves none.
    for (let tries = 0; tries < 100 && launchdHasIt(); tries++) pause(100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  if (WINDOWS) {
    if (!runKeyOurs()) return;
    // The stop file is what both the watchdog and `up` are watching for; they leave on their own within seconds.
    writeFileSync(stoppedFile(), "");
    for (let tries = 0; tries < 50 && (windowsAlive("stayup") || windowsAlive("up")); tries++) pause(200);
    // Anything still going after ten seconds is told to go, without its tree: agents run detached of it.
    for (const who of ["stayup", "up"] as const) {
      try {
        const pid = Number(readFileSync(pidFile(who), "utf8").trim());
        if (pid) spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
      } catch {}
    }
    spawnSync("reg", ["delete", RUN_KEY, "/v", label(), "/f"], { stdio: "ignore", windowsHide: true });
    for (const who of ["up", "stayup"] as const) {
      rmSync(pidFile(who), { force: true });
      rmSync(beatFile(who), { force: true });
    }
    for (const file of [vbsFile(), path.join(HOME, "service.env"), stoppedFile()]) rmSync(file, { force: true });
    return;
  }
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(xml(PROGRAM))) return;
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

/** The process that left its number in up.pid, if it still is that process: the number may be someone else's by now. */
export function runningUp() {
  const file = path.join(HOME, "up.pid");
  if (!existsSync(file)) return null;
  const pid = readFileSync(file, "utf8").trim();
  if (WINDOWS) {
    if (!windowsAlive("up")) return null;
    return Number(pid);
  }
  let command = "";
  try {
    command = execFileSync("ps", ["-p", pid, "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  return /agent-autoloop(\.ts)? up\b/.test(command) ? Number(pid) : null;
}

/** Stopping a service returns before its process is gone, and one started by hand has no service to stop it. */
export function stopUp() {
  const pid = runningUp();
  if (pid === null) return;
  if (WINDOWS) {
    // Written first, so the watchdog doesn't bring it straight back; no tree is taken, so agents go on without it.
    writeFileSync(stoppedFile(), "");
    // It turns itself off on its next look at the stop file; anything past that gets what a signal would have been.
    for (let tries = 0; tries < 30 && runningUp() !== null; tries++) pause(100);
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
    for (let tries = 0; tries < 20 && runningUp() !== null; tries++) pause(100);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
}

export function serviceRunning() {
  if (WINDOWS) return windowsAlive("stayup");
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}
