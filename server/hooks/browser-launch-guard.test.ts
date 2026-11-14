import { describe, expect, it } from "vitest";

import { browserLaunchVerdict, EXTERNAL_BROWSER_DENIAL } from "./browser-launch-guard.ts";

const verdict = (command: string, tool = "Bash") => browserLaunchVerdict(tool, { command });

const BLOCKED = [
  'open -a "Google Chrome"',
  'open -a "Google Chrome" https://example.com',
  "open -a Safari",
  "open -na 'Google Chrome' --args --remote-debugging-port=9222",
  "open -b com.google.Chrome",
  "open https://example.com",
  "open ./report.html",
  "open file:///tmp/a.html",
  "xdg-open https://example.com",
  "gio open https://example.com",
  "sensible-browser",
  "start chrome https://example.com",
  "cmd /c start https://example.com",
  'cmd.exe /c "start msedge https://example.com"',
  "explorer.exe https://example.com",
  'powershell -Command "Start-Process chrome https://example.com"',
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/p',
  "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --user-data-dir=/tmp/p &",
  "google-chrome-stable https://example.com",
  "chromium --new-window https://example.com",
  "firefox https://example.com",
  "nohup /usr/bin/chromium-browser --remote-debugging-port=9222 >/dev/null 2>&1 &",
  "sudo -u me open https://example.com",
  "env FOO=1 open https://example.com",
  "FOO=1 open -a Firefox",
  "echo hi && open https://example.com",
  "cd /tmp; open -a 'Microsoft Edge'",
  "true || open https://example.com",
  'bash -c "open https://example.com"',
  "sh -c 'cd /tmp && open -a Safari'",
  'eval "open https://example.com"',
  'echo $(open https://example.com)',
  'osascript -e \'tell application "Google Chrome" to activate\'',
  'osascript -e \'tell application "System Events" to set frontmost of process "Safari" to true\'',
  "osascript -e 'open location \"https://example.com\"'",
  "osascript -l JavaScript -e 'Application(\"Google Chrome\").activate()'",
  'python3 -c "import webbrowser; webbrowser.open(\'https://example.com\')"',
  "python3 -m webbrowser https://example.com",
  "python3 - <<'PY'\nfrom playwright.sync_api import sync_playwright\nwith sync_playwright() as p:\n    b = p.chromium.launch(headless=False)\nPY",
  'node -e "require(\'puppeteer\').launch({ headless: false })"',
  "python3 -c \"import subprocess; subprocess.run(['open', 'https://example.com'])\"",
  "python3 -c \"import os; os.system('open -a Safari')\"",
  "python3 -c \"import subprocess; subprocess.Popen(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])\"",
  "npx playwright open https://example.com",
  "npx playwright codegen",
  "pnpm exec playwright test --headed",
  "agent-browser open https://example.com --headed",
  "open -a Finder https://example.com",
  "open -R https://example.com",
  "open -a Safari -R page.html",
  'osascript -e \'tell application id "com.google.Chrome" to activate\'',
  'osascript -e \'tell application "Safari" to make new document\'',
  "osascript -l JavaScript -e 'Application(\"Finder\").openLocation(\"https://example.com\")'",
  "timeout 5 open https://example.com",
  "timeout 5s open -a Safari",
  "gtimeout -k 1 5 open https://example.com",
  "timeout --foreground -s KILL 10 open https://example.com",
  "timeout 5 chromium https://example.com",
  // Browsers that are not in every list: Zen and Dia stay refused when the app is named, even for a page file.
  `osascript -e 'tell application "Zen" to activate'`,
  `osascript -e 'tell application "Dia" to activate'`,
  `osascript -e 'tell application id "app.zen-browser.zen" to activate'`,
  `osascript -e 'tell application id "company.thebrowser.dia" to activate'`,
  "open -a Zen index.html",
  "open -a Dia index.html",
  "open -a 'Zen Browser' index.html",
  "open -b app.zen-browser.zen index.html",
  "timeout 5 open -a Dia index.html",
  `python3 -c "import subprocess; subprocess.run(['/Applications/Zen.app/Contents/MacOS/zen'])"`,
];

