export type Platform = "windows" | "linux" | "unsupported";
export type CatalogPlatform = Exclude<Platform, "unsupported">;

export type GameBuild = {
  downloadUrl: string;
  executable: string;
};

export type Game = {
  id: string;
  title: string;
  summary: string;
  accent: string;
  coverUrl?: string;
  builds: Partial<Record<Platform, GameBuild>>;
};

export type CatalogResponse = {
  games: Game[];
  source: "remote" | "cache" | "bundled" | "local";
  detail: string | null;
};

export type SavedCatalogResponse = {
  games: Game[];
  backupPath: string;
  catalogPath: string;
};

export type EditableGame = Omit<Game, "builds"> & {
  builds: Partial<Record<CatalogPlatform, GameBuild>>;
};
