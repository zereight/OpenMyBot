export const EXTERNAL_BROWSER_DENIAL =
  "OpenMausBot blocked this command: it opens a browser window on the person's desktop and takes their focus. Use your own browser tools (agent_browser_*) instead. If they fail, retry once, then stop and tell the person what failed and what you needed. Do not open Chrome, Safari, Firefox, Edge or any URL through the shell, AppleScript or a script. A headless browser (--headless) is allowed.";

interface Command {
  words: string[];
  stdin: string;
}

const MAX_DEPTH = 4;
const BROWSER_NAME = String.raw`(?:google[ -]?chrome(?: for testing| canary| beta)?|chromium|chrome|microsoft[ -]?edge|msedge|brave(?: browser)?|firefox|safari|vivaldi|opera|arc|orion|zen(?: browser)?|dia)`;
const BROWSER_APP = new RegExp(String.raw`(?:^|[^a-z0-9])${BROWSER_NAME}(?:\.app)?(?:$|[^a-z0-9])`, "i");
const BROWSER_BUNDLE = /\b(?:com\.google\.chrome|com\.apple\.safari|com\.microsoft\.edgemac|org\.mozilla\.firefox|com\.brave\.browser|com\.vivaldi\.vivaldi|com\.operasoftware\.opera|company\.thebrowser\.browser|company\.thebrowser\.dia|app\.zen-browser\.zen)\b/i;
const BROWSER_BINARY = /^(?:google[ -]chrome(?:-stable|-beta|-unstable| for testing| canary)?|chromium(?:-browser)?|chrome|msedge|microsoft[ -]edge(?:-stable|-beta|-dev)?|brave(?:-browser| browser)?|firefox|vivaldi|opera|safari)$/;
const BROWSER_APP_BUNDLE = /(?:google chrome(?: for testing| canary)?|chromium|microsoft edge|brave browser|firefox|vivaldi|opera|(?<![a-z0-9])(?:zen|dia))\.app\b/i;
const URL_ARGUMENT = /^(?:https?|file|ftp|about|chrome|chrome-extension):/i;
const PAGE_FILE = /\.(?:html?|xhtml|mhtml)(?:[?#].*)?$/i;
const WRAPPERS = new Set(["sudo", "nohup", "exec", "time", "command", "builtin", "nice", "setsid", "caffeinate", "stdbuf", "env", "arch", "then", "do", "else", "elif", "if", "while", "until", "!", "doas"]);
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-n", "-t"]);
// `timeout [flags] DURATION command`: unlike the wrappers above it takes one positional argument before the command.
const TIMEOUT_WRAPPERS = new Set(["timeout", "gtimeout"]);
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "-k", "--signal", "--kill-after"]);
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = /^(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|tsx|ts-node|osascript|jxa|pwsh|powershell|swift|lua)$/;
const RUNNERS = new Set(["npx", "pnpx", "bunx", "pnpm", "yarn", "npm", "dlx", "exec", "x"]);
const HEADLESS_FLAG = /^-{1,2}headless(?:=.*)?$/i;

function splitCommands(source: string): Command[] {
  const commands: Command[] = [];
  let current: Command = { words: [], stdin: "" };
  let word = "";
  let inWord = false;
  const pending: { delimiter: string; strip: boolean; owner: Command }[] = [];
  const endWord = () => {
    if (inWord) current.words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (current.words.length || current.stdin) commands.push(current);
    current = { words: [], stdin: "" };
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      const stop = end === -1 ? source.length : end;
      word += source.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (ch === '"') {
      i++;
      inWord = true;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) i++;
        word += source[i];
        i++;
      }
      i++;
    } else if (ch === "\\") {
      if (source[i + 1] === "\n") i += 2;
      else {
        word += source[i + 1] ?? "";
        inWord = true;
        i += 2;
      }
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i++;
    } else if (ch === "\n") {
      endCommand();
      i++;
      while (pending.length) {
        const heredoc = pending.shift()!;
        const lines: string[] = [];
        while (i < source.length) {
          let end = source.indexOf("\n", i);
          if (end === -1) end = source.length;
          const line = source.slice(i, end);
          i = end + 1;
          if ((heredoc.strip ? line.replace(/^\t+/, "") : line).trimEnd() === heredoc.delimiter) break;
          lines.push(line);
        }
        heredoc.owner.stdin += `${lines.join("\n")}\n`;
      }
    } else if (ch === "#" && !inWord) {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === "<" && source[i + 1] === "<" && source[i + 2] !== "<") {
      const strip = source[i + 2] === "-";
      i += strip ? 3 : 2;
      while (source[i] === " " || source[i] === "\t") i++;
      let delimiter = "";
      while (i < source.length && !/[\s;&|()<>]/.test(source[i]!)) {
        if (source[i] !== "'" && source[i] !== '"' && source[i] !== "\\") delimiter += source[i];
        i++;
      }
      endWord();
      if (delimiter) pending.push({ delimiter, strip, owner: current });
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "`") {
      endCommand();
      i++;
    } else {
      word += ch;
      inWord = true;
      i++;
    }
  }
  endCommand();
  return commands;
}

