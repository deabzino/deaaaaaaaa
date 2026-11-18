using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Channels;

sealed class CaptureConnection : IDisposable
{
    private readonly HttpClient client;
    private readonly Channel<CaptureEvent> events = Channel.CreateBounded<CaptureEvent>(new BoundedChannelOptions(64)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
        SingleWriter = true
    });
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public CaptureConnection(string origin, HttpMessageHandler? handler = null)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            uri.UserInfo.Length != 0 || uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new ArgumentException("Enter dea's HTTPS server origin, such as https://dea.example.com.");

        client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false })
        {
            BaseAddress = new Uri(uri, "/api/capture/"),
            Timeout = TimeSpan.FromSeconds(5)
        };
    }

    public async Task PairAsync(string code, CancellationToken stop)
    {
        using var response = await client.PostAsJsonAsync("pair", new { code }, stop);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new InvalidOperationException("Pairing code is invalid, expired, or already used. Request a new one in Discord.");
        response.EnsureSuccessStatusCode();
        using var body = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(stop),
            cancellationToken: stop);
        var token = body.RootElement.GetProperty("token").GetString();
        if (token is null || token.Length != 43 || token.Any(character => !char.IsAsciiLetterOrDigit(character) &&
            character is not '-' and not '_'))
            throw new InvalidOperationException("The server did not return a valid capture credential.");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        Console.Error.WriteLine("Paired with dea.");
    }

    public void Enqueue(CaptureEvent snapshot) => events.Writer.TryWrite(snapshot);

    public async Task SendAsync(CancellationToken stop)
    {
        CaptureEvent? latest = null;
        var reconnecting = false;
        var retryDelay = TimeSpan.FromSeconds(1);
        var heartbeatAt = DateTimeOffset.UtcNow;
        while (!stop.IsCancellationRequested)
        {
            try
            {
                if (reconnecting)
                {
                    // Drop old queued events and send the freshest complete snapshot first.
                    while (events.Reader.TryRead(out var queued)) latest = queued;
                    if (latest is not null) await PostAsync("events", latest, stop, resync: true);
                    else await PostAsync("heartbeat", null, stop);
                    Console.Error.WriteLine("Reconnected to dea.");
                    reconnecting = false;
                    heartbeatAt = DateTimeOffset.UtcNow;
                    retryDelay = TimeSpan.FromSeconds(1);
                }

                if (DateTimeOffset.UtcNow >= heartbeatAt)
                {
                    await PostAsync("heartbeat", null, stop);
                    heartbeatAt = DateTimeOffset.UtcNow.AddSeconds(5);
                }

                if (events.Reader.TryRead(out var next))
                {
                    latest = next;
                    await PostAsync("events", latest, stop);
                }
                else await Task.Delay(200, stop);
            }
            catch (Exception error) when (!stop.IsCancellationRequested &&
                error is HttpRequestException or OperationCanceledException)
            {
                if (!reconnecting) Console.Error.WriteLine("Lost connection to dea. Retrying automatically.");
                reconnecting = true;
                await Task.Delay(retryDelay, stop);
                retryDelay = TimeSpan.FromSeconds(Math.Min(15, retryDelay.TotalSeconds * 2));
            }
        }
    }

    private async Task PostAsync(string endpoint, CaptureEvent? snapshot, CancellationToken stop, bool resync = false)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        if (snapshot is not null) request.Content = JsonContent.Create(snapshot, options: JsonOptions);
        if (resync) request.Headers.Add("X-Capture-Resync", "1");
        using var response = await client.SendAsync(request, stop);
        if (response.IsSuccessStatusCode) return;
        if ((int)response.StatusCode is 408 or 429 or >= 500) response.EnsureSuccessStatusCode();
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new InvalidOperationException("Capture credential was revoked or the server restarted. Pair again in Discord.");
        throw new InvalidOperationException($"Dea rejected the capture request (HTTP {(int)response.StatusCode}).");
    }

    public void Dispose() => client.Dispose();
}
