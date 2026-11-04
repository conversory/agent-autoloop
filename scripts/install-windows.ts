// The Windows half of install.sh: the same steps in the same order, with what Windows brings — git, `where`, cmd — and
// a Node 24 this install keeps in the user's own folders, so the machine's own Node stays as it was.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const REPO = process.env.AGENT_AUTOLOOP_REPO ?? "https://github.com/KKKKhazix/agent-autoloop.git";
const ROOT = process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop");
const APP = path.join(ROOT, "app");
const PROGRAM = path.join(APP, "bin", "agent-autoloop.ts");
/** What the no-Node message tells a person to fetch: a version this code has actually run with. Bump it with a release. */
const NODE_24 = "24.22.2";

/** A Node 24 for this user alone, left by an earlier install or fetched by hand: the newest one there. */
function userNode(): string | null {
  const place = path.join(process.env.LOCALAPPDATA ?? homedir(), "agent-autoloop");
  let best: { major: number; minor: number; file: string } | undefined;
  try {
    for (const name of readdirSync(place)) {
      const said = name.match(/^node-v(\d+)\.(\d+)\./);
      const file = path.join(place, name, "node.exe");
      if (!said || !existsSync(file)) continue;
      const [major, minor] = [Number(said[1]), Number(said[2])];
      if (!best || major > best.major || (major === best.major && minor > best.minor)) best = { major, minor, file };
    }
  } catch {}
  return best && best.major >= 24 ? best.file : null;
}

function needNode(): never {
  console.log(`需要 Node.js 24 或更新，现在用的是 ${process.execPath}（${process.versions.node}）。`);
  console.log("要只给这个用户配一个、不动系统里的 Node，把下面三行按原样粘进 CMD，然后再运行一遍安装命令：\n");
  console.log(`  mkdir "%LOCALAPPDATA%\\agent-autoloop" 2>nul`);
  console.log(
    `  curl -L -o "%LOCALAPPDATA%\\agent-autoloop\\node.zip" https://nodejs.org/dist/v${NODE_24}/node-v${NODE_24}-win-x64.zip`,
  );
  console.log(`  tar -xf "%LOCALAPPDATA%\\agent-autoloop\\node.zip" -C "%LOCALAPPDATA%\\agent-autoloop"`);
  process.exit(1);
}

// This script's own writing needs Node 24's type stripping, so an older Node can only hand over to a newer one.
if (Number(process.versions.node.split(".")[0]) < 24) {
  const again = process.env.AGENT_AUTOLOOP_NODE ?? userNode();
  if (!again) needNode();
  const said = spawnSync(again, ["-p", "process.versions.node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (Number((said.stdout ?? "").split(".")[0]) < 24) needNode();
  process.exit(
    spawnSync(again, ["--disable-warning=ExperimentalWarning", import.meta.filename, ...process.argv.slice(2)], {
      stdio: "inherit",
    }).status ?? 1,
  );
}

if (spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status !== 0) {
  console.log("需要 git。");
  process.exit(1);
}

mkdirSync(ROOT, { recursive: true, mode: 0o700 });
if (existsSync(path.join(APP, ".git"))) {
  const pulled = spawnSync("git", ["-C", APP, "pull", "--ff-only", "--quiet"], { stdio: "inherit", windowsHide: true });
  if (pulled.status !== 0) process.exit(pulled.status ?? 1);
} else {
  // A local path is cloned as wholly as it is; --depth only saves the network kind.
  const cloned = spawnSync("git", ["clone", "--quiet", "--depth", "1", "--", REPO, APP], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (cloned.status !== 0) process.exit(cloned.status ?? 1);
}

const run = (args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", PROGRAM, ...args], {
    stdio: "inherit",
    windowsHide: true,
  }).status ?? 1;

/** Only a folder that's on PATH makes `agent-autoloop` work, and one that isn't this install's is someone else's to keep. */
function placeCmd(place: string) {
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((each) => path.resolve(each));
  if (!place || !path.isAbsolute(place) || !onPath.includes(path.resolve(place))) return false;
  const mine = path.join(place, "agent-autoloop.cmd");
  if (existsSync(mine) && !readFileSync(mine, "utf8").includes(PROGRAM)) return false;
  // Windows can't tell a writable folder from access(), so the honest check is the write itself.
  try {
    writeFileSync(mine, `@echo off\r\n"${process.execPath}" --disable-warning=ExperimentalWarning "${PROGRAM}" %*\r\n`);
  } catch {
    return false;
  }
  return true;
}

// WindowsApps is on PATH by default and this user's to write in; behind it the plainer places, then PATH in its own order.
const local = process.env.LOCALAPPDATA ?? homedir();
const candidates = [
  path.join(local, "Microsoft", "WindowsApps"),
  local,
  homedir(),
  ...(process.env.PATH ?? "").split(path.delimiter),
];
let placed: string | null = null;
for (const place of candidates) {
  if (placeCmd(place)) {
    placed = place;
    break;
  }
}

let status = 0;
if (existsSync(path.join(ROOT, "config.json"))) {
  console.log("更新好了。");
  if (!process.argv.includes("--no-service")) status = run(["service", "install"]);
} else {
  status = run(["init", ...process.argv.slice(2)]);
}

// The command has to be what a fresh CMD finds first; if it isn't, the full path is the honest thing to print.
if (placed) {
  const found = spawnSync("where", ["agent-autoloop"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const first = (found.stdout ?? "").split(/\r?\n/).find(Boolean) ?? "";
  if (path.resolve(path.dirname(first)) !== path.resolve(placed)) placed = null;
}
if (!placed) {
  console.log();
  console.log("直接打 agent-autoloop 运行不了这个程序：PATH 上没有能放它的目录，或者排在前面的是另一个同名程序。");
  console.log(`要写完整路径 "${process.execPath}" --disable-warning=ExperimentalWarning "${PROGRAM}"`);
}
process.exit(status);
