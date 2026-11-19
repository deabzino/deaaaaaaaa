using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// Tracks what the local listener reports to the website.
sealed class ListenState
{
    private readonly object gate = new();
    private string state = "waiting";

    public void Set(string next) { lock (gate) state = next; }
    public string Get() { lock (gate) return state; }
}

// A tiny HTTP listener on this computer only. The dea website hands the pairing code to it,
// because only this app can read Among Us. The website origin is fixed, never taken from a request.
sealed partial class PairingListener : IDisposable
{
    public const int Port = 47821;
    private const int MaxAttempts = 6;
    private static readonly TimeSpan AttemptWindow = TimeSpan.FromMinutes(1);

    [GeneratedRegex("^[A-Z2-9]{10}$")]
    private static partial Regex CodePattern();

    private readonly HttpListener listener = new();
    private readonly string webOrigin;
    private readonly ListenState state;
    private readonly Func<string, CancellationToken, Task> pair;
    private readonly Queue<DateTimeOffset> attempts = new();

    public PairingListener(string webOrigin, ListenState state, Func<string, CancellationToken, Task> pair)
    {
        this.webOrigin = webOrigin;
        this.state = state;
        this.pair = pair;
    }

    public void Start(CancellationToken stop)
    {
        listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        try
        {
            listener.Start();
        }
        catch (HttpListenerException error)
        {
            throw new IOException($"Could not listen on 127.0.0.1:{Port} ({error.Message}). Close any other copy of the capture app and try again.");
        }
        stop.Register(() => { try { listener.Close(); } catch (ObjectDisposedException) {} });
        _ = Task.Run(() => LoopAsync(stop));
    }

    private async Task LoopAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested && listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync();
            }
            catch (Exception error) when (error is HttpListenerException or ObjectDisposedException or InvalidOperationException)
            {
                return;
            }
            _ = Task.Run(() => HandleAsync(context, stop));
        }
    }

    private bool AllowAttempt()
    {
        lock (attempts)
        {
            var now = DateTimeOffset.UtcNow;
            while (attempts.Count > 0 && now - attempts.Peek() > AttemptWindow) attempts.Dequeue();
            if (attempts.Count >= MaxAttempts) return false;
            attempts.Enqueue(now);
            return true;
        }
    }

    private async Task HandleAsync(HttpListenerContext context, CancellationToken stop)
    {
        var request = context.Request;
        var response = context.Response;
        try
        {
            // Block DNS rebinding and any page that is not the dea website.
            var origin = request.Headers["Origin"];
            if (request.Headers["Host"] != $"127.0.0.1:{Port}" || origin != webOrigin)
            {
                await Send(response, 403, new { error = "forbidden" });
                return;
            }
            response.Headers["Access-Control-Allow-Origin"] = webOrigin;
            response.Headers["Access-Control-Allow-Private-Network"] = "true";
            response.Headers["Vary"] = "Origin";
            response.Headers["Cache-Control"] = "no-store";

            var path = request.Url?.AbsolutePath;
            if (request.HttpMethod == "OPTIONS" && path is "/status" or "/pair")
            {
                response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
                response.Headers["Access-Control-Max-Age"] = "60";
                response.StatusCode = 204;
                response.Close();
                return;
            }
            if (request.HttpMethod == "GET" && path == "/status")
            {
                await Send(response, 200, new { app = "dea-capture", state = state.Get() });
                return;
            }
            if (request.HttpMethod == "POST" && path == "/pair")
            {
                await HandlePairAsync(request, response, stop);
                return;
            }
            await Send(response, 404, new { error = "not_found" });
        }
        catch (Exception error) when (error is HttpListenerException or ObjectDisposedException or IOException
            or InvalidOperationException)
        {
            try { response.Abort(); } catch (ObjectDisposedException) {}
        }
    }

    private async Task HandlePairAsync(HttpListenerRequest request, HttpListenerResponse response, CancellationToken stop)
    {
        if (request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) != true ||
            request.ContentLength64 is < 1 or > 256)
        {
            await Send(response, 400, new { error = "bad_request" });
            return;
        }

        string? code;
        try
        {
            using var reader = new StreamReader(request.InputStream, Encoding.UTF8);
            using var body = JsonDocument.Parse(await reader.ReadToEndAsync(stop));
            code = body.RootElement.ValueKind == JsonValueKind.Object &&
                body.RootElement.TryGetProperty("code", out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()?.Trim().ToUpperInvariant() : null;
        }
        catch (JsonException)
        {
            code = null;
        }
        if (code is null || !CodePattern().IsMatch(code))
        {
            await Send(response, 400, new { error = "invalid_format" });
            return;
        }
        if (!AllowAttempt())
        {
            await Send(response, 429, new { error = "rate_limited" });
            return;
        }

        try
        {
            await pair(code, stop);
            await Send(response, 200, new { state = "connected" });
        }
        catch (InvalidOperationException)
        {
            await Send(response, 401, new { error = "invalid_code" });
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException)
        {
            await Send(response, 502, new { error = "server_unreachable" });
        }
        catch (Exception) when (!stop.IsCancellationRequested)
        {
            await Send(response, 500, new { error = "internal_error" });
        }
    }

    private static async Task Send(HttpListenerResponse response, int status, object body)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(body, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        response.StatusCode = status;
        response.ContentType = "application/json";
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes);
        response.Close();
    }

    public void Dispose()
    {
        try { listener.Close(); } catch (ObjectDisposedException) {}
    }
}
