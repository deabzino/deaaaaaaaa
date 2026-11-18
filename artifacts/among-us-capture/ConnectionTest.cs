using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

static class ConnectionTest
{
    public static async Task RunAsync()
    {
        var handler = new TestServer();
        using var connection = new CaptureConnection("https://dea.example.org", handler);
        using var stop = new CancellationTokenSource();
        var stream = new EventStream(connection.Enqueue);
        var player = new Player(1, "Pixel", 8, false, false, true);

        await connection.PairAsync("ABCDEF2345", stop.Token);
        stream.Send(new("lobby", "ABCDEF", 0, 0, [player]));
        var transport = connection.SendAsync(stop.Token);
        try
        {
            await handler.Failed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            stream.Send(new("tasks", "ABCDEF", 0, 0, [player]));
            stream.Send(new("meeting", "ABCDEF", 0, 0, [player]));
            var recovered = await handler.Recovered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Require(recovered == 3, "the reconnect sent the newest snapshot");
            handler.Revoke = true;
            stream.Send(new("ended", "ABCDEF", 0, 0, [player]));
            try
            {
                await transport.WaitAsync(TimeSpan.FromSeconds(5));
                throw new Exception("Transport continued after revocation.");
            }
            catch (InvalidOperationException error) when (error.Message.Contains("revoked"))
            {
                Require(handler.Heartbeats > 0, "an authenticated heartbeat was sent");
            }
        }
        finally
        {
            await stop.CancelAsync();
            try { await transport; }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) {}
            catch (InvalidOperationException error) when (error.Message.Contains("revoked")) {}
        }
        Console.Error.WriteLine("Capture connection checks passed (auth, heartbeat, reconnect snapshot, revocation).");
    }

    private static void Require(bool condition, string description)
    {
        if (!condition) throw new InvalidOperationException($"Transport check failed: {description}.");
    }

    private sealed class TestServer : HttpMessageHandler
    {
        private readonly string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(22))[..43];
        public TaskCompletionSource Failed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<long> Recovered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public volatile bool Revoke;
        public int Heartbeats { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken stop)
        {
            Require(request.RequestUri?.Scheme == "https", "HTTPS URI");
            if (request.RequestUri!.AbsolutePath == "/api/capture/pair")
            {
                Require(request.Headers.Authorization is null, "pairing does not use a bearer credential");
                var body = await request.Content!.ReadFromJsonAsync<JsonElement>(stop);
                Require(body.GetProperty("code").GetString() == "ABCDEF2345", "pairing code in body");
                return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { token }) };
            }

            Require(request.Headers.Authorization?.Scheme == "Bearer" &&
                request.Headers.Authorization.Parameter == token, "bearer authorization");
            if (Revoke) return new(HttpStatusCode.Unauthorized);
            if (request.RequestUri.AbsolutePath == "/api/capture/heartbeat")
            {
                Heartbeats++;
                return new(HttpStatusCode.NoContent);
            }

            Require(request.RequestUri.AbsolutePath == "/api/capture/events", "event endpoint");
            var snapshot = await request.Content!.ReadFromJsonAsync<JsonElement>(stop);
            Require(!snapshot.GetProperty("game").GetProperty("players")[0].TryGetProperty("isImpostor", out _),
                "impostor field omitted");
            if (Failed.TrySetResult())
                throw new HttpRequestException("Simulated connection loss.");
            Require(request.Headers.TryGetValues("X-Capture-Resync", out var values) && values.Single() == "1",
                "resync marker");
            Recovered.TrySetResult(snapshot.GetProperty("sequence").GetInt64());
            return new(HttpStatusCode.NoContent);
        }
    }
}
