import { spawn } from "node:child_process";

const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1"], { stdio: "inherit" });

const wait = async () => {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:5173");
      if (response.ok) return;
    } catch {
      await Bun.sleep(150);
    }
  }
  throw new Error("Vite dev server did not become ready");
};

await wait();
const electron = spawn("bun", ["x", "electron", "."], {
  stdio: "inherit",
  env: { ...process.env, POLYLAB_DESKTOP_URL: "http://127.0.0.1:5173" }
});

const shutdown = () => {
  vite.kill();
  electron.kill();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

electron.on("exit", () => {
  shutdown();
  process.exit(0);
});
