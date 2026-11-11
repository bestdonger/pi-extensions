import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const host = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
export const ai = join(host, "node_modules/@earendil-works/pi-ai");

// Tests resolve the installed host, just as Pi maps peer modules for extensions.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return next(pathToFileURL(join(host, "dist/index.js")).href, context);
		}
		if (specifier === "@earendil-works/pi-ai/models") {
			return next(pathToFileURL(join(ai, "dist/models.js")).href, context);
		}
		return next(specifier, context);
	},
});
