// Where a Mac or Linux worker leaves a shell wrapper between itself and the agent, Windows leaves this: a small Node
// process that starts the agent with its output and its exit code in files, keeps a heartbeat going while it runs,
// stops its whole tree when told to, and goes away only after the exit code is published. The worker can stop and
// come back and find the agent still going, or finished: the files and the heartbeat are all it needs to tell which.
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// out err exit beat stop cwd -- program args...
const [out, err, exit, beat, stop, cwd, divider, ...rest] = process.argv.slice(2);
const argv = divider === "--" ? rest : [];
if (!out || !err || !exit || !beat || !stop || !cwd || !argv.length) process.exit(64);

const BEAT = 1000;

/** Publishes the exit code, stops saying it's alive, and goes. */
function finished(code: number): never {
  try {
    writeFileSync(`${exit}.tmp`, String(code));
    renameSync(`${exit}.tmp`, exit);
  } catch {}
  try {
    unlinkSync(beat);
  } catch {}
  process.exit(0);
}

function sayToErr(message: string) {
  try {
    writeFileSync(err, `${message}\n`);
  } catch {}
}

const { spawnable } = await import("./agents.ts");
let command: { program: string; args: string[]; verbatim?: boolean };
try {
  command = spawnable(argv[0], argv.slice(1));
} catch (error) {
  sayToErr(String((error as Error).message ?? error));
  finished(127);
}

writeFileSync(beat, String(process.pid));
const heart = setInterval(() => {
  try {
    writeFileSync(beat, String(process.pid));
  } catch {}
}, BEAT);

/** What the worker has asked for: nothing yet, a stop, or a stop that can't wait. */
const told = () => {
  try {
    if (!existsSync(stop)) return null;
    return readFileSync(stop, "utf8").trim() === "force" ? "force" : "term";
  } catch {
    return null;
  }
};

let child: ReturnType<typeof spawn>;
try {
  const stdout = openSync(out, "w");
  const stderr = openSync(err, "w");
  child = spawn(command.program, command.args, {
    cwd,
    env: process.env,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
    ...(command.verbatim && { windowsVerbatimArguments: true }),
  });
  closeSync(stdout);
  closeSync(stderr);
} catch (error) {
  sayToErr(String((error as Error).message ?? error));
  finished(127);
}
child.on("error", (error) => {
  clearInterval(heart);
  sayToErr(String(error.message ?? error));
  finished(127);
});
child.on("exit", (code) => {
  clearInterval(heart);
  finished(code ?? 1);
});

// A stop goes to the agent and everything it started: taskkill walks the tree the way a signal went to a process group.
let lastAsk: string | null = null;
const watch = setInterval(() => {
  const ask = told();
  if (ask !== lastAsk && (ask === "term" || ask === "force")) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", ...(ask === "force" ? ["/F"] : [])], () => {});
  }
  lastAsk = ask;
}, 500);
watch.unref();
