using System.Reflection;

namespace DinoBrainSetup;

internal static class Program
{
    internal const string SetupVersion = "0.1.0";

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

        return false;
    }
}

internal static class InstallerResources
{
    internal static void ExtractInstallScript(string destinationPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(destinationPath));
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        using var stream = OpenInstallScript();
        using var file = File.Create(destinationPath);
        stream.CopyTo(file);
    }

    private static Stream OpenInstallScript()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly
            .GetManifestResourceNames()
            .FirstOrDefault(name => string.Equals(name, "install.ps1", StringComparison.OrdinalIgnoreCase));
        if (resourceName is null)
        {
            throw new InvalidOperationException("Embedded install.ps1 was not found.");
        }

        return assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException("Embedded install.ps1 could not be opened.");
    }
}
