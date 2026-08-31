import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.ASCENT_ROOT ?? path.resolve(process.cwd(), "..", ".."));
const uproject = path.resolve(process.env.ASCENT_UPROJECT ?? path.join(root, "Ascent", "Ascent.uproject"));

if (!existsSync(uproject)) {
  throw new Error(`Ascent uproject not found: ${uproject}`);
}

console.log(JSON.stringify({ ok: true, root, uproject }, null, 2));
