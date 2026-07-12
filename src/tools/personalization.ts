import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyTrack,
  SpotifyArtistFull,
  SpotifyPaged,
  RecentlyPlayedResponse,
  RecommendationsResponse,
  AvailableGenreSeedsResponse,
  FeaturedPlaylistsResponse,
} from '../types/spotify.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const timeRangeSchema = z
  .enum(['short_term', 'medium_term', 'long_term'])
  .optional()
  .describe('~4 weeks / ~6 months / all time. Default: medium_term');

const limitSchema = (max = 50) =>
  z.number().int().min(1).max(max).optional().describe(`1–${max}. Default: 20`);

// Audio attribute tuning — min/max/target for 13 float attributes + key + mode + time_signature + duration_ms
const FLOAT_ATTRS = [
  'acousticness',
  'danceability',
  'energy',
  'instrumentalness',
  'liveness',
  'loudness',
  'speechiness',
  'tempo',
  'valence',
] as const;

const INT_ATTRS = ['duration_ms', 'key', 'mode', 'time_signature'] as const;

function audioTuningSchema() {
  const schema: Record<string, z.ZodOptional<z.ZodNumber>> = {};
  for (const attr of FLOAT_ATTRS) {
    schema[`min_${attr}`] = z.number().optional();
    schema[`max_${attr}`] = z.number().optional();
    schema[`target_${attr}`] = z.number().optional();
  }
  for (const attr of INT_ATTRS) {
    schema[`min_${attr}`] = z.number().int().optional();
    schema[`max_${attr}`] = z.number().int().optional();
    schema[`target_${attr}`] = z.number().int().optional();
  }
  return schema;
}

