using System.ComponentModel;
using System.Diagnostics;

try
{
    switch (args)
    {
        case ["--fake"]:
            FakeGame.Replay(new EventStream(Console.Out));
            return 0;
        case ["--self-test"]:
            FakeGame.Test();
            return 0;
        case ["--check-build", var path]:
            var (hash, profile) = GameReader.FindProfile(path);
            Console.WriteLine($"Supported build: {hash} ({Path.GetFileName(profile)})");
            return 0;
        case ["--help"]:
            Console.WriteLine("Dea.Capture [--fake | --self-test | --check-build <GameAssembly.dll>]");
            return 0;
        case [] when OperatingSystem.IsWindows():
            await RunCapture();
            return 0;
        default:
            Console.Error.WriteLine("Run with --help for usage. Live capture requires Windows.");
            return 2;
    }
}
catch (Exception error) when (error is IOException or NotSupportedException or UnauthorizedAccessException
    or InvalidOperationException)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static async Task RunCapture()
{
    using var stop = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        stop.Cancel();
    };
    var stream = new EventStream(Console.Out);
    string? lastDiagnostic = null;
    var waiting = Stopwatch.StartNew();

    try
    {
        while (!stop.IsCancellationRequested)
        {
            var candidates = Process.GetProcessesByName("Among Us");
            try
            {
                if (candidates.Length != 1)
                {
                    Diagnose(candidates.Length == 0 ? "Waiting for Among Us." : "Close extra Among Us instances.");
                }
                else
                {
                    using var reader = new GameReader(candidates[0]);
                    lastDiagnostic = null;
                    waiting.Restart();
                    while (!candidates[0].HasExited && !stop.IsCancellationRequested)
                    {
                        try
                        {
                            stream.Send(reader.Read());
                            lastDiagnostic = null;
                            waiting.Restart();
                        }
                        catch (IOException error)
                        {
                            Diagnose(error.Message);
                            if (waiting.Elapsed >= TimeSpan.FromSeconds(3))
                                stream.Lost();
                        }
                        await Task.Delay(250, stop.Token);
                    }
                }
            }
            catch (Exception error) when (error is Win32Exception or IOException or NotSupportedException or InvalidOperationException)
            {
                Diagnose(error.Message);
            }
            finally
            {
                foreach (var candidate in candidates)
                    candidate.Dispose();
                stream.Lost();
            }
            await Task.Delay(1000, stop.Token);
        }
    }
    catch (OperationCanceledException) when (stop.IsCancellationRequested)
    {
    }

    void Diagnose(string message)
    {
        if (lastDiagnostic == message)
            return;
        lastDiagnostic = message;
        Console.Error.WriteLine(message);
    }
}
