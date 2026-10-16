import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".git") && !process.env.CI) {
  execFileSync("npx", ["lefthook", "install"], { stdio: "inherit", shell: process.platform === "win32" });
}
