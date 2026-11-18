export type SavedMatch = { normalizedName: string; userId: string };

export interface MatchStore {
  find(guildId: string, names: string[]): Promise<SavedMatch[]>;
  save(guildId: string, match: SavedMatch, overwrite: boolean): Promise<boolean>;
  remove(guildId: string, userId: string, names?: string[]): Promise<boolean>;
}

export function createMatchStore(
  projectUrl: string | undefined, key: string | undefined, warn: (operation: string) => void,
  request = fetch,
): MatchStore {
  let endpoint: string | undefined;
  try {
    const origin = new URL(projectUrl ?? "");
    if (origin.protocol === "https:" && !origin.username && !origin.password) {
      endpoint = new URL("/rest/v1/among_us_name_matches", origin).href;
    }
  } catch {
    // An unconfigured store still supports session links.
  }

  let lastWarning: number | undefined;
  function unavailable(operation: string) {
    const now = Date.now();
    if (lastWarning === undefined || now - lastWarning >= 60_000) {
      lastWarning = now;
      warn(operation);
    }
  }

  async function send<T>(params: URLSearchParams, init: RequestInit, read: (response: Response) => Promise<T>) {
    if (!endpoint || !key) {
      unavailable("not configured");
      return undefined;
    }
    try {
      const headers = new Headers(init.headers);
      headers.set("apikey", key);
      // Supabase secret keys work in apikey only. Legacy service-role JWTs also authenticate as bearer.
      if (!key.startsWith("sb_secret_")) headers.set("Authorization", `Bearer ${key}`);
      const response = await request(`${endpoint}?${params}`, {
        ...init, headers, redirect: "error", signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error("Match store request failed");
      return await read(response);
    } catch {
      // Never log the request, response body or exception. Any of these may contain credentials.
      unavailable(init.method ?? "GET");
      return undefined;
    }
  }

  const selectBy = (guildId: string, names?: string[]) => {
    const params = new URLSearchParams({ guild_id: `eq.${guildId}` });
    if (names?.length) params.set("normalized_name", `in.(${names.join(",")})`);
    return params;
  };

  return {
    async find(guildId, names) {
      if (!names.length) return [];
      const params = selectBy(guildId, names);
      params.set("select", "normalized_name,discord_user_id");
      const rows = await send(params, {}, async (response) =>
        await response.json() as { normalized_name: string; discord_user_id: string }[]);
      if (rows === undefined) throw new Error("Saved matches unavailable");
      return rows.map((row) => ({ normalizedName: row.normalized_name, userId: row.discord_user_id }));
    },
    async save(guildId, match, overwrite) {
      return (await send(new URLSearchParams({ on_conflict: "guild_id,normalized_name" }), {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: `resolution=${overwrite ? "merge" : "ignore"}-duplicates,return=minimal` },
        body: JSON.stringify({
          guild_id: guildId,
          normalized_name: match.normalizedName,
          discord_user_id: match.userId,
          updated_at: new Date().toISOString(),
        }),
      }, async () => true)) ?? false;
    },
    async remove(guildId, userId, names) {
      if (names?.length === 0) return true;
      const params = selectBy(guildId, names);
      params.set("discord_user_id", `eq.${userId}`);
      return (await send(params, { method: "DELETE" }, async () => true)) ?? false;
    },
  };
}