export function registerPersonalizationTools(server: McpServer, client: SpotifyClient): void {
  // get_top_tracks
  server.tool(
    'get_top_tracks',
    "Get the user's most-played tracks",
    {
      time_range: timeRangeSchema,
      limit: limitSchema(50),
    },
    async (args) => {
      const params: Record<string, string> = {
        time_range: args.time_range ?? 'medium_term',
        limit: String(args.limit ?? 20),
      };
      const result = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', params);
      if (!result) throw new Error('Could not retrieve top tracks');

      // Spotify's /me/top/tracks can return null/undefined `items` on 200 in
      // some edge cases (no listening history, account issue, malformed
      // pagination state). Validate before reading `.length` to avoid the
      // "Cannot read properties of undefined" crash on issue #3.
      const items = Array.isArray(result.items) ? result.items : [];
      const total = typeof result.total === 'number' ? result.total : items.length;

      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: `No top tracks found (total: ${total}).` }],
        };
      }

      const lines = [`Top tracks (${total} total, showing ${items.length}):`];
      items.forEach((track, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  ${i + 1}. "${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_top_artists
  server.tool(
    'get_top_artists',
    "Get the user's most-played artists",
    {
      time_range: timeRangeSchema,
      limit: limitSchema(50),
    },
    async (args) => {
      const params: Record<string, string> = {
        time_range: args.time_range ?? 'medium_term',
        limit: String(args.limit ?? 20),
      };
      const result = await client.get<SpotifyPaged<SpotifyArtistFull>>('/me/top/artists', params);
      if (!result) throw new Error('Could not retrieve top artists');

      // Same defensive guard as get_top_tracks above — issue #3 crashes
      // here when Spotify returns null/undefined `items` or when an artist
      // row omits `genres` (the second access previously crashed). Surface
      // a useful empty/error message instead.
      const items = Array.isArray(result.items) ? result.items : [];
      const total = typeof result.total === 'number' ? result.total : items.length;

      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: `No top artists found (total: ${total}).` }],
        };
      }

      const lines = [`Top artists (${total} total, showing ${items.length}):`];
      items.forEach((artist, i) => {
        const genres =
          Array.isArray(artist.genres) && artist.genres.length > 0
            ? artist.genres.join(', ')
            : 'no genres listed';
        lines.push(`  ${i + 1}. ${artist.name} — ${genres} | URI: ${artist.uri}`);
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_recently_played
  server.tool(
    'get_recently_played',
    'Get recently played tracks with timestamps',
    {
      limit: limitSchema(50),
      after: z
        .number()
        .int()
        .optional()
        .describe('Unix timestamp ms — return tracks played after this time'),
      before: z
        .number()
        .int()
        .optional()
        .describe('Unix timestamp ms — return tracks played before this time'),
    },
    async (args) => {
      const params: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.after !== undefined) params.after = String(args.after);
      if (args.before !== undefined) params.before = String(args.before);

      const result = await client.get<RecentlyPlayedResponse>(
        '/me/player/recently-played',
        params,
      );
      if (!result) throw new Error('Could not retrieve recently played tracks');

      const lines = [`Recently played (${result.items.length} tracks):`];
      for (const item of result.items) {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        const playedAt = new Date(item.played_at).toLocaleString();
        lines.push(
          `  • "${item.track.name}" by ${artists} — played at ${playedAt} | URI: ${item.track.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_recommendations
  server.tool(
    'get_recommendations',
    'Generate track recommendations from seed tracks/artists/genres with optional audio attribute tuning. Total seeds (tracks + artists + genres) must be 1–5.',
    {
      seed_tracks: z
        .array(z.string())
        .max(5)
        .optional()
        .describe('Up to 5 track IDs as recommendation seeds'),
      seed_artists: z
        .array(z.string())
        .max(5)
        .optional()
        .describe('Up to 5 artist IDs as recommendation seeds'),
      seed_genres: z
        .array(z.string())
        .max(5)
        .optional()
        .describe('Up to 5 genre strings (from get_available_genres) as recommendation seeds'),
      limit: limitSchema(100),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      ...audioTuningSchema(),
    },
    async (args) => {
      const totalSeeds =
        (args.seed_tracks?.length ?? 0) +
        (args.seed_artists?.length ?? 0) +
        (args.seed_genres?.length ?? 0);
      if (totalSeeds < 1 || totalSeeds > 5) {
        throw new Error(
          `Total seeds must be between 1 and 5, got ${totalSeeds}. Provide seed_tracks, seed_artists, and/or seed_genres.`,
        );
      }

      const params: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.seed_tracks?.length) params.seed_tracks = args.seed_tracks.join(',');
      if (args.seed_artists?.length) params.seed_artists = args.seed_artists.join(',');
      if (args.seed_genres?.length) params.seed_genres = args.seed_genres.join(',');
      if (args.market) params.market = args.market;

      // Forward all audio tuning attributes
      for (const attr of FLOAT_ATTRS) {
        for (const prefix of ['min', 'max', 'target'] as const) {
          const key = `${prefix}_${attr}` as keyof typeof args;
          if (args[key] !== undefined) params[key] = String(args[key]);
        }
      }
      for (const attr of INT_ATTRS) {
        for (const prefix of ['min', 'max', 'target'] as const) {
          const key = `${prefix}_${attr}` as keyof typeof args;
          if (args[key] !== undefined) params[key] = String(args[key]);
        }
      }

      const result = await client.get<RecommendationsResponse>('/recommendations', params);
      if (!result) throw new Error('Could not retrieve recommendations');

      const lines = [`Recommended tracks (${result.tracks.length}):`];
      result.tracks.forEach((track, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  ${i + 1}. "${track.name}" by ${artists} — ${track.album.name} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_related_artists
  server.tool(
    'get_related_artists',
    'Get artists similar to a given artist',
    { id: z.string().describe('Spotify artist ID') },
    async (args) => {
      const result = await client.get<{ artists: SpotifyArtistFull[] }>(
        `/artists/${encodeURIComponent(args.id)}/related-artists`,
      );
      if (!result) throw new Error('Artist not found');

      const lines = [`Artists related to ${args.id} (${result.artists.length}):`];
      result.artists.forEach((artist, i) => {
        const genres = artist.genres.length ? artist.genres.join(', ') : 'no genres listed';
        lines.push(`  ${i + 1}. ${artist.name} — ${genres} | URI: ${artist.uri}`);
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_available_genres
  server.tool(
    'get_available_genres',
    'Get the list of genre strings usable as recommendation seeds',
    {},
    async () => {
      const result = await client.get<AvailableGenreSeedsResponse>(
        '/recommendations/available-genre-seeds',
      );
      if (!result) throw new Error('Could not retrieve genre seeds');

      return {
        content: [
          {
            type: 'text',
            text: `Available genre seeds (${result.genres.length}):\n${result.genres.join(', ')}`,
          },
        ],
      };
    },
  );

  // get_featured_playlists
  server.tool(
    'get_featured_playlists',
    "Get Spotify's editorially curated featured playlists",
    {
      locale: z
        .string()
        .optional()
        .describe('BCP 47 language tag (e.g. "en_US") for localized names'),
      limit: limitSchema(50),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
    },
    async (args) => {
      const params: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.locale) params.locale = args.locale;
      if (args.offset !== undefined) params.offset = String(args.offset);

      const result = await client.get<FeaturedPlaylistsResponse>(
        '/browse/featured-playlists',
        params,
      );
      if (!result) throw new Error('Could not retrieve featured playlists');

      const lines = [
        result.message,
        `Featured playlists (${result.playlists.total} total, showing ${result.playlists.items.length}):`,
      ];
      for (const pl of result.playlists.items) {
        const desc = pl.description ? ` — ${pl.description}` : '';
        lines.push(
          `  • "${pl.name}" by ${pl.owner.display_name ?? pl.owner.id}${desc} (${pl.tracks.total} tracks) | URI: ${pl.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
