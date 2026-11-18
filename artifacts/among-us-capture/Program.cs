using System.ComponentModel;
using System.Diagnostics;

try
{
    switch (args)
    {
        case ["--fake"]:
            await FakeGame.ReplayAsync(new EventStream(Console.Out));
            return 0;
        case ["--self-test"]:
            FakeGame.Test();
            await ConnectionTest.RunAsync();
            return 0;
        case ["--check-build", var path]:
            var (hash, profile) = GameReader.FindProfile(path);
            Console.WriteLine($"Supported build: {hash} ({Path.GetFileName(profile)})");
            return 0;
        case ["--help"]:
            Console.WriteLine("Dea.Capture [--fake | --self-test | --check-build <GameAssembly.dll> | [--fake] --connect <HTTPS origin>]");
            return 0;
        case ["--fake", "--connect", var fakeOrigin]:
            await RunConnected(fakeOrigin, fake: true);
            return 0;
        case ["--connect", var origin] when OperatingSystem.IsWindows():
            await RunConnected(origin, fake: false);
            return 0;
        case [] when OperatingSystem.IsWindows():
            using (var stop = ConsoleStop())
                await RunCapture(new EventStream(Console.Out), stop.Token);
            return 0;
        default:
            Console.Error.WriteLine("Run with --help for usage. Live capture requires Windows.");
            return 2;
    }
}
catch (OperationCanceledException)
{
    return 0;
}
catch (Exception error) when (error is IOException or NotSupportedException or UnauthorizedAccessException
    or InvalidOperationException or ArgumentException or HttpRequestException)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static CancellationTokenSource ConsoleStop()
{
    var stop = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        stop.Cancel();
    };
    return stop;
}

static async Task RunConnected(string origin, bool fake)
{
    using var stop = ConsoleStop();
    using var connection = new CaptureConnection(origin);
    Console.Error.Write("Pairing code from Discord: ");
    var code = Console.ReadLine()?.Trim();
    if (string.IsNullOrEmpty(code))
        throw new ArgumentException("A pairing code is required.");
    try
    {
        await connection.PairAsync(code, stop.Token);
    }
    catch (OperationCanceledException) when (!stop.IsCancellationRequested)
    {
        throw new IOException("Pairing request timed out. Request a fresh code if needed.");
    }
    var stream = new EventStream(connection.Enqueue);
    var transport = connection.SendAsync(stop.Token);
    var capture = fake ? FakeGame.ReplayAsync(stream, TimeSpan.FromSeconds(4), stop.Token) :
        RunCapture(stream, stop.Token);
    try
    {
        var completed = await Task.WhenAny(transport, capture);
        await completed;
        if (completed == capture && fake)
        {
            Console.Error.WriteLine("Fake match finished. Sending heartbeats until you press Ctrl+C.");
            await transport;
        }
    }
    finally
    {
        await stop.CancelAsync();
        try { await Task.WhenAll(transport, capture); }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) {}
    }
}

static async Task RunCapture(EventStream stream, CancellationToken stop)
{
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
                        await Task.Delay(250, stop);
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
            await Task.Delay(1000, stop);
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
