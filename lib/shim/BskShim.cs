using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

// BskShim: put this in front of bsk.exe so a dsh plugin can rely on the daemon
// being up without being able to start it.
//
// Why this exists
// ---------------
// On Windows the dsh host runs inside a Job Object that forbids detached child
// processes, so `bsk daemon start` from a plugin fails with "拒绝访问 (os error 5)".
// A scheduled task CAN break away, but a plugin has no way to keep a foreground
// task alive. So: the daemon lives in an on-demand scheduled task, and this
// shim is what the plugin actually invokes. If the daemon is down, the shim
// triggers the task, waits for it to answer, then forwards the call.
//
// Contract
// --------
// * Arguments are forwarded verbatim (MSVC quoting rules, no ArgumentList in
//   .NET Framework 4.x).
// * stdout/stderr are copied byte-for-byte. Decoding through the platform
//   default codec (GBK on a Chinese Windows) corrupts UTF-8 output; never do it.
// * stdin is piped through so BSK_CANCEL_ON_STDIN_CLOSE keeps working.
// * Environment overrides use Environment.SetEnvironmentVariable(Process),
//   never psi.EnvironmentVariables: the latter snapshots the whole parent
//   environment into a case-insensitive dictionary and throws when the host
//   carries both NO_PROXY and no_proxy.
//
// Build: csc -nologo -target:exe -out:bsk-shim.exe BskShim.cs
internal static class BskShim
{
    // Both are substituted at build time by build-shim.mjs. Verbatim strings:
    // the substituted value is a Windows path whose backslashes must stay
    // literal, and a regular C# string would read them as escape sequences.
    const string RealBsk = @"@@BSK_PATH@@";
    const string TaskName = @"@@TASK_NAME@@";

    static readonly TimeSpan WakeTimeout = TimeSpan.FromSeconds(30);

