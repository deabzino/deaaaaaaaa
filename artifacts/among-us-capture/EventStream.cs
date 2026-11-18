using System.Text.Json;
using System.Text.Json.Serialization;

sealed record Player(int Id, string Name, int Colour, bool Dead, bool Disconnected,
    [property: JsonIgnore] bool? IsImpostor);

sealed record Snapshot(string Phase, string? LobbyCode, int? RegionId, int? MapId, Player[] Players);
sealed record Change(string Kind, int? PlayerId = null);
sealed record CaptureEvent(int ProtocolVersion, string StreamId, long Sequence, Snapshot? Game,
    IReadOnlyList<Change> Changes);

sealed class EventStream(Action<CaptureEvent> publish)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public EventStream(TextWriter output) : this(snapshot =>
    {
        output.WriteLine(JsonSerializer.Serialize(snapshot, JsonOptions));
        output.Flush();
    }) {}

    private Snapshot? previous;
    private long sequence;
    private readonly string streamId = Guid.NewGuid().ToString("N");

    public void Send(Snapshot? current)
    {
        if (previous is { } last && current is { } game &&
            last.Phase == game.Phase && last.LobbyCode == game.LobbyCode &&
            last.RegionId == game.RegionId && last.MapId == game.MapId &&
            last.Players.Length == game.Players.Length &&
            last.Players.Zip(game.Players).All(pair =>
                pair.First with { IsImpostor = null } == pair.Second with { IsImpostor = null }))
            return;

        var changes = new List<Change>();
        if (previous?.Phase != current?.Phase)
            changes.Add(new(current is null ? "captureLost" : "phaseChanged"));

        var sameLobby = previous is not null && current is not null && previous.Phase != "menu" &&
            (previous.LobbyCode is null || current.LobbyCode is null || previous.LobbyCode == current.LobbyCode);
        var oldPlayers = sameLobby ? previous?.Players ?? [] : [];
        var newPlayers = current?.Players ?? [];
        var oldById = oldPlayers.ToDictionary(player => player.Id);
        foreach (var player in newPlayers)
        {
            if (!oldById.TryGetValue(player.Id, out var old))
                changes.Add(new("playerJoined", player.Id));
            else
            {
                if (player.Colour != old.Colour)
                    changes.Add(new("colourChanged", player.Id));
                if (player.Dead && !old.Dead)
                    changes.Add(new("playerDied", player.Id));
                if (player.Disconnected && !old.Disconnected)
                    changes.Add(new("playerDisconnected", player.Id));
            }
        }

        var newIds = newPlayers.Select(player => player.Id).ToHashSet();
        foreach (var player in oldPlayers)
            if (!newIds.Contains(player.Id))
                changes.Add(new("playerLeft", player.Id));

        var envelope = new CaptureEvent(1, streamId, ++sequence, current, changes);
        publish(envelope);
        previous = current;
    }

    public void Lost()
    {
        if (previous is not null)
            Send(null);
    }
}
