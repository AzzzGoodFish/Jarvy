import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Self-contained Windows ConPTY host compiled once via built-in .NET Framework (`Add-Type`) and cached by hash
 * (A103). Requires Windows 10 1809+ / Windows 11 with zero external dependencies, working identically in both
 * `connector.mjs` and the Electron desktop client.
 *
 * Binary stdin framing:
 * - `0x00` + uint32be(len) + raw UTF-8 bytes → write to ConPTY input
 * - `0x01` + uint16be(cols) + uint16be(rows) → ResizePseudoConsole
 * - `0x02` → close ConPTY and terminate child process
 * Stdout emits raw ConPTY VT100/ANSI output. */
const CONPTY_CS = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class JarvyConPty {
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint INFINITE = 0xFFFFFFFF;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);

  [StructLayout(LayoutKind.Sequential)]
  struct COORD { public short X; public short Y; }

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, int nSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void ClosePseudoConsole(IntPtr hPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
    bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr hObject);

  static bool ReadExact(Stream s, byte[] buf, int count) {
    int off = 0;
    while (off < count) {
      int n = s.Read(buf, off, count - off);
      if (n <= 0) return false;
      off += n;
    }
    return true;
  }

  public static int Main(string[] args) {
    if (args.Length < 4) { Console.Error.WriteLine("usage: cols rows cwd command"); return 2; }
    short cols = (short)Math.Max(2, Math.Min(500, int.Parse(args[0])));
    short rows = (short)Math.Max(1, Math.Min(200, int.Parse(args[1])));
    string cwd = args[2];
    string cmd = args[3];

    var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = false };
    SafeFileHandle inRead, inWrite, outRead, outWrite;
    if (!CreatePipe(out inRead, out inWrite, ref sa, 0) || !CreatePipe(out outRead, out outWrite, ref sa, 0)) {
      Console.Error.WriteLine("CreatePipe failed: " + Marshal.GetLastWin32Error());
      return 1;
    }

    IntPtr hPC = IntPtr.Zero;
    int hr = CreatePseudoConsole(new COORD { X = cols, Y = rows }, inRead, outWrite, 0, out hPC);
    inRead.Dispose();
    outWrite.Dispose();
    if (hr != 0) {
      Console.Error.WriteLine("CreatePseudoConsole failed: 0x" + hr.ToString("X8"));
      return 1;
    }

    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr attrList = Marshal.AllocHGlobal(attrSize);
    var pi = new PROCESS_INFORMATION();
    try {
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize) ||
          !UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) {
        Console.Error.WriteLine("ProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
        ClosePseudoConsole(hPC);
        return 1;
      }
      // Explicitly set STARTF_USESTDHANDLES with null handles so CreateProcessW does not inherit
      // this helper's own redirected pipe stdio (framing stdin / log stderr) into the ConPTY child.
      var siEx = new STARTUPINFOEX {
        StartupInfo = new STARTUPINFO {
          cb = Marshal.SizeOf(typeof(STARTUPINFOEX)),
          dwFlags = STARTF_USESTDHANDLES,
          hStdInput = IntPtr.Zero,
          hStdOutput = IntPtr.Zero,
          hStdError = IntPtr.Zero,
        },
        lpAttributeList = attrList
      };
      if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, string.IsNullOrEmpty(cwd) ? null : cwd, ref siEx, out pi)) {
        Console.Error.WriteLine("CreateProcessW failed: " + Marshal.GetLastWin32Error());
        ClosePseudoConsole(hPC);
        return 1;
      }
    } finally {
      DeleteProcThreadAttributeList(attrList);
      Marshal.FreeHGlobal(attrList);
    }

    int closed = 0;
    Action shutdown = () => {
      if (Interlocked.Exchange(ref closed, 1) == 0) {
        try { ClosePseudoConsole(hPC); } catch {}
      }
    };

    var outThread = new Thread(() => {
      try {
        using (var src = new FileStream(outRead, FileAccess.Read, 4096))
        using (var dst = Console.OpenStandardOutput()) {
          var buf = new byte[16384];
          int n;
          while ((n = src.Read(buf, 0, buf.Length)) > 0) {
            dst.Write(buf, 0, n);
            dst.Flush();
          }
        }
      } catch {}
    }) { IsBackground = true };
    outThread.Start();

    var inThread = new Thread(() => {
      try {
        using (var src = Console.OpenStandardInput())
        using (var dst = new FileStream(inWrite, FileAccess.Write, 4096)) {
          var hdr = new byte[4];
          while (true) {
            int op = src.ReadByte();
            if (op < 0 || op == 2) {
              try { TerminateProcess(pi.hProcess, 1); } catch {}
              shutdown();
              break;
            }
            if (op == 0) {
              if (!ReadExact(src, hdr, 4)) break;
              int len = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
              if (len < 0 || len > 16 * 1024 * 1024) break;
              var data = new byte[len];
              if (!ReadExact(src, data, len)) break;
              dst.Write(data, 0, len);
              dst.Flush();
            } else if (op == 1) {
              if (!ReadExact(src, hdr, 4)) break;
              short c = (short)Math.Max(2, Math.Min(500, (hdr[0] << 8) | hdr[1]));
              short r = (short)Math.Max(1, Math.Min(200, (hdr[2] << 8) | hdr[3]));
              if (Volatile.Read(ref closed) == 0) {
                try { ResizePseudoConsole(hPC, new COORD { X = c, Y = r }); } catch {}
              }
            }
          }
        }
      } catch {}
    }) { IsBackground = true };
    inThread.Start();

    WaitForSingleObject(pi.hProcess, INFINITE);
    uint code = 0;
    GetExitCodeProcess(pi.hProcess, out code);
    shutdown();
    outThread.Join(1000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return unchecked((int)code);
  }
}
`;

export interface WinPtyProcess {
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface WinPtyOptions {
  cache: string;
  cwd: string;
  argv: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  onData: (chunk: Buffer) => void;
  onExit: (code: number | null, error?: string) => void;
  onLog?: (text: string) => void;
}

const HASH = createHash("sha256").update(CONPTY_CS).digest("hex").slice(0, 12);
let building: Promise<string> | null = null;

/** Ensures the compiled ConPTY host executable exists in `cache`, compiling it once on Windows. */
async function ensureHost(cache: string): Promise<string> {
  const dir = join(cache, "conpty");
  const exe = join(dir, `jarvy-conpty-${HASH}.exe`);
  if (existsSync(exe)) return exe;
  building ??= compileHost(dir, exe).finally(() => { building = null; });
  return building;
}

async function compileHost(dir: string, exe: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const cs = join(dir, `jarvy-conpty-${HASH}-${process.pid}.cs`);
  const tmp = join(dir, `jarvy-conpty-${HASH}-${process.pid}.tmp.exe`);
  await writeFile(cs, CONPTY_CS, "utf8");
  try {
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const cmd = `Add-Type -Path '${cs.replaceAll("'", "''")}' -OutputType ConsoleApplication -OutputAssembly '${tmp.replaceAll("'", "''")}'`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(existsSync(ps) ? ps : "powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      const err: Buffer[] = [];
      child.stderr.on("data", chunk => err.push(chunk));
      child.stdout.on("data", chunk => err.push(chunk));
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0 && existsSync(tmp)) resolve();
        else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `ConPTY helper build exited with ${code}`));
      });
    });
    await rename(tmp, exe);
    return exe;
  } finally {
    await rm(cs, { force: true }).catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Formats an argv array as a Windows `CreateProcessW` command line (MSVC escaping rules). */
export function quoteWinArgv(argv: readonly string[]): string {
  return argv.map(arg => {
    if (!arg.length || /[\s"]/.test(arg)) {
      return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
    }
    return arg;
  }).join(" ");
}

/** Spawns a Windows ConPTY terminal via the cached helper executable. */
export async function spawnWinPty(options: WinPtyOptions): Promise<WinPtyProcess> {
  const exe = await ensureHost(options.cache);
  const cols = Math.max(2, Math.min(500, Math.floor(options.cols)));
  const rows = Math.max(1, Math.min(200, Math.floor(options.rows)));
  const command = quoteWinArgv(options.argv);
  const child: ChildProcess = spawn(exe, [String(cols), String(rows), options.cwd, command], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...options.env },
  });
  let done = false;
  const finish = (code: number | null, error?: string) => {
    if (done) return;
    done = true;
    options.onExit(code, error);
  };
  child.stdout?.on("data", (chunk: Buffer) => options.onData(chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) options.onLog?.(`conpty: ${text}`);
  });
  child.stdin?.on("error", () => {});
  child.on("close", code => finish(code));
  child.on("error", error => finish(null, error.message));

  return {
    write(bytes: Buffer) {
      if (done || !child.stdin || child.stdin.destroyed) return;
      const head = Buffer.alloc(5);
      head[0] = 0;
      head.writeUInt32BE(bytes.length, 1);
      child.stdin.write(Buffer.concat([head, bytes]));
    },
    resize(nextCols: number, nextRows: number) {
      if (done || !child.stdin || child.stdin.destroyed) return;
      const buf = Buffer.alloc(5);
      buf[0] = 1;
      buf.writeUInt16BE(Math.max(2, Math.min(500, Math.floor(nextCols))), 1);
      buf.writeUInt16BE(Math.max(1, Math.min(200, Math.floor(nextRows))), 3);
      child.stdin.write(buf);
    },
    kill() {
      if (done) return;
      if (child.stdin && !child.stdin.destroyed) {
        try { child.stdin.write(Buffer.from([2])); child.stdin.end(); } catch {}
      }
      setTimeout(() => { if (!done) try { child.kill(); } catch {} }, 500).unref();
    },
  };
}
