using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace DinoBrainObservatoryLauncher;

internal enum LauncherMode { Open, EnsureRunning, Stop, Status, EnableStartup, DisableStartup }

internal sealed record Options(LauncherMode Mode, bool ExplicitOpen, string? AppRoot, string? DataDir, int Port, int TimeoutSeconds);

internal static class Program
{
    private const string ObservatoryScript = "scripts\\dinobrain-observatory.mjs";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(1) };

    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        var options = Parse(args);
        var logger = new LauncherLog();
        try
        {
            var appRoot = DiscoverAppRoot(options.AppRoot);
            if (options.Mode == LauncherMode.DisableStartup)
                return ConfigureStartup(appRoot, null, disable: true, logger) ? 0 : 1;
            if (options.Mode == LauncherMode.EnableStartup)
            {
                var startupDataDir = DiscoverDataDir(options.DataDir, appRoot);
                return ConfigureStartup(appRoot, startupDataDir, disable: false, logger) ? 0 : 1;
            }
            var dataDir = DiscoverDataDir(options.DataDir, appRoot);
            var url = $"http://127.0.0.1:{options.Port}/";
            logger.Write($"mode={options.Mode}; app={appRoot}; data={dataDir}; port={options.Port}");

            if (options.Mode == LauncherMode.Status)
                return await ReportStatusAsync(url, dataDir, logger) ? 0 : 2;
            if (options.Mode == LauncherMode.Stop)
                return await StopAsync(options.Port, url, logger) ? 0 : 2;

            using var startGate = new Semaphore(1, 1, $"Local\\DinoBrainObservatoryLauncher-{Environment.UserName}");
            if (!startGate.WaitOne(TimeSpan.FromSeconds(2)))
            {
                logger.Write("ensure skipped: another launcher is already starting the Observatory");
                return 0; // Fail open: a prompt hook must never wait indefinitely.
            }
            try
            {
                var wasRunning = await IsHealthyAsync(url, dataDir, logger);
                if (!wasRunning)
                {
                    using var hostProcess = StartServer(appRoot, dataDir, options.Port, logger);
                    if (!await WaitForHealthAsync(url, dataDir, TimeSpan.FromSeconds(options.TimeoutSeconds), logger))
                    {
                        StopProcessTree(hostProcess, logger);
                        throw new InvalidOperationException($"Observatory did not become healthy within {options.TimeoutSeconds}s. See {logger.Path}.");
                    }
                }

                if (options.Mode == LauncherMode.Open && logger.TryClaimBrowserOpen(TimeSpan.FromSeconds(3)))
                    Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                logger.Write(wasRunning ? "Observatory already running" : "Observatory started");
                return 0;
            }
            finally { startGate.Release(); }
        }
        catch (Exception ex)
        {
            logger.Write($"ERROR {ex.Message}");
            if (options.Mode == LauncherMode.Open)
                System.Windows.Forms.MessageBox.Show($"DinoBrain Observatory could not start.\n\n{ex.Message}\n\nDiagnostic log:\n{logger.Path}", "DinoBrain Observatory", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Error);
            return 1;
        }
    }

    private static Options Parse(string[] args)
    {
        var explicitOpen = args.Any(a => a.Equals("--open", StringComparison.OrdinalIgnoreCase));
        var mode = args.Any(a => a.Equals("--disable-startup", StringComparison.OrdinalIgnoreCase)) ? LauncherMode.DisableStartup :
                   args.Any(a => a.Equals("--enable-startup", StringComparison.OrdinalIgnoreCase)) ? LauncherMode.EnableStartup :
                   args.Any(a => a.Equals("--stop", StringComparison.OrdinalIgnoreCase)) ? LauncherMode.Stop :
                   args.Any(a => a.Equals("--status", StringComparison.OrdinalIgnoreCase)) ? LauncherMode.Status :
                   args.Any(a => a.Equals("--ensure-running", StringComparison.OrdinalIgnoreCase)) ? LauncherMode.EnsureRunning : LauncherMode.Open;
        string? Value(string name) { var i = Array.FindIndex(args, a => a.Equals(name, StringComparison.OrdinalIgnoreCase)); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        var port = int.TryParse(Value("--port"), out var parsedPort) && parsedPort is > 0 and < 65536 ? parsedPort : 3847;
        var timeout = int.TryParse(Value("--timeout-seconds"), out var parsedTimeout) ? Math.Clamp(parsedTimeout, 1, 10) : 5;
        return new Options(mode, explicitOpen, Value("--app-root"), Value("--data-dir"), port, timeout);
    }

    private static bool ConfigureStartup(string appRoot, string? dataDir, bool disable, LauncherLog logger)
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            if (key is null) return false;
            if (disable)
            {
                key.DeleteValue("DinoBrain Observatory", throwOnMissingValue: false);
                logger.Write("sign-in startup disabled");
            }
            else
            {
                key.SetValue(
                    "DinoBrain Observatory",
                    $"\"{Path.Combine(appRoot, "DinoBrain Observatory.exe")}\" --ensure-running --timeout-seconds 2 --app-root \"{appRoot}\" --data-dir \"{dataDir}\"",
                    Microsoft.Win32.RegistryValueKind.String);
                logger.Write("sign-in startup enabled");
            }
            return true;
        }
        catch (Exception ex) { logger.Write($"startup setting failed: {ex.Message}"); return false; }
    }

    private static string DiscoverAppRoot(string? configured)
    {
        var candidates = new List<string?> { configured, Environment.GetEnvironmentVariable("DINOBRAIN_APP_DIR"), AppContext.BaseDirectory, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "dinobrain") };
        foreach (var candidate in candidates.Where(c => !string.IsNullOrWhiteSpace(c)))
        {
            var full = Path.GetFullPath(candidate!);
            if (File.Exists(Path.Combine(full, ObservatoryScript))) return full;
        }
        throw new DirectoryNotFoundException("DinoBrain app root was not found. Run DinoBrainSetup.exe or pass --app-root.");
    }

    private static string DiscoverDataDir(string? configured, string appRoot)
    {
        var candidates = new[] { configured, Environment.GetEnvironmentVariable("DINOBRAIN_DATA_DIR"), Path.Combine(Directory.GetParent(appRoot)?.FullName ?? appRoot, "dinobrain-data") };
        foreach (var candidate in candidates.Where(c => !string.IsNullOrWhiteSpace(c)))
        {
            var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(candidate!));
            if (Directory.Exists(full)) return full;
        }
        throw new DirectoryNotFoundException("DinoBrain data root was not found. Pass --data-dir or reinstall DinoBrain.");
    }

    private static string DiscoverNode()
    {
        var tools = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DinoBrain", "tools");
        var node = Directory.Exists(tools) ? Directory.GetDirectories(tools, "node-v*-win-x64").OrderByDescending(p => p).Select(p => Path.Combine(p, "node.exe")).FirstOrDefault(File.Exists) : null;
        return node ?? throw new FileNotFoundException("Portable Node was not found. Run DinoBrainSetup.exe first.");
    }

    private static Process StartServer(string appRoot, string dataDir, int port, LauncherLog logger)
    {
        var script = Path.Combine(appRoot, "scripts", "start-dinobrain-observatory.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("Observatory startup script was not found.", script);
        var info = new ProcessStartInfo { FileName = "powershell.exe", UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = appRoot };
        info.ArgumentList.Add("-NoProfile"); info.ArgumentList.Add("-ExecutionPolicy"); info.ArgumentList.Add("Bypass"); info.ArgumentList.Add("-File"); info.ArgumentList.Add(script);
        info.ArgumentList.Add("-DataDir"); info.ArgumentList.Add(dataDir); info.ArgumentList.Add("-NodeRoot"); info.ArgumentList.Add(Path.GetDirectoryName(DiscoverNode())!);
        info.ArgumentList.Add("-Port"); info.ArgumentList.Add(port.ToString()); info.ArgumentList.Add("-NoBrowser");
        var process = Process.Start(info) ?? throw new InvalidOperationException("PowerShell did not start the Observatory server.");
        logger.Write($"started background host pid={process.Id}");
        return process;
    }

    private static void StopProcessTree(Process process, LauncherLog logger)
    {
        try
        {
            if (process.HasExited) return;
            process.Kill(entireProcessTree: true);
            if (!process.WaitForExit(2000)) logger.Write($"startup cleanup timed out for pid={process.Id}");
            else logger.Write($"startup cleanup completed for pid={process.Id}");
        }
        catch (Exception ex) { logger.Write($"startup cleanup failed for pid={process.Id}: {ex.Message}"); }
    }

    private static async Task<bool> IsHealthyAsync(string url, string dataDir, LauncherLog logger)
    {
        try
        {
            using var response = await Http.GetAsync(url + "api/health");
            if (!response.IsSuccessStatusCode) return false;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var actual = document.RootElement.TryGetProperty("data_root", out var root) ? root.GetString() : null;
            return document.RootElement.TryGetProperty("ok", out var ok) && ok.GetBoolean() && !string.IsNullOrWhiteSpace(actual) && Path.GetFullPath(actual!).Equals(Path.GetFullPath(dataDir), StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) { logger.Write($"health unavailable: {ex.Message}"); return false; }
    }

    private static async Task<bool> WaitForHealthAsync(string url, string dataDir, TimeSpan timeout, LauncherLog logger)
    {
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            if (await IsHealthyAsync(url, dataDir, logger)) return true;
            await Task.Delay(150);
        }
        return false;
    }

    private static async Task<bool> ReportStatusAsync(string url, string dataDir, LauncherLog logger)
    {
        var running = await IsHealthyAsync(url, dataDir, logger);
        logger.Write(running ? "status=running" : "status=stopped");
        Console.WriteLine(running ? "running" : "stopped");
        return running;
    }

    private static async Task<bool> StopAsync(int port, string url, LauncherLog logger)
    {
        if (!await IsObservatoryAsync(url)) { logger.Write("stop refused: no DinoBrain Observatory health endpoint"); Console.WriteLine("stopped"); return true; }
        using var netstat = Process.Start(new ProcessStartInfo { FileName = "netstat.exe", Arguments = "-ano -p tcp", UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true });
        var output = netstat is null ? string.Empty : await netstat.StandardOutput.ReadToEndAsync();
        netstat?.WaitForExit(1000);
        var fields = output.Split('\n')
            .Select(line => line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            .FirstOrDefault(parts => parts.Length >= 5 && parts[0].Equals("TCP", StringComparison.OrdinalIgnoreCase) && HasExactPort(parts[1], port) && parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase));
        var pid = fields?.LastOrDefault();
        if (!int.TryParse(pid, out var id)) { logger.Write("stop failed: listener PID not found"); return false; }
        try
        {
            var processName = Process.GetProcessById(id).ProcessName;
            if (!processName.Contains("node", StringComparison.OrdinalIgnoreCase) && !processName.Contains("powershell", StringComparison.OrdinalIgnoreCase))
            {
                logger.Write($"stop refused: listener process is '{processName}', not an expected Observatory host");
                return false;
            }
        }
        catch (Exception ex) { logger.Write($"stop refused: could not inspect listener process: {ex.Message}"); return false; }
        using var kill = Process.Start(new ProcessStartInfo { FileName = "taskkill.exe", Arguments = $"/PID {id} /T /F", UseShellExecute = false, CreateNoWindow = true });
        kill?.WaitForExit(2000);
        logger.Write($"stop requested pid={id}");
        Console.WriteLine(kill?.ExitCode == 0 ? "stopped" : "stop-failed");
        return kill?.ExitCode == 0;
    }

    private static async Task<bool> IsObservatoryAsync(string url)
    {
        try
        {
            using var response = await Http.GetAsync(url + "api/health");
            if (!response.IsSuccessStatusCode) return false;
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            return document.RootElement.TryGetProperty("ok", out var ok) && ok.GetBoolean() && document.RootElement.TryGetProperty("observatory_version", out _);
        }
        catch { return false; }
    }

    private static bool HasExactPort(string localEndpoint, int port)
    {
        var separator = localEndpoint.LastIndexOf(':');
        return separator >= 0 && int.TryParse(localEndpoint[(separator + 1)..], out var actualPort) && actualPort == port;
    }
}