const ALLOWED = [
  "ls -la",
  "git status && git log --oneline -5",
  "grep -rn \"Google Chrome\" server",
  'echo "open -a Google Chrome"',
  "cat <<'EOF'\nopen -a \"Google Chrome\"\nEOF",
  "git commit -m 'fix: do not open https://example.com in Chrome'",
  "open .",
  "open -a Finder .",
  "open -a Xcode project.xcodeproj",
  "open ~/Documents/chrome-notes.md",
  "open -a Preview report.pdf",
  "ls /Applications/Google\\ Chrome.app",
  "defaults read /Applications/Google\\ Chrome.app/Contents/Info CFBundleShortVersionString",
  "pgrep -fl 'Google Chrome'",
  "pkill -f chrome",
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version',
  "chromium --headless --disable-gpu --screenshot https://example.com",
  "google-chrome --headless=new --dump-dom https://example.com",
  "firefox -headless --screenshot out.png https://example.com",
  "chrome-headless-shell --dump-dom https://example.com",
  "curl -s https://example.com | head",
  "python3 script.py",
  "python3 -c \"print('hello')\"",
  "python3 - <<'PY'\nimport requests\nprint(requests.get('https://example.com').status_code)\nPY",
  'node -e "console.log(1)"',
  'osascript -l JavaScript -e \'ObjC.import("AppKit"); $.NSScreen.mainScreen.frame.size.width\'',
  "osascript -e 'display notification \"done\"'",
  `osascript -e 'tell application "System Events" to get name of every window of process "Google Chrome"'`,
  'open -g "https://example.com"',
  'open -ga "Google Chrome" https://example.com',
  "npx playwright test",
  "pnpm exec playwright install chromium",
  "pnpm test && pnpm typecheck",
  "xdg-open .",
  "echo https://example.com # open https://example.com",
  "# open https://example.com\nls",
  "bash -c 'echo hi'",
  // Not a browser: another app brought to the front, or a page file shown in an editor / Finder.
  `osascript -e 'tell application "Xcode" to activate'`,
  `osascript -e 'tell application "Simulator" to activate'`,
  `osascript -e 'display dialog "Ready to launch"'`,
  'open -a "Visual Studio Code" index.html',
  "open -R report.html",
  "open -e page.html",
  "open -t page.html",
  "open -a Slack slack://channel",
  // Names that only contain a browser's name: Dialog, Media.app, Zenmap are not Dia, Zen.
  `osascript -e 'display dialog "Dialog ready"; activate'`,
  "open -a Media index.html",
  "open -a Zenmap index.html",
  `python3 -c "print('/Applications/Media.app')"`,
  // timeout is unwrapped, but only the command it runs is judged.
  "timeout 5 grep open file",
  "timeout 5 curl -s https://example.com",
  "gtimeout -k 1 5 sleep 1",
  "timeout 5 chromium --headless --dump-dom https://example.com",
];

describe("browserLaunchVerdict", () => {
  it.each(BLOCKED)("refuses %j", (command) => {
    expect(verdict(command)).toBe(EXTERNAL_BROWSER_DENIAL);
  });

  it.each(ALLOWED)("allows %j", (command) => {
    expect(verdict(command)).toBeNull();
  });

  it("checks a PowerShell tool call the same way", () => {
    expect(verdict("Start-Process chrome https://example.com", "PowerShell")).toBe(EXTERNAL_BROWSER_DENIAL);
    expect(verdict("Get-ChildItem", "PowerShell")).toBeNull();
  });

  it("checks a Monitor command the same way", () => {
    expect(verdict("open https://example.com", "Monitor")).toBe(EXTERNAL_BROWSER_DENIAL);
    expect(verdict("tail -f app.log", "Monitor")).toBeNull();
  });

  it("leaves every other tool alone", () => {
    expect(browserLaunchVerdict("Read", { command: "open https://example.com" })).toBeNull();
    expect(browserLaunchVerdict("mcp__browser__agent_browser_open", { url: "https://example.com" })).toBeNull();
  });

  it("lets a malformed call through", () => {
    expect(browserLaunchVerdict("Bash", null)).toBeNull();
    expect(browserLaunchVerdict("Bash", {})).toBeNull();
    expect(browserLaunchVerdict("Bash", { command: 7 })).toBeNull();
    expect(verdict("")).toBeNull();
  });

  it("stops unwrapping nested shells at a fixed depth", () => {
    let command = "open https://example.com";
    for (let i = 0; i < 8; i++) command = `bash -c ${JSON.stringify(command)}`;
    expect(verdict(command)).toBeNull();
    expect(verdict(`bash -c ${JSON.stringify("open https://example.com")}`)).toBe(EXTERNAL_BROWSER_DENIAL);
  });
});
