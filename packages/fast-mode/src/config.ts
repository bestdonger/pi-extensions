import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function loadFastMode(): boolean {
	const path = join(getAgentDir(), "fast-mode.json");
	if (!existsSync(path)) return false;
	return JSON.parse(readFileSync(path, "utf8")).enabled ?? false;
}

export function saveFastMode(enabled: boolean): void {
	const dir = getAgentDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "fast-mode.json");
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`);
	// Other Pi processes must see a complete config, never a partially written JSON file.
	renameSync(temporary, path);
}
