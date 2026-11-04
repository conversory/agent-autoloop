// The channel a new install starts with: a notification on this computer that there's something to look at. It can't take
// an answer; `agent-autoloop status` shows the card and `agent-autoloop answer` answers it.
//   "channels": { "desktop": { "key": "…" } } in config.json
//   "channels": { "desktop": { "name": "桌面通知" } } in rules.json
import { execFile, spawnSync } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";

const WORDS = "运行 agent-autoloop status 查看";
const TITLE = "Agent 问你一个问题";
const APPLESCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];
/** A toast through the WinRT PowerShell projects, under an AppId Windows already knows, so nothing is registered. The
 *  card's words never appear here: they travel as environment, which no parser on the way takes for instructions. */
const TOAST = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$lines = $template.GetElementsByTagName('text')",
  "$lines.Item(0).AppendChild($template.CreateTextNode($env:AGENT_AUTOLOOP_TITLE)) > $null",
  "$lines.Item(1).AppendChild($template.CreateTextNode($env:AGENT_AUTOLOOP_BODY)) > $null",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:AGENT_AUTOLOOP_APP).Show([Windows.UI.Notifications.ToastNotification]::new($template))",
].join("; ");
/** The AppId of the stock Windows PowerShell: toasts under it need no shortcut of our own in the Start Menu. */
export const TOAST_APP = "{1AC14E77-02E7-4E5D-B744-2E1B87C8B7B3}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * A card's title is whatever an Agent wrote, so it's only ever an argument, never part of a script. The `--` is what keeps
 * it one when it starts with a dash: without it osascript takes a title of `-e` as more script to run. On Windows there is
 * no argument to protect: the command line is the same whatever the card says, and the title goes with the environment.
 */
export function notifyCommand(title: string, platform: string = process.platform): [string, string[]] {
  const body = `${title}\n${WORDS}`;
  if (platform === "darwin") return ["osascript", [...APPLESCRIPT.flatMap((line) => ["-e", line]), "--", TITLE, body]];
  if (platform === "win32") {
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST]];
  }
  return ["notify-send", ["--", TITLE, body]];
}

function hasDesktop() {
  if (process.platform === "darwin") {
    return spawnSync("launchctl", ["print", `gui/${process.getuid!()}`], { stdio: "ignore" }).status === 0;
  }
  // Windows PowerShell ships with the system, and toasts go wherever the session is, service or terminal.
  if (process.platform === "win32") return true;
  return process.platform === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Not the sync call the other channels get away with: this runs in the hub's own process, and may wait on a dialog. */
function show(title: string) {
  const [program, args] = notifyCommand(title);
  const env =
    process.platform === "win32"
      ? {
          ...process.env,
          AGENT_AUTOLOOP_TITLE: TITLE,
          AGENT_AUTOLOOP_BODY: `${title}\n${WORDS}`,
          AGENT_AUTOLOOP_APP: TOAST_APP,
        }
      : process.env;
  return new Promise<void>((resolve, reject) => {
    execFile(program, args, { timeout: 30_000, env, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

export default async function desktop({ hub, log, signal }: ChannelContext) {
  const available = hasDesktop();
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`连不上中台：${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // A notification is gone once shown: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    if (!available) {
      await hub.delivered(card.id, card.version, `skipped-${card.id}`);
      continue;
    }
    try {
      await show(card.title);
      await hub.delivered(card.id, card.version, `shown-${card.id}`);
    } catch (error) {
      log(`卡片 ${card.id} 的桌面通知没发出：${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
