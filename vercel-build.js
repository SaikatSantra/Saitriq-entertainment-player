import { spawnSync } from "node:child_process";

const packageManagerCli = process.env.npm_execpath;

if (!packageManagerCli) {
  throw new Error("The package manager CLI path is unavailable.");
}

function runNpm(args) {
  const result = spawnSync(process.execPath, [packageManagerCli, ...args], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runNpm(["exec", "prisma", "generate"]);

if (process.env.VERCEL_ENV === "production") {
  runNpm(["exec", "prisma", "db", "push"]);
} else {
  console.log("Skipping Prisma db push outside Vercel Production.");
}

runNpm(["run", "build"]);