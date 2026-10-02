declare const SIKEMUX_VERSION: string | undefined;

/** The commit this build was made from. The release build writes it in; anything else is "dev". */
export const version: string =
  typeof SIKEMUX_VERSION === "string" ? SIKEMUX_VERSION : "dev";
