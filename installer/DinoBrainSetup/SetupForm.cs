using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DinoBrainSetup;

internal sealed class SetupForm : Form
{
    private sealed record InstallTransactionSummary(
        string TransactionId,
        string Status,
        string AppRef,
        string AppCommit,
        string DataRef,
        string DataCommit,
        bool StageVerified,
        bool FullEquivalence);

    private readonly TextBox _installRootBox = new();
    private readonly TextBox _appRepoBox = new();
    private readonly TextBox _dataRepoBox = new();
    private readonly TextBox _appRefBox = new();
    private readonly TextBox _dataRefBox = new();
    private readonly TextBox _githubTokenBox = new();
    private readonly TextBox _claudeCommandBox = new();
    private readonly TextBox _logBox = new();
    private readonly Label _statusLabel = new();
    private readonly Label _checksLabel = new();
    private readonly Label _installPreviewLabel = new();
    private readonly ProgressBar _progressBar = new();
    private readonly Button _installButton = new();
    private readonly Button _cancelButton = new();
    private readonly Button _browseInstallRootButton = new();
    private readonly Button _autoInstallRootButton = new();
    private readonly Button _openFolderButton = new();
    private readonly Button _openCodexFolderButton = new();
    private readonly Button _openObservatoryButton = new();
    private readonly CheckBox _codexConfigCheck = new();
    private readonly CheckBox _codexHookCheck = new();
    private readonly CheckBox _codexRestartFlowCheck = new();
    private readonly CheckBox _claudeCodeCheck = new();
    private readonly CheckBox _verifyCheck = new();
    private readonly CheckBox _forceCheck = new();

    private Process? _installProcess;
    private string? _installedAppPath;

    public SetupForm()
    {
        Text = "DinoBrain Setup";
        MinimumSize = new Size(860, 680);
        Size = new Size(1280, 720);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        BackColor = Color.White;

        BuildUi();
        Load += (_, _) => RefreshChecks();
        FormClosing += OnFormClosing;
    }

    private void BuildUi()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            Padding = new Padding(18),
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(root);

        var title = new Label
        {
            Text = "DinoBrain Windows Installer",
            Dock = DockStyle.Top,
            AutoSize = true,
            Font = new Font(Font.FontFamily, 18F, FontStyle.Bold),
        };
        root.Controls.Add(title, 0, 0);

        var subtitle = new Label
        {
            Text = "Installs DinoBrain, configures Codex MCP/hooks, optionally registers Claude Code, and runs OS verification.",
            Dock = DockStyle.Top,
            AutoSize = true,
            ForeColor = Color.FromArgb(82, 82, 82),
            Padding = new Padding(0, 6, 0, 12),
        };
        root.Controls.Add(subtitle, 0, 1);

        var content = new SplitContainer
        {
            Dock = DockStyle.Fill,
            SplitterDistance = 360,
            FixedPanel = FixedPanel.Panel1,
        };
        root.Controls.Add(content, 0, 2);

        content.Panel1.Controls.Add(BuildOptionsPanel());
        content.Panel2.Controls.Add(BuildLogPanel());