const baseName = (word: string): string => {
  const name = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return name.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
};

function stripPrefix(words: string[]): string[] {
  let rest = words;
  for (;;) {
    const [first] = rest;
    if (first === undefined) return rest;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || /^\d*[<>]/.test(first)) {
      rest = rest.slice(/^\d*[<>]+$/.test(first) ? 2 : 1);
    } else if (TIMEOUT_WRAPPERS.has(baseName(first))) {
      rest = rest.slice(1);
      while (rest.length && rest[0]!.startsWith("-")) rest = rest.slice(TIMEOUT_VALUE_FLAGS.has(rest[0]!) ? 2 : 1);
      if (rest.length && TIMEOUT_DURATION.test(rest[0]!)) rest = rest.slice(1);
    } else if (WRAPPERS.has(baseName(first))) {
      rest = rest.slice(1);
      while (rest.length && (rest[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!))) {
        rest = rest.slice(WRAPPER_VALUE_FLAGS.has(rest[0]!) && baseName(first) !== "env" ? 2 : 1);
      }
    } else {
      return rest;
    }
  }
}

function openTargetsBrowser(args: string[]): boolean {
  // `open -a <app> page.html` opens the page in <app>; `-R` reveals it in Finder and `-e`/`-t` edit it. None of those is a page viewer,
  // so a .html file there is not a browser launch. A URL is still refused: which app a URL reaches is not something this can tell.
  let pageIsNotShown = false;
  let namesBrowser = false;
  let pageFile = false;
  let url = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--args") break;
    if (URL_ARGUMENT.test(arg)) url = true;
    if (PAGE_FILE.test(arg)) pageFile = true;
    const app = /^-[a-zA-Z]*[ab][a-zA-Z]*$/.exec(arg) ? args[i + 1] : /^--(?:app|bundle)=(.*)$/.exec(arg)?.[1];
    if (app !== undefined) {
      if (BROWSER_APP.test(app) || BROWSER_BUNDLE.test(app)) namesBrowser = true;
      else pageIsNotShown = true;
    }
    if (/^-[a-zA-Z]*[Reft][a-zA-Z]*$/.test(arg)) pageIsNotShown = true;
  }
  return namesBrowser || url || (pageFile && !pageIsNotShown);
}

