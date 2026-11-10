import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const host = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return next(pathToFileURL(join(host, "dist/index.js")).href, context);
		}
		return next(specifier, context);
	},
});