        var footer = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            Padding = new Padding(0, 12, 0, 0),
        };
        root.Controls.Add(footer, 0, 3);

        _installButton.Text = "Install";
        _installButton.Width = 110;
        _installButton.Height = 34;
        _installButton.Click += async (_, _) => await RunInstallAsync();
        footer.Controls.Add(_installButton);

        _cancelButton.Text = "Cancel";
        _cancelButton.Width = 100;
        _cancelButton.Height = 34;
        _cancelButton.Enabled = false;
        _cancelButton.Click += (_, _) => CancelInstall();
        footer.Controls.Add(_cancelButton);

        _openObservatoryButton.Text = "Open Observatory";
        _openObservatoryButton.Width = 140;
        _openObservatoryButton.Height = 34;
        _openObservatoryButton.Enabled = false;
        _openObservatoryButton.Click += (_, _) => OpenObservatory();
        footer.Controls.Add(_openObservatoryButton);

        _openFolderButton.Text = "Open App Folder";
        _openFolderButton.Width = 130;
        _openFolderButton.Height = 34;
        _openFolderButton.Enabled = false;
        _openFolderButton.Click += (_, _) => OpenInstalledAppFolder();
        footer.Controls.Add(_openFolderButton);
    }

    private Control BuildOptionsPanel()
    {
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 28,
            Padding = new Padding(0, 0, 16, 0),
        };
        panel.RowStyles.Clear();
        for (var index = 0; index < 28; index += 1)
        {
            panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        _installRootBox.Text = GetRecommendedInstallRoot();
        _installRootBox.TextChanged += (_, _) => UpdateInstallPathPreview();
        _appRepoBox.Text = "https://github.com/clockmansy/dinobrain.git";
        _dataRepoBox.Text = "https://github.com/clockmansy/dinobrain-data.git";
        _appRefBox.Text = Program.DefaultAppRef;
        _dataRefBox.Text = Program.DefaultDataRef;
        _githubTokenBox.UseSystemPasswordChar = true;
        _claudeCommandBox.Text = "claude";
        foreach (var textBox in new[] { _appRepoBox, _dataRepoBox, _appRefBox, _dataRefBox, _githubTokenBox, _claudeCommandBox })
        {
            textBox.Dock = DockStyle.Top;
        }

        AddLabel(panel, "Install root");
        panel.Controls.Add(BuildInstallRootPicker());
        AddHint(panel, "No typing needed: use Auto for an existing install or Browse to choose a parent folder.");
        _installPreviewLabel.Dock = DockStyle.Top;
        _installPreviewLabel.AutoSize = true;
        _installPreviewLabel.ForeColor = Color.FromArgb(62, 82, 116);
        _installPreviewLabel.Padding = new Padding(0, 4, 0, 0);
        panel.Controls.Add(_installPreviewLabel);
        UpdateInstallPathPreview();

        AddLabel(panel, "App repository");
        panel.Controls.Add(_appRepoBox);
        AddLabel(panel, "Data repository");
        panel.Controls.Add(_dataRepoBox);
        AddLabel(panel, "App ref");
        panel.Controls.Add(_appRefBox);
        AddHint(panel, "App ref defaults to main so local installs track GitHub. Use a tag or commit only for deliberate rollback/recovery.");
        AddLabel(panel, "Data ref");
        panel.Controls.Add(_dataRefBox);
        AddHint(panel, "Data ref usually stays on main unless you are restoring a specific baseline.");
        AddLabel(panel, "GitHub token");
        panel.Controls.Add(_githubTokenBox);
        AddHint(panel, "Optional. Needed for private repos when Git is not installed. It is passed through the child process environment only.");

        _codexConfigCheck.Text = "Register Codex MCP";
        _codexConfigCheck.Checked = true;
        _codexHookCheck.Text = "Register Codex prompt hook";
        _codexHookCheck.Checked = true;
        _codexRestartFlowCheck.Text = "Restart Codex and open hook approval";
        _codexRestartFlowCheck.Checked = true;
        _claudeCodeCheck.Text = "Register Claude Code if available";
        _claudeCodeCheck.Checked = true;
        _verifyCheck.Text = "Run verification after install";
        _verifyCheck.Checked = true;
        _forceCheck.Text = "Repair changed repo origins";
        _forceCheck.Checked = false;

        AddSpacer(panel, 8);
        panel.Controls.Add(_codexConfigCheck);
        panel.Controls.Add(_codexHookCheck);
        panel.Controls.Add(_codexRestartFlowCheck);
        panel.Controls.Add(_claudeCodeCheck);
        panel.Controls.Add(_verifyCheck);
        panel.Controls.Add(_forceCheck);

        AddLabel(panel, "Claude command");
        panel.Controls.Add(_claudeCommandBox);

        _checksLabel.Dock = DockStyle.Top;
        _checksLabel.AutoSize = true;
        _checksLabel.Padding = new Padding(0, 12, 0, 0);
        _checksLabel.ForeColor = Color.FromArgb(70, 70, 70);
        panel.Controls.Add(_checksLabel);

        _openCodexFolderButton.Text = "Open .codex Folder";
        _openCodexFolderButton.Width = 150;
        _openCodexFolderButton.Height = 30;
        _openCodexFolderButton.Click += (_, _) => OpenCodexFolder();
        panel.Controls.Add(_openCodexFolderButton);

        return panel;
    }

    private Control BuildLogPanel()
    {
        var panel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
        };
        panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        _statusLabel.Text = "Ready";
        _statusLabel.Dock = DockStyle.Top;
        _statusLabel.AutoSize = true;
        _statusLabel.Font = new Font(Font.FontFamily, 10F, FontStyle.Bold);
        panel.Controls.Add(_statusLabel, 0, 0);

        _progressBar.Dock = DockStyle.Top;
        _progressBar.Height = 18;
        _progressBar.Style = ProgressBarStyle.Blocks;
        panel.Controls.Add(_progressBar, 0, 1);

        _logBox.Dock = DockStyle.Fill;
        _logBox.Multiline = true;
        _logBox.ReadOnly = true;
        _logBox.ScrollBars = ScrollBars.Vertical;
        _logBox.Font = new Font("Consolas", 9F, FontStyle.Regular, GraphicsUnit.Point);
        _logBox.BackColor = Color.FromArgb(18, 18, 18);
        _logBox.ForeColor = Color.FromArgb(232, 232, 232);
        _logBox.Text = "Click Install to begin.\r\n";
        panel.Controls.Add(_logBox, 0, 2);

        return panel;
    }

    private static void AddLabel(TableLayoutPanel panel, string text)
    {
        panel.Controls.Add(new Label
        {
            Text = text,
            AutoSize = true,
            Dock = DockStyle.Top,
            Padding = new Padding(0, 10, 0, 4),
            Font = new Font(panel.Font.FontFamily, 9F, FontStyle.Bold),
        });
    }

    private static void AddHint(TableLayoutPanel panel, string text)
    {
        panel.Controls.Add(new Label
        {
            Text = text,
            AutoSize = true,
            Dock = DockStyle.Top,
            ForeColor = Color.FromArgb(96, 96, 96),
        });
    }

    private static void AddSpacer(TableLayoutPanel panel, int height)
    {
        panel.Controls.Add(new Panel { Height = height, Dock = DockStyle.Top });
    }

    private Control BuildInstallRootPicker()
    {
        _installRootBox.Dock = DockStyle.Fill;

        var layout = new TableLayoutPanel
        {
            ColumnCount = 3,
            RowCount = 1,
            Dock = DockStyle.Top,
            Height = 30,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.Controls.Add(_installRootBox, 0, 0);

        _browseInstallRootButton.Text = "Browse";
        _browseInstallRootButton.Width = 82;
        _browseInstallRootButton.Dock = DockStyle.Right;
        _browseInstallRootButton.Click += BrowseInstallRoot;
        layout.Controls.Add(_browseInstallRootButton, 1, 0);

        _autoInstallRootButton.Text = "Auto";
        _autoInstallRootButton.Width = 70;
        _autoInstallRootButton.Dock = DockStyle.Right;
        _autoInstallRootButton.Click += UseRecommendedInstallRoot;
        layout.Controls.Add(_autoInstallRootButton, 2, 0);

        return layout;
    }

    private void UseRecommendedInstallRoot(object? sender, EventArgs eventArgs)
    {
        _installRootBox.Text = GetRecommendedInstallRoot();
    }

    private static string GetRecommendedInstallRoot()
    {
        foreach (var explicitPath in new[] { Environment.GetEnvironmentVariable("DINOBRAIN_INSTALL_ROOT") })
        {
            if (!string.IsNullOrWhiteSpace(explicitPath))
            {
                return NormalizeInstallRootInput(explicitPath);
            }
        }

        var configuredDataDir = Environment.GetEnvironmentVariable("DINOBRAIN_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(configuredDataDir))
        {
            return NormalizeInstallRootInput(configuredDataDir);
        }

        var codexDataDir = TryReadCodexDataDir();
        if (!string.IsNullOrWhiteSpace(codexDataDir))
        {
            return NormalizeInstallRootInput(codexDataDir);
        }

        foreach (var candidate in InstallRootCandidates())
        {
            if (LooksLikeInstallRoot(candidate))
            {
                return candidate;
            }
        }

        return DefaultDocumentsPath();
    }

    private static IEnumerable<string> InstallRootCandidates()
    {
        var documents = DefaultDocumentsPath();
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        foreach (var candidate in new[] { documents, Path.Combine(documents, "DinoBrain"), profile })
        {
            if (!string.IsNullOrWhiteSpace(candidate))
            {
                yield return NormalizeInstallRootInput(candidate);
            }
        }

        foreach (var drive in DriveInfo.GetDrives())
        {
            if (!drive.IsReady)
            {
                continue;
            }
            yield return NormalizeInstallRootInput(Path.Combine(drive.RootDirectory.FullName, "dino"));
            yield return NormalizeInstallRootInput(Path.Combine(drive.RootDirectory.FullName, "DinoBrain"));
        }
    }

    private static string DefaultDocumentsPath()
    {
        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (!string.IsNullOrWhiteSpace(documents))
        {
            return documents;
        }

        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return string.IsNullOrWhiteSpace(profile) ? Environment.CurrentDirectory : Path.Combine(profile, "Documents");
    }

    private static string? TryReadCodexDataDir()
    {
        try
        {
            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (string.IsNullOrWhiteSpace(profile))
            {
                return null;
            }

            var configPath = Path.Combine(profile, ".codex", "config.toml");
            if (!File.Exists(configPath))
            {
                return null;
            }

            var text = File.ReadAllText(configPath);
            var match = Regex.Match(text, @"DINOBRAIN_DATA_DIR\s*=\s*['""]([^'""]+)['""]", RegexOptions.IgnoreCase);
            return match.Success ? Environment.ExpandEnvironmentVariables(match.Groups[1].Value) : null;
        }
        catch
        {
            return null;
        }
    }

    private static bool LooksLikeInstallRoot(string path)
    {
        return Directory.Exists(Path.Combine(path, "dinobrain")) || Directory.Exists(Path.Combine(path, "dinobrain-data"));
    }

    private static string NormalizeInstallRootInput(string path)
    {
        var expanded = Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'));
        var fullPath = Path.GetFullPath(expanded);
        var trimmed = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var leaf = Path.GetFileName(trimmed);
        if (string.Equals(leaf, "dinobrain", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(leaf, "dinobrain-data", StringComparison.OrdinalIgnoreCase))
        {
            return Path.GetDirectoryName(trimmed) ?? fullPath;
        }
        return fullPath;
    }

    private void UpdateInstallPathPreview()
    {
        try
        {
            var text = _installRootBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(text))
            {
                _installPreviewLabel.Text = "Choose a folder. DinoBrain will create app and data folders inside it.";
                return;
            }

            var root = NormalizeInstallRootInput(text);
            var appPath = Path.Combine(root, "dinobrain");
            var dataPath = Path.Combine(root, "dinobrain-data");
            var mode = LooksLikeInstallRoot(root) ? "Existing install detected; installer will update/repair it." : "New install root; installer will create the folders.";
            var normalized = string.Equals(root, Path.GetFullPath(Environment.ExpandEnvironmentVariables(text.Trim().Trim('"'))), StringComparison.OrdinalIgnoreCase)
                ? ""
                : $"{Environment.NewLine}Selected app/data folder will be treated as root: {root}";
            _installPreviewLabel.Text = $"App: {appPath}{Environment.NewLine}Data: {dataPath}{Environment.NewLine}{mode}{normalized}";
        }
        catch (Exception ex)
        {
            _installPreviewLabel.Text = $"Path needs attention: {ex.Message}";
        }
    }

    private void BrowseInstallRoot(object? sender, EventArgs eventArgs)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose the DinoBrain install root",
            SelectedPath = Directory.Exists(_installRootBox.Text)
                ? NormalizeInstallRootInput(_installRootBox.Text)
                : GetRecommendedInstallRoot(),
            UseDescriptionForTitle = true,
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _installRootBox.Text = NormalizeInstallRootInput(dialog.SelectedPath);
        }
    }

    private void RefreshChecks()
    {
        var git = FindCommand("git");
        var powershell = FindCommand("powershell.exe") ?? FindCommand("powershell");
        var claude = FindCommand(_claudeCommandBox.Text.Trim());

        _checksLabel.Text =
            $"Prerequisites\r\n" +
            $"PowerShell: {(powershell is null ? "missing" : powershell)}\r\n" +
            $"Git: {(git is null ? "missing; fresh install uses degraded immutable archives" : git)}\r\n" +
            $"Claude Code: {(claude is null ? "optional, not found" : claude)}\r\n" +
            $"Setup EXE: {Program.SetupVersion}";
    }

    private static string? FindCommand(string command)
    {
        if (string.IsNullOrWhiteSpace(command))
        {
            return null;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "where.exe",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add(command);
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return null;
            }
            var output = process.StandardOutput.ReadLine();
            process.WaitForExit(3000);
            return process.ExitCode == 0 && !string.IsNullOrWhiteSpace(output) ? output : null;
        }
        catch
        {
            return null;
        }
    }

    private async Task RunInstallAsync()
    {
        if (_installProcess is not null)
        {
            return;
        }

        RefreshChecks();

        var installRootText = _installRootBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(installRootText))
        {
            MessageBox.Show(this, "Choose an install root first.", "DinoBrain Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var installRoot = NormalizeInstallRootInput(installRootText);
        _installRootBox.Text = installRoot;

        SetInstallingState(true);
        _logBox.Clear();
        AppendLog($"DinoBrain Setup {Program.SetupVersion}");
        AppendLog($"Install root: {installRoot}");

        var tempDir = Path.Combine(Path.GetTempPath(), "DinoBrainSetup", Guid.NewGuid().ToString("N"));
        var installScript = Path.Combine(tempDir, "install.ps1");
        Directory.CreateDirectory(tempDir);
        InstallerResources.ExtractInstallScript(installScript);

        try
        {
            var exitCode = await RunPowerShellAsync(installScript, installRoot);
            if (exitCode == 0)
            {
                var transaction = ReadInstallTransactionResult(installRoot);
                if (!string.Equals(transaction.Status, "complete", StringComparison.Ordinal))
                {
                    throw new InvalidDataException($"Installer exited successfully but transaction status was '{transaction.Status}'.");
                }
                _installedAppPath = Path.Combine(installRoot, "dinobrain");
                _statusLabel.Text = transaction.FullEquivalence ? "Install complete" : "Install complete (degraded)";
                AppendLog("");
                AppendLog("DinoBrain install complete.");
                AppendLog($"Transaction: {transaction.TransactionId}");
                AppendLog($"App ref: {transaction.AppRef} -> {transaction.AppCommit}");
                AppendLog($"Data ref: {transaction.DataRef} -> {transaction.DataCommit}");
                AppendLog($"Stage verification: {(transaction.StageVerified ? "passed" : "skipped or incomplete")}");
                AppendLog($"Full equivalence: {(transaction.FullEquivalence ? "verified" : "not proven")}");
                AppendLog("Codex hook handshake was verified during install.");
                AppendLog("The Codex hook approval flow was launched if hook registration was enabled.");
                AppendLog("Codex trust still requires a user click in /hooks.");
                _openFolderButton.Enabled = Directory.Exists(_installedAppPath);
                _openObservatoryButton.Enabled = Directory.Exists(_installedAppPath);
            }
            else
            {
                _statusLabel.Text = "Install failed";
                AppendLog("");
                AppendLog($"Install failed with exit code {exitCode}.");
            }
        }
        catch (Exception ex)
        {
            _statusLabel.Text = "Install failed";
            AppendLog("");
            AppendLog(ex.ToString());
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // The temp folder is disposable; keeping it is safer than interrupting the UI close path.
            }
            SetInstallingState(false);
        }
    }

    private static InstallTransactionSummary ReadInstallTransactionResult(string installRoot)
    {
        var resultPath = Path.Combine(installRoot, "dinobrain-install-result.json");
        if (!File.Exists(resultPath))
        {
            throw new InvalidDataException($"Installer transaction result was not created: {resultPath}");
        }

        using var document = JsonDocument.Parse(File.ReadAllText(resultPath));
        var root = document.RootElement;
        var app = root.GetProperty("app");
        var data = root.GetProperty("data");
        var transaction = new InstallTransactionSummary(
            root.GetProperty("transaction_id").GetString() ?? string.Empty,
            root.GetProperty("status").GetString() ?? string.Empty,
            app.GetProperty("requested_ref").GetString() ?? string.Empty,
            app.GetProperty("resolved_commit").GetString() ?? string.Empty,
            data.GetProperty("requested_ref").GetString() ?? string.Empty,
            data.GetProperty("resolved_commit").GetString() ?? string.Empty,
            root.GetProperty("stage_verified").GetBoolean(),
            root.GetProperty("full_equivalence").GetBoolean());

        if (string.IsNullOrWhiteSpace(transaction.TransactionId) ||
            !Regex.IsMatch(transaction.AppCommit, "^[0-9a-f]{40}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ||
            !Regex.IsMatch(transaction.DataCommit, "^[0-9a-f]{40}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
        {
            throw new InvalidDataException("Installer transaction result is missing immutable app/data commit evidence.");
        }
        return transaction;
    }

    private Task<int> RunPowerShellAsync(string installScript, string installRoot)
    {
        var completion = new TaskCompletionSource<int>();
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(installScript) ?? Environment.CurrentDirectory,
        };
        var githubToken = _githubTokenBox.Text.Trim();
        if (!string.IsNullOrWhiteSpace(githubToken))
        {
            startInfo.Environment["DINOBRAIN_GITHUB_TOKEN"] = githubToken;
        }

        foreach (var argument in BuildInstallArguments(installScript, installRoot))
        {
            startInfo.ArgumentList.Add(argument);
        }

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };
        process.OutputDataReceived += (_, eventArgs) => AppendLog(eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => AppendLog(eventArgs.Data);
        process.Exited += (_, _) =>
        {
            var exitCode = process.ExitCode;
            process.Dispose();
            _installProcess = null;
            completion.TrySetResult(exitCode);
        };

        _installProcess = process;
        _statusLabel.Text = "Installing";
        AppendLog("Starting install.ps1...");
        AppendLog("");
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return completion.Task;
    }

    private IEnumerable<string> BuildInstallArguments(string installScript, string installRoot)
    {
        yield return "-NoProfile";
        yield return "-ExecutionPolicy";
        yield return "Bypass";
        yield return "-File";
        yield return installScript;
        yield return "-InstallRoot";
        yield return installRoot;
        yield return "-AppRepo";
        yield return _appRepoBox.Text.Trim();
        yield return "-DataRepo";
        yield return _dataRepoBox.Text.Trim();
        yield return "-AppRef";
        yield return string.IsNullOrWhiteSpace(_appRefBox.Text) ? "main" : _appRefBox.Text.Trim();
        yield return "-DataRef";
        yield return string.IsNullOrWhiteSpace(_dataRefBox.Text) ? "main" : _dataRefBox.Text.Trim();
        yield return "-ClaudeCommand";
        yield return string.IsNullOrWhiteSpace(_claudeCommandBox.Text) ? "claude" : _claudeCommandBox.Text.Trim();

        if (!_codexConfigCheck.Checked)
        {
            yield return "-SkipCodexConfig";
        }
        if (!_codexHookCheck.Checked)
        {
            yield return "-SkipCodexHookConfig";
        }
        if (!_codexRestartFlowCheck.Checked)
        {
            yield return "-SkipCodexRestartFlow";
        }
        if (!_claudeCodeCheck.Checked)
        {
            yield return "-SkipClaudeCodeConfig";
        }
        if (!_verifyCheck.Checked)
        {
            yield return "-SkipVerify";
        }
        if (_forceCheck.Checked)
        {
            yield return "-Force";
        }
    }

    private void CancelInstall()
    {
        try
        {
            _installProcess?.Kill(entireProcessTree: true);
            AppendLog("Install canceled.");
        }
        catch (Exception ex)
        {
            AppendLog($"Cancel failed: {ex.Message}");
        }
    }

    private void SetInstallingState(bool installing)
    {
        _installButton.Enabled = !installing;
        _cancelButton.Enabled = installing;
        _progressBar.Style = installing ? ProgressBarStyle.Marquee : ProgressBarStyle.Blocks;
        _progressBar.MarqueeAnimationSpeed = installing ? 30 : 0;

        foreach (var control in new Control[] { _installRootBox, _browseInstallRootButton, _autoInstallRootButton, _appRepoBox, _dataRepoBox, _appRefBox, _dataRefBox, _githubTokenBox, _claudeCommandBox, _codexConfigCheck, _codexHookCheck, _codexRestartFlowCheck, _claudeCodeCheck, _verifyCheck, _forceCheck })
        {
            control.Enabled = !installing;
        }
    }

    private void AppendLog(string? line)
    {
        if (line is null)
        {
            return;
        }

        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => AppendLog(line)));
            return;
        }

        _logBox.AppendText(line + Environment.NewLine);
    }

    private void OpenInstalledAppFolder()
    {
        if (!string.IsNullOrWhiteSpace(_installedAppPath) && Directory.Exists(_installedAppPath))
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = _installedAppPath,
                UseShellExecute = true,
            });
        }
    }

    private static void OpenCodexFolder()
    {
        var codexFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        Directory.CreateDirectory(codexFolder);
        Process.Start(new ProcessStartInfo
        {
            FileName = codexFolder,
            UseShellExecute = true,
        });
    }

    private void OpenObservatory()
    {
        if (string.IsNullOrWhiteSpace(_installedAppPath) || !Directory.Exists(_installedAppPath))
        {
            return;
        }

        var launcher = Path.Combine(_installedAppPath, "DinoBrain Observatory.cmd");
        if (File.Exists(launcher))
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = launcher,
                UseShellExecute = true,
            });
            return;
        }

        var command = "$toolsDir = Join-Path $env:LOCALAPPDATA 'DinoBrain\\tools'; " +
                      "$nodeDir = Get-ChildItem -LiteralPath $toolsDir -Directory -Filter 'node-v*-win-x64' | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName; " +
                      "if (-not $nodeDir) { throw 'Portable Node was not found.' }; " +
                      "$env:PATH = \"$nodeDir;$env:PATH\"; " +
                      $"Set-Location -LiteralPath '{_installedAppPath.Replace("'", "''")}'; " +
                      "npm run observatory";
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = true,
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-NoExit");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add(command);
        Process.Start(startInfo);
        Process.Start(new ProcessStartInfo
        {
            FileName = "http://127.0.0.1:3847/",
            UseShellExecute = true,
        });
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (_installProcess is null || _installProcess.HasExited)
        {
            return;
        }

        var answer = MessageBox.Show(
            this,
            "An install is still running. Cancel it and close?",
            "DinoBrain Setup",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning);
        if (answer != DialogResult.Yes)
        {
            eventArgs.Cancel = true;
            return;
        }

        CancelInstall();
    }
}
