// Where things are in the API. Each name goes into the path as one segment, encoded the way the
// CLI encodes it.

import { JiayangError } from "./errors.js";

/** A path segment, written as the CLI writes one. An empty name, `.` or `..` names nothing, and a
 *  URL parser would fold the last two into the path around them, so they're refused. */
export function segment(raw: string): string {
	if (raw === "" || raw === "." || raw === "..") throw new JiayangError(`"${raw}" isn't a name the API has anything under.`);
	let out = "";
	for (const byte of new TextEncoder().encode(raw)) {
		const c = String.fromCharCode(byte);
		out += /[A-Za-z0-9\-_.~@]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** The path of a workspace, or of one of its apps. */
export const wsPath = (ws: string) => `/v1/workspaces/${segment(ws)}`;
export const appPath = (ws: string, app: string) => `${wsPath(ws)}/apps/${segment(app)}`;