internal sealed class LauncherLog
{
    internal string Path { get; }
    private readonly string _lastOpenPath;
    internal LauncherLog()
    {
        var directory = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DinoBrain", "logs");
        try { Directory.CreateDirectory(directory); }
        catch { directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "DinoBrain", "logs"); Directory.CreateDirectory(directory); }
        Path = System.IO.Path.Combine(directory, "observatory-launcher.log");
        _lastOpenPath = System.IO.Path.Combine(directory, "observatory-last-open.txt");
    }
    internal void Write(string message)
    {
        try { File.AppendAllText(Path, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}"); var file = new FileInfo(Path); if (file.Length > 262144) File.WriteAllText(Path, File.ReadAllText(Path)[^131072..]); } catch { }
    }
    internal bool TryClaimBrowserOpen(TimeSpan debounce)
    {
        try
        {
            using var file = new FileStream(_lastOpenPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            using var reader = new StreamReader(file, leaveOpen: true);
            var prior = reader.ReadToEnd();
            if (DateTimeOffset.TryParse(prior, out var lastOpen) && DateTimeOffset.UtcNow - lastOpen < debounce)
            {
                Write("browser open skipped by debounce");
                return false;
            }
            file.SetLength(0);
            using var writer = new StreamWriter(file, leaveOpen: true);
            writer.Write(DateTimeOffset.UtcNow.ToString("O"));
            writer.Flush();
            return true;
        }
        catch (Exception ex) { Write($"browser debounce unavailable: {ex.Message}"); return false; }
    }
}
