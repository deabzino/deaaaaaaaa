// Game layout and pointer-chain interpretation adapted from AmongUsCapture
// at 725a3fa09524c23457e4e8db39bc92ae7a8ac527.
// Copyright (c) 2020 Denver Quane. See LICENSE.AmongUsCapture.
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

sealed class GameReader : IDisposable
{
    private const uint ReadAccess = 0x0010;
    private readonly SafeProcessHandle handle;
    private readonly nint assembly;
    private readonly JsonElement profile;
    private string? lobbyCode;
    private int? region;
    private int? map;

    public static (string Hash, string Path) FindProfile(string gameAssembly)
    {
        using var file = File.OpenRead(gameAssembly);
        var hash = Convert.ToHexString(SHA256.HashData(file));
        var path = Path.Combine(AppContext.BaseDirectory, "profiles", hash + ".json");
        if (!File.Exists(path))
            throw new NotSupportedException($"Unsupported GameAssembly.dll (SHA-256 {hash}). A matching offset profile is required.");
        return (hash, path);
    }

    public GameReader(Process process)
    {
        var module = process.Modules.Cast<ProcessModule>().FirstOrDefault(
            module => module.ModuleName.Equals("GameAssembly.dll", StringComparison.OrdinalIgnoreCase))
            ?? throw new IOException("Waiting for GameAssembly.dll to load.");
        var (hash, path) = FindProfile(module.FileName);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        profile = document.RootElement.Clone();
        assembly = module.BaseAddress;
        handle = OpenProcess(ReadAccess, false, process.Id);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        Console.Error.WriteLine($"Attached using {profile.GetProperty("Description").GetString()} ({hash}).");
    }

    public Snapshot Read()
    {
        var rawPhase = Integer(assembly, Chain(profile, "GameStateOffsets"));
        var phase = rawPhase switch
        {
            0 => "menu",
            1 => "lobby",
            2 => InMeeting() ? "meeting" : "tasks",
            3 => "ended",
            _ => throw new IOException($"Unknown game state: {rawPhase}.")
        };
        if (phase == "menu")
        {
            lobbyCode = null;
            region = null;
            map = null;
            return new(phase, null, null, null, []);
        }

        var players = ReadPlayers();
        string? code = null;
        int? readMap = null;
        int? readRegion = null;
        if (phase == "lobby" || lobbyCode is null)
        {
            try
            {
                var candidate = ReadText(Pointer(assembly, Chain(profile, "GameCodeOffsets")));
                if (candidate is not null && Regex.IsMatch(candidate, @"\A(?:[A-Z]{4}|[A-Z]{6}|\*{6})\z"))
                {
                    var rawRegion = Integer(assembly, Chain(profile, "PlayRegionOffsets"));
                    readMap = Integer(assembly, Chain(profile, "PlayMapOffsets"));
                    readRegion = (4 - (rawRegion & 3)) % 3;
                    code = candidate;
                }
            }
            catch (IOException)
            {
                // Lobby metadata can disappear during a phase transition.
            }
        }
        if (rawPhase != Integer(assembly, Chain(profile, "GameStateOffsets")) ||
            (rawPhase == 2 && InMeeting() != (phase == "meeting")))
            throw new IOException("Game phase changed while reading.");
        if (code is not null)
            (lobbyCode, region, map) = (code, readRegion, readMap);
        return new(phase, lobbyCode, region, map, players);
    }

    private bool InMeeting()
    {
        var meeting = Pointer(assembly, Chain(profile, "MeetingHudPtr"));
        return meeting != 0 &&
            Pointer(meeting, Chain(profile, "MeetingHudCachePtrOffsets")) != 0 &&
            Integer(meeting, Chain(profile, "MeetingHudStateOffsets")) < 4;
    }

