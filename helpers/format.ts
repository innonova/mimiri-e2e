/**
 * The Linux package format under test. On Windows/macOS there is only one
 * packaged form, which is treated as "targz" (the platform default).
 */
export type AppFormat = "targz" | "flatpak" | "appimage" | "snap";

export const FLATPAK_APP_ID = "io.mimiri.notes";
export const SNAP_NAME = "mimiri-notes";

export interface ArtifactMeta {
  version: string;
  channel: string;
  platform: NodeJS.Platform;
  /** Package format; missing in metas written before formats existed → "targz". */
  format?: AppFormat;
  /** Path of the app executable, relative to the repo root (absent for flatpak). */
  executablePath?: string;
  /** Flatpak application id, set when format is "flatpak". */
  flatpakAppId?: string;
  /**
   * Ostree commit of the installed flatpak this meta was written for. The
   * installation is global mutable state; the commit ties the meta to it
   * (the version flatpak reports comes from stale AppStream metainfo).
   */
  flatpakCommit?: string;
  /** Snap package name, set when format is "snap". */
  snapName?: string;
}

const FORMATS: AppFormat[] = ["targz", "flatpak", "appimage", "snap"];

/**
 * Resolves the package format under test: explicit > APP_FORMAT env > targz.
 * "targz" is valid on every platform (it means the platform default artifact);
 * the other formats are Linux-only.
 */
export function resolveFormat(explicit?: string): AppFormat {
  const raw = explicit || process.env.APP_FORMAT || "targz";
  if (!FORMATS.includes(raw as AppFormat)) {
    throw new Error(
      `invalid format "${raw}" — expected one of ${FORMATS.join(", ")}`,
    );
  }
  const format = raw as AppFormat;
  if (format !== "targz" && process.platform !== "linux") {
    throw new Error(
      `format ${format} is only available on Linux (platform: ${process.platform})`,
    );
  }
  return format;
}
