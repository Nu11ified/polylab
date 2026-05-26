const commands = [
  { name: "server", args: ["run", "dev:server"] },
  { name: "desktop", args: ["run", "dev:desktop"] }
] as const;

const processes: Array<{ name: string; proc: Bun.Subprocess<"ignore", "pipe", "pipe"> }> = [];
let shuttingDown = false;

function prefixStream(name: string, stream: ReadableStream<Uint8Array> | null, writer: (line: string) => void) {
  if (!stream) return;
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) writer(`[${name}] ${line}`);
      }
    }
    if (buffer.trim()) writer(`[${name}] ${buffer}`);
  })();
}

function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] stopping (${signal})`);
  for (const { proc } of processes) proc.kill();
  setTimeout(() => process.exit(exitCode), 250);
}

for (const command of commands) {
  const proc = Bun.spawn(["bun", ...command.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env
  });
  processes.push({ name: command.name, proc });
  prefixStream(command.name, proc.stdout, console.log);
  prefixStream(command.name, proc.stderr, console.error);
  void proc.exited.then((code) => {
    if (!shuttingDown) shutdown(`${command.name} exited with ${code}`, code);
  });
}

console.log("[dev] PolyLab server + desktop started");
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await Promise.all(processes.map(({ proc }) => proc.exited));
