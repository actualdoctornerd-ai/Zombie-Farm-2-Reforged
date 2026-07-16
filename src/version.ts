import packageJson from "../package.json";

/** User-facing game version. Keep the full semver in package.json, but omit a
 * trailing zero patch so the initial 0.1.0 release is presented as "0.1". */
export const APP_VERSION = packageJson.version.replace(/\.0$/, "");