    private Player[] ReadPlayers()
    {
        var list = Pointer(assembly, Chain(profile, "AllPlayerPtrOffsets"));
        if (list == 0)
            throw new IOException("Waiting for the player list.");
        var count = Integer(list, Chain(profile, "PlayerCountOffsets"));
        if (count is < 0 or > 15)
            throw new IOException($"Invalid player count: {count}.");
        var entries = Pointer(list, Chain(profile, "AllPlayersOffsets"));
        var info = profile.GetProperty("PlayerInfoStructOffsets");
        var outfitLayout = profile.GetProperty("PlayerOutfitStructOffsets");
        var players = new List<Player>();
        for (var i = 0; i < count; i++)
        {
            var entry = Pointer(entries, [Number(profile, "PlayerListPtr") + i * Number(profile, "AddPlayerPtr")]);
            if (entry == 0)
                throw new IOException("Player entry changed while reading.");
            var outfit = Pointer(entry, Chain(info, "OutfitsOffset"));
            if (outfit == 0)
                throw new IOException("Waiting for the player outfit.");
            var name = ReadText(Pointer(outfit, [Number(outfitLayout, "PlayerNameOffset")]));
            var colour = Integer(outfit, [Number(outfitLayout, "ColorIDOffset")]);
            if (string.IsNullOrWhiteSpace(name) || colour is < 0 or > 17)
                throw new IOException("Waiting for a valid player outfit.");
            var id = Bytes(entry + Number(info, "PlayerIDOffset"), 1)[0];
            var dead = Bytes(entry + Number(info, "IsDeadOffset"), 1)[0] != 0;
            var disconnected = Bytes(entry + Number(info, "DisconnectedOffset"), 1)[0] != 0;
            players.Add(new(id, name, colour, dead, disconnected, ReadImpostor(entry, info)));
        }
        if (count != Integer(list, Chain(profile, "PlayerCountOffsets")) ||
            list != Pointer(assembly, Chain(profile, "AllPlayerPtrOffsets")) ||
            players.Select(player => player.Id).Distinct().Count() != count)
            throw new IOException("Player list changed while reading.");
        return players.OrderBy(player => player.Id).ToArray();
    }

    private bool? ReadImpostor(nint entry, JsonElement info)
    {
        // Read roles only in the local capture. Snapshot events omit the role entirely.
        try
        {
            var address = Address(entry, Chain(info, "RoleTeamTypeOffset"));
            if (address != 0)
                return BitConverter.ToInt32(Bytes(address, 4)) switch { 0 => false, 1 => true, _ => null };
        }
        catch (IOException)
        {
            // The role may not be available on this client.
        }
        return null;
    }

    private string? ReadText(nint address)
    {
        if (address == 0)
            return null;
        var offsets = Chain(profile, "StringOffsets");
        var length = Integer(address, [offsets[0]]);
        if (length is < 0 or > 256)
            throw new IOException("Invalid game string length.");
        return length == 0 ? "" : Encoding.Unicode.GetString(Bytes(address + offsets[1], length * 2));
    }

    private static int Number(JsonElement element, string key) => element.GetProperty(key).GetInt32();
    private static int[] Chain(JsonElement element, string key) =>
        element.GetProperty(key).EnumerateArray().Select(value => value.GetInt32()).ToArray();

    private nint Address(nint address, int[] offsets)
    {
        foreach (var offset in offsets.AsSpan(0, offsets.Length - 1))
        {
            if (address == 0)
                return 0;
            address = (nint)BitConverter.ToInt64(Bytes(address + offset, 8));
        }
        return address == 0 ? 0 : address + offsets[^1];
    }

    private nint Pointer(nint start, int[] offsets)
    {
        var address = Address(start, offsets);
        return address == 0 ? 0 : (nint)BitConverter.ToInt64(Bytes(address, 8));
    }

    private int Integer(nint start, int[] offsets) => BitConverter.ToInt32(Bytes(Address(start, offsets), 4));

    private byte[] Bytes(nint address, int count)
    {
        var buffer = new byte[count];
        if (address == 0 || !ReadProcessMemory(handle, address, buffer, (nuint)count, out var read) ||
            read != (nuint)count)
            throw new IOException("Game memory was temporarily unreadable.");
        return buffer;
    }

    public void Dispose() => handle.Dispose();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int id);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(SafeProcessHandle process, nint address, [Out] byte[] buffer,
        nuint size, out nuint read);
}
