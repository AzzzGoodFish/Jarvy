/** Paths on a computer running Windows (A96). Pi's tools resolve paths as POSIX ones, so the Bot sees a Windows
 * computer's files as Git Bash writes them: `C:\Users\me` is `/c/Users/me`. They turn back into `C:/Users/me`, which
 * Windows takes too, on the way there. */
export function fromWindows(path: string): string {
  const slashed = path.replaceAll("\\", "/"), drive = /^([A-Za-z]):(\/.*)?$/.exec(slashed);
  return drive ? `/${drive[1]!.toLowerCase()}${drive[2] && drive[2] !== "/" ? drive[2] : ""}` || "/" : slashed;
}
export function toWindows(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  if (/^[A-Za-z]:(\/|$)/.test(slashed)) return slashed;
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(slashed);
  return drive ? `${drive[1]!.toUpperCase()}:${drive[2] ?? "/"}` : slashed;
}
/** A path the Bot wrote in Windows' own form, which Pi would otherwise take as a relative one. */
export const windowsLike = (path: string) => /^[A-Za-z]:([\\/]|$)/.test(path);