    static void Dbg(string m)
    {
        if (Environment.GetEnvironmentVariable("BSK_SHIM_DEBUG") != "1") return;
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "bsk-shim.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + m + Environment.NewLine);
        }
        catch { }
    }

    static int Main(string[] args)
    {
        Dbg("main args=" + args.Length + " [" + string.Join(" ", args) + "]");

        // Process scope, not psi.EnvironmentVariables: see the header note.
        Environment.SetEnvironmentVariable("BSK_AUTO_START", "0", EnvironmentVariableTarget.Process);

        if (DaemonUp())
        {
            Dbg("daemon already up");
            return RunReal(args);
        }

        Dbg("daemon down, waking task " + TaskName);
        if (!WakeDaemon())
        {
            Console.Error.WriteLine("bsk-shim: could not start the bsk daemon (task \"" + TaskName + "\").");
            Console.Error.WriteLine("bsk-shim: run `schtasks /query /tn " + TaskName + "` to check the task,");
            Console.Error.WriteLine("bsk-shim: or start the daemon yourself with `bsk daemon start --foreground`.");
            return 3;
        }

        var deadline = DateTime.UtcNow + WakeTimeout;
        while (DateTime.UtcNow < deadline)
        {
            if (DaemonUp())
            {
                Dbg("daemon became ready");
                return RunReal(args);
            }
            Thread.Sleep(250);
        }

        Dbg("daemon never became ready");
        Console.Error.WriteLine("bsk-shim: the bsk daemon did not become ready within "
            + (int)WakeTimeout.TotalSeconds + "s.");
        return 4;
    }

    // Exit 0 means the daemon answered.
    static bool DaemonUp()
    {
        try
        {
            var psi = new ProcessStartInfo(RealBsk, "status --json")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
            };
            using (var p = Process.Start(psi))
            {
                p.StandardInput.Close();
                p.StandardOutput.ReadToEnd();
                p.StandardError.ReadToEnd();
                if (!p.WaitForExit(10000))
                {
                    Dbg("status did not exit in 10s");
                    try { p.Kill(); } catch { }
                    return false;
                }
                Dbg("status exit=" + p.ExitCode);
                return p.ExitCode == 0;
            }
        }
        catch (Exception e)
        {
            Dbg("status threw: " + e.Message);
            return false;
        }
    }

    static bool WakeDaemon()
    {
        try
        {
            var psi = new ProcessStartInfo("schtasks.exe", "/run /tn \"" + TaskName + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var p = Process.Start(psi))
            {
                var o = p.StandardOutput.ReadToEnd();
                var e = p.StandardError.ReadToEnd();
                if (!p.WaitForExit(10000))
                {
                    try { p.Kill(); } catch { }
                    Dbg("schtasks timeout");
                    return false;
                }
                Dbg("schtasks exit=" + p.ExitCode + " out=" + o.Trim() + " err=" + e.Trim());
                return p.ExitCode == 0;
            }
        }
        catch (Exception e)
        {
            Dbg("schtasks threw: " + e.Message);
            return false;
        }
    }

    // .NET Framework 4.x has no ProcessStartInfo.ArgumentList, so quote the
    // way the MSVC runtime expects.
    static string QuoteArgs(string[] args)
    {
        var sb = new StringBuilder();
        foreach (var a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(QuoteOne(a));
        }
        return sb.ToString();
    }

    static string QuoteOne(string a)
    {
        bool needQuote = a.Length == 0;
        foreach (char c in a)
        {
            if (c == (char)32 || c == (char)9 || c == (char)10 || c == (char)11 || c == (char)34)
            {
                needQuote = true;
                break;
            }
        }
        if (!needQuote) return a;

        var sb = new StringBuilder();
        sb.Append((char)34);
        int i = 0;
        while (i < a.Length)
        {
            int backslashes = 0;
            while (i < a.Length && a[i] == (char)92) { backslashes++; i++; }
            if (i == a.Length)
            {
                sb.Append((char)92, backslashes * 2);
                break;
            }
            if (a[i] == (char)34)
            {
                sb.Append((char)92, backslashes * 2 + 1);
                sb.Append((char)34);
            }
            else
            {
                sb.Append((char)92, backslashes);
                sb.Append(a[i]);
            }
            i++;
        }
        sb.Append((char)34);
        return sb.ToString();
    }

    static int RunReal(string[] args)
    {
        var psi = new ProcessStartInfo(RealBsk)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };
        psi.Arguments = QuoteArgs(args);

        using (var p = Process.Start(psi))
        {
            // Byte-exact: never decode, or CJK output is mangled.
            var outT = Pump(p.StandardOutput.BaseStream, Console.OpenStandardOutput());
            var errT = Pump(p.StandardError.BaseStream, Console.OpenStandardError());
            var inT = PumpIn(Console.OpenStandardInput(), p.StandardInput);

            p.WaitForExit();
            outT.Join(2000);
            errT.Join(2000);
            inT.Join(2000);
            Dbg("child exit=" + p.ExitCode);
            return p.ExitCode;
        }
    }

    static Thread Pump(Stream from, Stream to)
    {
        var t = new Thread(() =>
        {
            try
            {
                var buf = new byte[8192];
                int n;
                while ((n = from.Read(buf, 0, buf.Length)) > 0)
                {
                    to.Write(buf, 0, n);
                    to.Flush();
                }
            }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
        return t;
    }

    static Thread PumpIn(Stream from, StreamWriter to)
    {
        var t = new Thread(() =>
        {
            try
            {
                var buf = new byte[8192];
                int n;
                while ((n = from.Read(buf, 0, buf.Length)) > 0)
                {
                    to.BaseStream.Write(buf, 0, n);
                    to.BaseStream.Flush();
                }
            }
            catch { }
            finally
            {
                // EOF on our stdin means the caller closed it; propagate so the
                // child sees the same signal (BSK_CANCEL_ON_STDIN_CLOSE).
                try { to.Close(); } catch { }
            }
        });
        t.IsBackground = true;
        t.Start();
        return t;
    }
}
