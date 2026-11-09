import { t } from "../i18n";

/** How Bot info writes a sandbox's sizes and CPUs (A75). */
export const GB = 2 ** 30, MB = 2 ** 20;
/** At most two decimals, none when whole: 8, 0.5, 62.88. */
export const short = (value: number, digits = 2) => String(Number(value.toFixed(digits)));
/** A size in use: megabytes below a gigabyte, else gigabytes to one decimal. */
export const size = (bytes: number) => bytes < GB ? `${Math.round(bytes / MB)} MB` : `${short(bytes / GB, 1)} GB`;
export const cores = (count: number) => count === 1 ? t("environment.limits.oneCore") : t("environment.limits.cores", { count: short(count) });
