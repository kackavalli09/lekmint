import pkg from "../../../package.json";

/** Embed the release version when bundling; independent of runtime file layout. */
export const VERSION: string = pkg.version;
