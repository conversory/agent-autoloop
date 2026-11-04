// Where a Mac has launchd and Linux has systemd, Windows has this: a small hidden process the Run key starts at login.
// It starts `up`, starts it again if it goes, and stops for good when a stop file appears — the whole of KeepAlive,
// in the one place a person's own Windows gives without asking an administrator for anything.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";
import { runningUp, serviceRunning } from "./service.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const STOPPED = path.join(HOME, "stopped");
const MINE = path.join(HOME, "stayup.pid");
const BEAT = path.join(HOME, "stayup.beat");
const LOOK = 5_000;

/** service.env: the PATH of the day it was installed, which login might not bring the Agents this install runs. */
function environment() {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: HOME };
  try {
    for (const line of readFileSync(path.join(HOME, "service.env"), "utf8").split(/\r?\n/)) {
      const at = line.indexOf("=");
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
  } catch {}
  return env;
}

// One watchdog per install: a second takes itself away, and the one that stays keeps its heart going for whoever asks.
if (serviceRunning()) process.exit(0);
mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
const said = openSync(path.join(HOME, "logs", "up.log"), "a");
writeFileSync(MINE, String(process.pid));
const beat = () => {
  try {
    writeFileSync(BEAT, String(process.pid));
  } catch {}
};
beat();
setInterval(beat, LOOK);

function gone() {
  rmSync(MINE, { force: true });
  rmSync(BEAT, { force: true });
  process.exit(0);
}

function look() {
  if (existsSync(STOPPED)) return gone();
  if (runningUp() !== null) return;
  try {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", PROGRAM, "up"], {
      cwd: HOME,
      env: environment(),
      stdio: ["ignore", said, said],
      windowsHide: true,
    });
    child.on("error", (error) => writeSync(said, `${new Date().toISOString()} [stayup] couldn't start up: ${error}\n`));
  } catch (error) {
    writeSync(said, `${new Date().toISOString()} [stayup] couldn't start up: ${error}\n`);
  }
}

look();
setInterval(look, LOOK);
