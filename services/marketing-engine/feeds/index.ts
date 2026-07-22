// Repo-local feeds, statically imported so they ship inside the serverless
// bundle. A profile's `feedFile` names a key in this map; the file is used
// whenever the profile's feed URL env is unset (fixture-flagged files are
// additionally restricted to dev builds — see fetchHighlights).
import artist from "./artist.json";
import macroVaultFixture from "./macro-vault.fixture.json";
import songBlueprint from "./song-blueprint.json";

export const feedFiles: Record<string, unknown> = {
  artist,
  "macro-vault.fixture": macroVaultFixture,
  "song-blueprint": songBlueprint
};
