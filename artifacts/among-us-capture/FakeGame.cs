using System.Text.Json;

static class FakeGame
{
    public static async Task ReplayAsync(EventStream stream, TimeSpan delay = default, CancellationToken stop = default)
    {
        var purple = new Player(1, "Pixel", 8, false, false, true);
        var black = new Player(2, "Orbit", 6, false, false, false);
        var green = new Player(3, "Moss", 2, false, false, null);
        var lime = purple with { Colour = 11 };
        var ghost = black with { Dead = true };

        await Emit(new("menu", null, null, null, []));
        await Send("lobby", purple, black);
        await Send("lobby", lime, black, green);
        await Send("lobby", lime, black);
        await Send("tasks", lime, black);
        await Send("tasks", lime, ghost);
        await Send("meeting", lime, ghost);
        await Send("tasks", lime, ghost);
        await Send("ended", lime, ghost);
        await Send("lobby", lime, black);
        stream.Lost();
        stream.Lost();
        await Task.Delay(delay, stop);
        await Send("lobby", lime, black);

        Task Send(string phase, params Player[] players) => Emit(new(phase, "ABCDEF", 0, 0, players));

        async Task Emit(Snapshot snapshot)
        {
            stream.Send(snapshot);
            await Task.Delay(delay, stop);
        }
    }

    public static void Test()
    {
        using var output = new StringWriter();
        ReplayAsync(new EventStream(output)).GetAwaiter().GetResult();
        var events = output.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonSerializer.Deserialize<JsonElement>(line)).ToArray();
        var expected = new[] { "menu", "lobby", "lobby", "lobby", "tasks", "tasks", "meeting",
            "tasks", "ended", "lobby", null, "lobby" };
        Check(events.Length == expected.Length, "event count and duplicate loss suppression");
        var streamId = events[0].GetProperty("streamId").GetString();
        for (var i = 0; i < events.Length; i++)
        {
            var game = events[i].GetProperty("game");
            var phase = game.ValueKind == JsonValueKind.Null ? null : game.GetProperty("phase").GetString();
            Check(phase == expected[i], $"phase at event {i + 1}");
            Check(events[i].GetProperty("sequence").GetInt64() == i + 1 &&
                events[i].GetProperty("streamId").GetString() == streamId, "stream identity and sequence");
            if (game.ValueKind != JsonValueKind.Null)
                Check(game.GetProperty("players").EnumerateArray().All(
                    player => !player.TryGetProperty("isImpostor", out _)), "role privacy");
        }

        HasChange(2, "colourChanged", 1);
        HasChange(2, "playerJoined", 3);
        HasChange(3, "playerLeft", 3);
        HasChange(5, "playerDied", 2);
        Check(events[5].GetProperty("game").GetProperty("players")[1].GetProperty("dead").GetBoolean(),
            "private death before meeting");
        Check(!events[9].GetProperty("game").GetProperty("players")[1].GetProperty("dead").GetBoolean(),
            "death cleared on return to lobby");
        HasChange(10, "captureLost", null);
        HasChange(11, "playerJoined", 1);
        Console.Error.WriteLine("Fake capture checks passed (12 events).");

        void HasChange(int index, string kind, int? playerId)
        {
            Check(events[index].GetProperty("changes").EnumerateArray().Any(change =>
                change.GetProperty("kind").GetString() == kind &&
                (change.GetProperty("playerId").ValueKind == JsonValueKind.Null
                    ? (int?)null : change.GetProperty("playerId").GetInt32()) == playerId), kind);
        }
    }

    private static void Check(bool valid, string name)
    {
        if (!valid)
            throw new InvalidOperationException($"Fake capture check failed: {name}.");
    }
}
