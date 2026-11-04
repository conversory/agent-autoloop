// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadPlugin } from "../host/plugins.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  command?: string[];
  contextFile: string;
  folder: string;
};
export type Reading = { text?: string; session?: string; usage?: Usage; error?: string; finished?: boolean };
export type Adapter = {
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Where a person can open this session. */
  link?(session: string): string;
  /** Whether it's installed and signed in: what's wrong, in words a person can act on, or nothing. */
  check?(): string | null;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

const found = new Map<string, string | null>();

const PATHEXT = () => (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase());

/** Where a program is on a Windows PATH: each folder in order, trying the extensions Windows tries. */
function windowsOnPath(name: string): string | null {
  const lower = name.toLowerCase();
  const extensions = PATHEXT().some((ext) => lower.endsWith(ext)) ? [""] : ["", ...PATHEXT()];
  for (const place of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!place || !path.isAbsolute(place)) continue;
    for (const ext of extensions) {
      const file = path.join(place, name + ext);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/** Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), or in one of these. */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  if (!found.has(name)) {
    let onPath: string | null = null;
    if (process.platform === "win32") onPath = windowsOnPath(name);
    else {
      const shell = process.env.SHELL ?? "/bin/sh";
      try {
        const printed = execFileSync(shell, ["-lc", `command -v ${name}`], {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        onPath = printed.trim().split("\n").at(-1) || null;
      } catch {}
    }
    found.set(name, onPath ?? elsewhere().find(existsSync) ?? null);
  }
  const program = found.get(name);
  if (!program) throw new Error(`找不到 ${name}：先装好并登录`);
  return program;
}

/** An npm shim names the script it runs; `%~dp0` is the folder the shim itself is in. */
const SHIM_SCRIPT = /"%?(%~dp0[\\\s\S]*?\.(?:mjs|cjs|js))"?/i;

/** What a program printed and how it went, for an adapter that checks its Agent is usable. */
export function capture(program: string, args: string[], timeoutMs = 20_000) {
  if (process.platform !== "win32") {
    return execFileSync(program, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  }
  const command = spawnable(program, args);
  const done = spawnSync(command.program, command.args, {
    encoding: "utf8",
    timeout: timeoutMs,
    ...(command.verbatim && { windowsVerbatimArguments: true }),
  });
  if (done.status !== 0) {
    throw new Error(String((done.stderr || done.stdout || "没跑成").trim().split("\n")[0]));
  }
  return done.stdout;
}

/** What cmd.exe would rewrite rather than pass on: percent signs expand variables, and the console code page can
 *  turn other writing systems into question marks on their way through a batch file. */
const THROUGH_CMD_UNSAFE = /[%\r\n"]/;

/**
 * A command Windows can start with every argument as it was written. An .exe goes straight there. A shim from npm is
 * followed to the script it runs, which goes to Node: nothing is re-parsed by a shell. A batch file that can't be
 * followed is run through cmd.exe with only what it passes on unchanged, because a prompt rewritten by a shell is a
 * rule's words said differently.
 */
export function spawnable(program: string, args: string[]): { program: string; args: string[]; verbatim?: boolean } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(program)) return { program, args };
  try {
    const script = readFileSync(program, "utf8");
    const said = SHIM_SCRIPT.exec(script)?.[1];
    if (said) {
      const resolved = path.resolve(path.dirname(program), said.replace(/%~dp0/i, "").replace(/^\\+/, ""));
      if (/\.(mjs|cjs|js)$/i.test(resolved) && existsSync(resolved)) {
        return { program: process.execPath, args: [resolved, ...args] };
      }
    }
  } catch {}
  for (const word of [program, ...args]) {
    if (THROUGH_CMD_UNSAFE.test(word)) {
      throw new Error(`${word} 里有 cmd.exe 会改写的字符（%、引号或换行），没法原样传给 ${program}`);
    }
  }
  return {
    program: "cmd.exe",
    args: ["/d", "/s", "/c", [program, ...args].map((word) => `"${word}"`).join(" ")],
    verbatim: true,
  };
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
