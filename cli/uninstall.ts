// `agent-autoloop uninstall`: takes away what the install put on this computer and nothing else. A link is ours only if it really
// leads to this program: someone else's agent-autoloop, or a folder of their own by that name, stays where it is.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { removeService, stopUp } from "../host/service.ts";

const ROOT = path.join(import.meta.dirname, "..");

function removeLink(link: string, target: string) {
  // Only a link of ours to remove: on Windows the skill link is a junction, which a symlink check alone would miss.
  try {
    readlinkSync(link);
  } catch {
    return;
  }
  try {
    if (realpathSync(link) !== realpathSync(target)) return;
  } catch {
    return; // It leads nowhere, so not here.
  }
  rmSync(link, { recursive: true });
  console.log(`删掉了 ${link}`);
}

/** The Windows installer leaves a .cmd that names this program in its own words; that text is what makes it ours. */
function removeCmd(place: string, program: string) {
  const shim = path.join(place, "agent-autoloop.cmd");
  let said = "";
  try {
    said = readFileSync(shim, "utf8");
  } catch {
    return;
  }
  if (!said.includes(program)) return;
  // cmd.exe reads a batch file as it goes, so deleting the one this very command is running from cuts it off mid-word
  // ("The batch file cannot be found"). A hidden cmd of its own takes the file away once this one has finished.
  const delayed = spawn("cmd.exe", ["/d", "/s", "/c", `ping -n 3 127.0.0.1 >nul & del "${shim}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  delayed.unref();
  console.log(`删掉了 ${shim}`);
}

function removeLinks() {
  const program = path.join(ROOT, "bin", "agent-autoloop.ts");
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter((place) => path.isAbsolute(place));
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const places = [path.join(local, "Microsoft", "WindowsApps"), local, homedir(), ...onPath];
    for (const place of new Set(places)) removeCmd(place, program);
  } else {
    const places = [path.join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...onPath];
    for (const place of new Set(places)) removeLink(path.join(place, "agent-autoloop"), program);
  }
  const skill = path.join(ROOT, "skills", "agent-autoloop");
  for (const agent of [".claude", ".codex"]) removeLink(path.join(homedir(), agent, "skills", "agent-autoloop"), skill);
}

/** Confirmation is about removing the program; data is never part of this command. */
export async function uninstall(yes: boolean, ask: ((question: string) => Promise<string>) | null) {
  if (!yes) {
    if (!ask) throw new Error("运行 agent-autoloop uninstall --yes 卸载程序，规则、密钥和记录会保留。");
    if (!/^y(es)?$/i.test((await ask("卸载程序并保留数据？[y/N] ")).trim())) {
      console.log("没有卸载。");
      return;
    }
  }
  removeService();
  stopUp();
  removeLinks();
  const installedApp = path.join(HOME, "app");
  if (existsSync(installedApp) && realpathSync(installedApp) === realpathSync(ROOT)) {
    rmSync(installedApp, { recursive: true });
  }
  console.log(existsSync(HOME) ? `卸载好了。规则、密钥和记录还留在 ${HOME}。` : "卸载好了。");
}