function scriptOpensBrowser(text: string): boolean {
  if (/\bwebbrowser\s*\.\s*(?:open|get)\b|-m\s+webbrowser\b/.test(text)) return true;
  if (/\bheadless\s*[:=]\s*(?:False|false|0)\b/.test(text)) return true;
  if (BROWSER_APP_BUNDLE.test(text) && !/--headless/i.test(text)) return true;
  if (/["'`]\s*(?:open|xdg-open|start)\s+(?:-\w+\s+)*["']?(?:https?:\/\/|file:\/\/|-a\b)/.test(text)) return true;
  if (/\[\s*["'](?:open|xdg-open)["']\s*,\s*["']?(?:https?:|file:|-\w*a\b)/.test(text)) return true;
  return false;
}

/**
 * Opening a location always reaches the default browser. Bringing an app to the front or opening a window only counts when the script
 * names a browser, so `tell application "Xcode" to activate` and reading a browser's window names both pass.
 */
function osascriptDrivesBrowser(text: string): boolean {
  if (/\bopen location\b|\bopenLocation\b/i.test(text)) return true;
  const bringsToFront = /\bactivate\b|\bmake new (?:window|document|tab)\b|\breopen\b|\bset frontmost\b|\bfrontmost\b[^\n;]*\bto true\b|\blaunch\b/i.test(text);
  return bringsToFront && (BROWSER_APP.test(text) || BROWSER_BUNDLE.test(text));
}

function powershellOpensBrowser(text: string): boolean {
  if (!/\bStart-Process\b|\bstart\s+/i.test(text)) return false;
  return BROWSER_APP.test(text) || /\bhttps?:\/\//i.test(text);
}

function runnerOpensBrowser(words: string[]): boolean {
  const tools = words.map(baseName);
  const playwright = tools.includes("playwright");
  const agentBrowser = tools.includes("agent-browser");
  const puppeteer = tools.includes("puppeteer");
  if (!playwright && !agentBrowser && !puppeteer) return false;
  if (words.includes("--headed")) return true;
  return playwright && words.some((word) => word === "open" || word === "codegen" || word === "show-trace" || word === "show-report");
}

function commandVerdict(command: Command, depth: number): boolean {
  const words = stripPrefix(command.words);
  const [first, ...args] = words;
  if (first === undefined) return false;
  const name = baseName(first);
  const argText = `${args.join(" ")}\n${command.stdin}`;

  if (SHELLS.has(name) || name === "eval") {
    if (depth >= MAX_DEPTH) return false;
    const script = name === "eval" ? args.join(" ") : args[args.findIndex((arg) => /^-[a-zA-Z]*c$/.test(arg)) + 1];
    const inline = name === "eval" || args.some((arg) => /^-[a-zA-Z]*c$/.test(arg));
    return (inline && script !== undefined && textVerdict(script, depth + 1)) || (command.stdin !== "" && textVerdict(command.stdin, depth + 1));
  }
  if (name === "cmd") {
    const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
    return depth < MAX_DEPTH && at !== -1 && textVerdict(args.slice(at + 1).join(" "), depth + 1);
  }
  // -g opens in the background: the person's focus stays where it is.
  if (name === "open") return !args.some((arg) => /^-[a-zA-Z]*g[a-zA-Z]*$/.test(arg)) && openTargetsBrowser(args) && !(args.some((arg) => HEADLESS_FLAG.test(arg)) && !args.some((arg) => URL_ARGUMENT.test(arg)));
  if (name === "xdg-open" || name === "gnome-open" || name === "kde-open" || name === "kde-open5" || name === "wslview") {
    return args.some((arg) => URL_ARGUMENT.test(arg) || PAGE_FILE.test(arg));
  }
  if (name === "gio") return args[0] === "open" && args.slice(1).some((arg) => URL_ARGUMENT.test(arg) || PAGE_FILE.test(arg));
  if (name === "sensible-browser" || name === "x-www-browser" || name === "www-browser" || name === "gnome-www-browser") return true;
  if (name === "start") return args.some((arg) => URL_ARGUMENT.test(arg) || BROWSER_APP.test(arg));
  if (name === "explorer") return args.some((arg) => URL_ARGUMENT.test(arg));
  if (BROWSER_BINARY.test(name)) {
    if (args.some((arg) => HEADLESS_FLAG.test(arg))) return false;
    return !(args.length > 0 && args.every((arg) => /^-{1,2}(?:version|v|help|h)$/.test(arg)));
  }
  if (name === "osascript") return osascriptDrivesBrowser(argText);
  if (name === "pwsh" || name === "powershell") return powershellOpensBrowser(argText) || scriptOpensBrowser(argText);
  if (INTERPRETERS.test(name)) return scriptOpensBrowser(argText);
  if (RUNNERS.has(name) || name === "playwright" || name === "agent-browser" || name === "puppeteer") return runnerOpensBrowser(words);
  return false;
}

function textVerdict(source: string, depth: number): boolean {
  return splitCommands(source).some((command) => commandVerdict(command, depth));
}

/** The reason a tool call must not run, or null. Only a shell command that opens a browser window on the desktop is refused. */
export function browserLaunchVerdict(toolName: string, input: unknown): string | null {
  if (toolName !== "Bash" && toolName !== "PowerShell" && toolName !== "Monitor") return null;
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim() === "") return null;
  const opens = toolName === "PowerShell" ? powershellOpensBrowser(command) || scriptOpensBrowser(command) : textVerdict(command, 0);
  return opens ? EXTERNAL_BROWSER_DENIAL : null;
}
