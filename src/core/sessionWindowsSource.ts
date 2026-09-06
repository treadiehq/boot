/** Windows system APIs only; compiled by the inbox .NET Framework C# compiler. */
export const WINDOWS_SESSION_SOURCE = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class BootWindows {
  static void Trace(string message) { if (Environment.GetEnvironmentVariable("BOOT_WINDOWS_TEST_TRACE") == "1") Console.Error.WriteLine("Windows helper: " + message); }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileSizeEx(SafeFileHandle file, out long size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long result, uint method);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle file);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle file, uint code, ref Extents input, int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumePathNameW(string file, StringBuilder root, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeNameForVolumeMountPointW(string root, StringBuilder name, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationW(string root, IntPtr label, uint labelSize, out uint serial, out uint maxName, out uint flags, StringBuilder type, uint typeSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr FindFirstStreamW(string file, int level, out StreamData data, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool FindNextStreamW(IntPtr find, out StreamData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr find);
  [StructLayout(LayoutKind.Sequential)] struct Extents { public IntPtr source; public long from, to, bytes; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StreamData { public long size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)] public string name; }
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string NativePath(string file) {
    string full = Path.GetFullPath(file);
    if (full.StartsWith(@"\\?\")) return full;
    if (full.StartsWith(@"\\")) throw new Win32Exception(50);
    return @"\\?\" + full;
  }
  static string Volume(string file) {
    StringBuilder root = new StringBuilder(32768), name = new StringBuilder(128), type = new StringBuilder(32);
    Check(GetVolumePathNameW(NativePath(file), root, (uint)root.Capacity));
    uint serial, maxName, flags;
    Check(GetVolumeInformationW(root.ToString(), IntPtr.Zero, 0, out serial, out maxName, out flags, type, (uint)type.Capacity));
    if (type.ToString() != "ReFS" || (flags & 0x08000000) == 0) throw new Win32Exception(50);
    Check(GetVolumeNameForVolumeMountPointW(root.ToString(), name, (uint)name.Capacity));
    return name.ToString();
  }
  static void NoStreams(string file) {
    StreamData data;
    IntPtr find = FindFirstStreamW(NativePath(file), 0, out data, 0);
    if (find == new IntPtr(-1)) { if (Marshal.GetLastWin32Error() == 38) return; throw new Win32Exception(Marshal.GetLastWin32Error()); }
    try {
      do { if (data.name != "::$DATA") throw new Win32Exception(50); } while (FindNextStreamW(find, out data));
      if (Marshal.GetLastWin32Error() != 38) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { FindClose(find); }
  }
  static void Clone(string source, string destination) {
    if ((File.GetAttributes(NativePath(source)) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new Win32Exception(50);
    if (!String.Equals(Volume(source), Volume(Path.GetDirectoryName(destination)), StringComparison.OrdinalIgnoreCase)) throw new Win32Exception(17);
    NoStreams(source);
    bool created = false;
    try {
      using (SafeFileHandle input = CreateFileW(NativePath(source), 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        if (input.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        using (SafeFileHandle output = CreateFileW(NativePath(destination), 0xc0000000, 0, IntPtr.Zero, 1, 0x80, IntPtr.Zero)) {
          if (output.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
          created = true;
          long length, position; int returned;
          Check(GetFileSizeEx(input, out length));
          byte[] integrity = new byte[16];
          Check(DeviceIoControl(input, 0x9027c, null, 0, integrity, integrity.Length, out returned, IntPtr.Zero));
          uint cluster = BitConverter.ToUInt32(integrity, 12);
          if (cluster == 0 || (cluster & (cluster - 1)) != 0) throw new Win32Exception(50);
          Check(DeviceIoControl(output, 0x9c280, integrity, 8, null, 0, out returned, IntPtr.Zero));
          Check(DeviceIoControl(output, 0x900c4, null, 0, null, 0, out returned, IntPtr.Zero));
          Check(SetFilePointerEx(output, length, out position, 0)); Check(SetEndOfFile(output));
          long extentEnd = checked((length + cluster - 1) / cluster * cluster);
          for (long offset = 0; offset < extentEnd;) {
            long size = Math.Min(1024L * 1024 * 1024, extentEnd - offset);
            Extents extent = new Extents { source = input.DangerousGetHandle(), from = offset, to = offset, bytes = size };
            Check(DeviceIoControl(output, 0x98344, ref extent, Marshal.SizeOf(typeof(Extents)), IntPtr.Zero, 0, out returned, IntPtr.Zero));
            offset += size;
          }
        }
      }
    } catch { if (created) File.Delete(NativePath(destination)); throw; }
  }

  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking; public uint processLimit; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user, kernel, periodUser, periodKernel; public uint pageFaults, processes, active, terminated; }
  [StructLayout(LayoutKind.Sequential)] struct Startup { public uint cb; public IntPtr reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reservedSize; public IntPtr reservedData,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr from, IntPtr handle, IntPtr to, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint kind, uint group);
  delegate bool ControlHandler(uint kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(ControlHandler handler, bool add);
  static readonly ControlHandler IgnoreConsole = delegate(uint kind) { return true; };

  // Windows CRT quoting. An explicit application path avoids executable-name ambiguity.
  static string Quote(string argument) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char value in argument) {
      if (value == '\\') { slashes++; continue; }
      result.Append('\\', value == '"' ? slashes * 2 + 1 : slashes); result.Append(value); slashes = 0;
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  static ProcessInfo Start(string[] args, IntPtr job) {
    StartupEx startup = new StartupEx(); startup.info.cb = (uint)Marshal.SizeOf(typeof(StartupEx)); startup.info.flags = 0x100;
    IntPtr process = GetCurrentProcess(), bytes = IntPtr.Zero, handles = Marshal.AllocHGlobal(IntPtr.Size * 3), jobs = Marshal.AllocHGlobal(IntPtr.Size);
    IntPtr[] std = new IntPtr[3];
    try {
      for (int i = 0; i < 3; i++) { Check(DuplicateHandle(process, GetStdHandle(-10 - i), process, out std[i], 0, true, 2)); Marshal.WriteIntPtr(handles, i * IntPtr.Size, std[i]); }
      startup.info.input = std[0]; startup.info.output = std[1]; startup.info.error = std[2];
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
      startup.attributes = Marshal.AllocHGlobal(bytes);
      Check(InitializeProcThreadAttributeList(startup.attributes, 2, 0, ref bytes));
      Check(UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
      Marshal.WriteIntPtr(jobs, job);
      // Atomic membership prevents an orphan if this helper dies during creation.
      Check(UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x2000d), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      string command = String.Join(" ", Array.ConvertAll(args, Quote));
      ProcessInfo info;
      Check(CreateProcessW(args[0], new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x200 | 4, IntPtr.Zero, Directory.GetCurrentDirectory(), ref startup, out info));
      return info;
    } finally {
      if (startup.attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(startup.attributes); Marshal.FreeHGlobal(startup.attributes); }
      for (int i = 0; i < std.Length; i++) if (std[i] != IntPtr.Zero) CloseHandle(std[i]);
      Marshal.FreeHGlobal(handles); Marshal.FreeHGlobal(jobs);
    }
  }
  static int Run(string[] args) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null), parent = OpenProcess(0x100000, false, UInt32.Parse(args[1]));
    if (job == IntPtr.Zero || parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ProcessInfo child = new ProcessInfo(); int finished = 0;
    try {
      ExtendedLimit limits = new ExtendedLimit(); limits.basic.flags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
      Check(SetConsoleCtrlHandler(IgnoreConsole, true));
      // Monitor even while pipe startup is blocked. A runtime may accidentally
      // inherit a server handle, so pipe EOF alone cannot prove parent death.
      Thread supervisor = new Thread(delegate() {
        while (Interlocked.CompareExchange(ref finished, 0, 0) == 0) {
          if (WaitForSingleObject(parent, 0) == 0) { TerminateJobObject(job, 130); Environment.Exit(130); }
          Thread.Sleep(50);
        }
      }); supervisor.IsBackground = true; supervisor.Start();
      using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", args[2], PipeDirection.InOut)) {
        pipe.Connect(15000);
        StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false));
        StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false)); writer.AutoFlush = true;
        writer.WriteLine("ready");
        if (reader.ReadLine() != "start" || WaitForSingleObject(parent, 0) == 0) return 130;
        string[] command = new string[args.Length - 3]; Array.Copy(args, 3, command, 0, command.Length);
        child = Start(command, job);
        Trace("agent created " + child.pid);
        try { Check(ResumeThread(child.thread) != 0xffffffff); }
        catch { TerminateProcess(child.process, 127); throw; }
        CloseHandle(child.thread); child.thread = IntPtr.Zero;
        int cancelled = 0; ManualResetEvent acknowledged = new ManualResetEvent(false);
        Thread control = new Thread(delegate() {
          try {
            string signal;
            while ((signal = reader.ReadLine()) != null) {
              if (signal == "ack") { acknowledged.Set(); return; }
              if ((signal == "SIGINT" || signal == "SIGTERM" || signal == "SIGHUP") && Interlocked.Exchange(ref cancelled, 1) == 0) {
                GenerateConsoleCtrlEvent(1, child.pid); Thread.Sleep(2000); TerminateJobObject(job, 130);
              }
            }
            TerminateJobObject(job, 130);
          } catch { TerminateJobObject(job, 130); }
        }); control.IsBackground = true; control.Start();
        uint exit = 0; uint lastActive = UInt32.MaxValue; bool childExited = false;
        while (true) {
          if (WaitForSingleObject(parent, 0) == 0) { TerminateJobObject(job, 130); return 130; }
          // ActiveProcesses is decremented only after an exited process loses
          // its outstanding references. Save the exit status, then close ours.
          if (!childExited && WaitForSingleObject(child.process, 0) == 0) {
            Check(GetExitCodeProcess(child.process, out exit));
            CloseHandle(child.process); child.process = IntPtr.Zero; childExited = true; Trace("agent exited");
          }
          Accounting accounting; Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
          if (accounting.active != lastActive) { lastActive = accounting.active; Trace("active processes " + lastActive); }
          if (childExited && accounting.active == 0) break;
          Thread.Sleep(30);
        }
        writer.WriteLine("done " + exit); Trace("completion sent"); acknowledged.WaitOne(5000); Trace("returning");
        return unchecked((int)exit);
      }
    } finally {
      Interlocked.Exchange(ref finished, 1);
      if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
      if (child.process != IntPtr.Zero) CloseHandle(child.process);
      CloseHandle(job); CloseHandle(parent);
    }
  }
  public static int Main(string[] args) {
    AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
    AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
    try {
      if (args.Length > 0 && args[0] == "run") return Run(args);
      Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
      if (args.Length == 1 && args[0] == "clone") {
        string[] paths = Console.In.ReadToEnd().Split('\0');
        if (paths.Length % 2 != 1 || paths[paths.Length - 1] != "") return 2;
        for (int i = 0; i < paths.Length - 1; i += 2) Clone(paths[i], paths[i + 1]);
        return 0;
      }
      if (args.Length == 1 && args[0] == "sid") { Console.WriteLine(WindowsIdentity.GetCurrent().User.Value); return 0; }
      if (args.Length == 2 && args[0] == "verify-directory") {
        DirectorySecurity acl = Directory.GetAccessControl(args[1]);
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        if (!acl.GetOwner(typeof(SecurityIdentifier)).Equals(user)) return 1;
        const FileSystemRights writes = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        // Current user, SYSTEM, and local Administrators are the only writers.
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
          string sid = rule.IdentityReference.Value;
          if (rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & writes) != 0 && sid != user.Value && sid != "S-1-5-18" && sid != "S-1-5-32-544") return 1;
        }
        return 0;
      }
      return 2;
    } catch (Exception error) {
      Win32Exception native = error as Win32Exception;
      Console.Error.WriteLine("Windows session helper failed ({0}).", native == null ? "unsupported operation" : native.NativeErrorCode.ToString());
      return 1;
    }
  }
}
`;
