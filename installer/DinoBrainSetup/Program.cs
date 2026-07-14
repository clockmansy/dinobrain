using System.Reflection;

namespace DinoBrainSetup;

internal static class Program
{
    internal static string SetupVersion => AssemblyMetadata("SetupVersion", "2.0.1");
    internal static string DefaultAppRef => AssemblyMetadata("InstallerAppRef", "main");
    internal static string DefaultDataRef => AssemblyMetadata("InstallerDataRef", "main");

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (TryHandleCommandLine(args))
            {
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                ex.Message,
                "DinoBrain Setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static bool TryHandleCommandLine(string[] args)
    {
        if (args.Length == 0)
        {
            return false;
        }

        if (args.Contains("--version", StringComparer.OrdinalIgnoreCase))
        {
            return true;
        }

        var extractIndex = Array.FindIndex(args, arg => string.Equals(arg, "--extract-install-script", StringComparison.OrdinalIgnoreCase));
        if (extractIndex >= 0)
        {
            if (extractIndex + 1 >= args.Length)
            {
                throw new InvalidOperationException("--extract-install-script requires an output path.");
            }

            InstallerResources.ExtractInstallScript(args[extractIndex + 1]);
            return true;
        }

        var launcherIndex = Array.FindIndex(args, arg => string.Equals(arg, "--extract-observatory-launcher", StringComparison.OrdinalIgnoreCase));
        if (launcherIndex >= 0)
        {
            if (launcherIndex + 1 >= args.Length)
                throw new InvalidOperationException("--extract-observatory-launcher requires an output path.");
            InstallerResources.ExtractObservatoryLauncher(args[launcherIndex + 1]);
            return true;
        }

        return false;
    }

    private static string AssemblyMetadata(string key, string fallback)
    {
        return Assembly
            .GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => string.Equals(attribute.Key, key, StringComparison.OrdinalIgnoreCase))
            ?.Value ?? fallback;
    }
}

internal static class InstallerResources
{
    internal static void ExtractObservatoryLauncher(string destinationPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(destinationPath));
        if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
        using var stream = OpenResource("observatory-launcher.exe");
        using var file = File.Create(destinationPath);
        stream.CopyTo(file);
    }

    internal static void ExtractInstallScript(string destinationPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(destinationPath));
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        using var stream = OpenResource("install.ps1");
        using var file = File.Create(destinationPath);
        stream.CopyTo(file);
    }

    private static Stream OpenResource(string expectedName)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly
            .GetManifestResourceNames()
            .FirstOrDefault(name => string.Equals(name, expectedName, StringComparison.OrdinalIgnoreCase));
        if (resourceName is null)
        {
            throw new InvalidOperationException($"Embedded {expectedName} was not found.");
        }

        return assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded {expectedName} could not be opened.");
    }
}
