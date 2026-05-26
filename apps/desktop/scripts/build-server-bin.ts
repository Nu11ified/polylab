const mode = process.argv[2] ?? "all";

const targets = [
  { mode: "linux", target: "bun-linux-x64", name: "polylab-server-linux-x64" },
  { mode: "mac", target: "bun-darwin-x64", name: "polylab-server-darwin-x64" },
  { mode: "mac", target: "bun-darwin-arm64", name: "polylab-server-darwin-arm64" }
] as const;

const selected = targets.filter((item) => mode === "all" || item.mode === mode);

await Bun.$`rm -rf server-bin`;
await Bun.$`mkdir -p server-bin`;

for (const item of selected) {
  await Bun.$`bun build ../../apps/server/src/index.ts --compile --target=${item.target} --outfile server-bin/${item.name}`;
}
