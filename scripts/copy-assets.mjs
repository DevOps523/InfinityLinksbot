import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaSource = resolve(appRoot, "src/db/schema.sql");
const schemaTarget = resolve(appRoot, "dist/db/schema.sql");

try {
  await mkdir(dirname(schemaTarget), { recursive: true });
  await copyFile(schemaSource, schemaTarget);
} catch (error) {
  console.error(`Failed to copy required schema asset from ${schemaSource} to ${schemaTarget}.`);
  console.error(error);
  process.exitCode = 1;
}
