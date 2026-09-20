import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import catalog from "./catalog.json";
import "./App.css";

type Platform = "windows" | "linux" | "unsupported";
type CatalogPlatform = Exclude<Platform, "unsupported">;
type GameBuild = { downloadUrl: string; executable: string };
type Game = {
  id: string;
  title: string;
  summary: string;
  accent: string;
  coverUrl?: string;
  builds: Partial<Record<Platform, GameBuild>>;
};
type Installation = { installPath: string; executablePath: string };
type DownloadProgress = { gameId: string; downloadedBytes: number; totalBytes: number | null };
type CatalogResponse = {
  games: Game[];
  source: "remote" | "cache" | "bundled" | "local";
  detail: string | null;
};
type SavedCatalogResponse = { games: Game[]; backupPath: string };
type EditableGame = Omit<Game, "builds"> & {
  builds: Partial<Record<CatalogPlatform, GameBuild>>;
};
const fallbackGames = catalog as Game[];

function App() {
  const [selected, setSelected] = useState(0);
  const [games, setGames] = useState<Game[]>(fallbackGames);
  const [platform, setPlatform] = useState<Platform>("windows");
  const [installations, setInstallations] = useState<Record<string, Installation>>({});
  const [coverSources, setCoverSources] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("Catálogo local — selecione um jogo.");
  const [busy, setBusy] = useState(false);
  const [downloadingGameId, setDownloadingGameId] = useState<string | null>(null);
  const [gameRunning, setGameRunning] = useState(false);
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminError, setAdminError] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [catalogDialogOpen, setCatalogDialogOpen] = useState(false);
  const [catalogDraft, setCatalogDraft] = useState<EditableGame[]>([]);
  const [catalogPassword, setCatalogPassword] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [showCatalogPassword, setShowCatalogPassword] = useState(false);
  const [eventModeEnabled, setEventModeEnabled] = useState(false);
  const interactionLocked = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const game = games[selected] ?? fallbackGames[0];
  const build = game.builds[platform];
  const installation = installations[game.id];

  const installGame = useCallback(async () => {
    setBusy(true);
    setDownloadingGameId(game.id);
    setMessage(`Instalando ${game.title}…`);
    try {
      if (!build) throw new Error(`Não há build para ${platform}.`);
      const result = await invoke<Installation>("install_game", {
        gameId: game.id,
        downloadUrl: build.downloadUrl,
        executable: build.executable,
      });
      setInstallations((current) => ({ ...current, [game.id]: result }));
      let coverUnavailable = false;
      if (game.coverUrl) {
        try {
          const coverSource = await invoke<string>("get_cached_cover", {
            gameId: game.id,
            coverUrl: game.coverUrl,
          });
          setCoverSources((current) => ({ ...current, [game.id]: coverSource }));
        } catch {
          coverUnavailable = true;
        }
      }
      setMessage(
        coverUnavailable
          ? `${game.title} está pronto para jogar, mas não foi possível baixar a capa.`
          : `${game.title} está pronto para jogar.`,
      );
    } catch (error) {
      setMessage(`Falha ao instalar: ${String(error)}`);
    } finally {
      setBusy(false);
      setDownloadingGameId(null);
    }
  }, [build, game.coverUrl, game.id, game.title, platform]);

  const launchInstalledGame = useCallback(async () => {
    if (!installation || !build || gameRunning || interactionLocked.current) return;
    interactionLocked.current = true;
    setBusy(true);
    setMessage(`Abrindo ${game.title}…`);
    try {
      await invoke("launch_game", {
        executable: installation.executablePath,
        workingDirectory: installation.installPath,
      });
      setGameRunning(true);
      setMessage(`${game.title} está em execução.`);
    } catch (error) {
      interactionLocked.current = false;
      setMessage(`Falha ao abrir: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [build, game.title, gameRunning, installation]);

  const activateSelectedGame = useCallback(() => {
    if (busy || gameRunning || interactionLocked.current) return;
    if (!build) {
      setMessage(`Este jogo ainda não possui build para ${platform}.`);
      return;
    }
    if (installation) void launchInstalledGame();
    else void installGame();
  }, [build, busy, gameRunning, installGame, installation, launchInstalledGame, platform]);

  useEffect(() => {
    void invoke<Platform>("current_platform").then(setPlatform);
    void invoke<boolean>("event_mode_enabled").then(setEventModeEnabled);
  }, []);

  useEffect(() => {
    void invoke<CatalogResponse>("load_catalog")
      .then(({ games: updatedCatalog, source, detail }) => {
        if (updatedCatalog.length > 0) setGames(updatedCatalog);
        setSelected((current) => Math.min(current, Math.max(0, updatedCatalog.length - 1)));
        setMessage(
          source === "remote"
            ? "Catálogo atualizado do Drive."
            : source === "local"
              ? "Usando catálogo editado neste launcher."
              : `Não foi possível atualizar pelo Drive: ${detail ?? "erro desconhecido"}. ${source === "cache" ? "Usando catálogo salvo localmente." : "Usando catálogo embutido no launcher."}`,
        );
      })
      .catch(() => setMessage("Usando o catálogo local. Não foi possível atualizar pelo Drive."));
  }, []);

  useEffect(() => {
    Promise.all(
      games.map(
        async (item) =>
          [
            item.id,
            item.builds[platform]
              ? await invoke<Installation | null>("get_installation", {
                  gameId: item.id,
                  executable: item.builds[platform]?.executable,
                })
              : null,
          ] as const,
      ),
    )
      .then((entries) =>
        setInstallations(
          Object.fromEntries(entries.filter(([, item]) => item !== null)) as Record<
            string,
            Installation
          >,
        ),
      )
      .catch(() => setMessage("Não foi possível ler as instalações locais."));
  }, [games, platform]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      games
        .filter((item) => item.coverUrl)
        .map(async (item) => {
          try {
            return [
              item.id,
              await invoke<string>("get_cached_cover", {
                gameId: item.id,
                coverUrl: item.coverUrl,
              }),
            ] as const;
          } catch {
            return null;
          }
        }),
    ).then((entries) => {
      if (!cancelled)
        setCoverSources(
          Object.fromEntries(
            entries.filter((entry): entry is readonly [string, string] => entry !== null),
          ),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [games]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<DownloadProgress>("download-progress", (event) => {
      const { gameId, downloadedBytes, totalBytes } = event.payload;
      const title = games.find((item) => item.id === gameId)?.title ?? gameId;
      if (totalBytes)
        setMessage(
          `Baixando ${title}: ${Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))}%`,
        );
      else setMessage(`Baixando ${title}: ${(downloadedBytes / 1_048_576).toFixed(1)} MB`);
    }).then((stopListening) => {
      unlisten = stopListening;
    });
    return () => unlisten?.();
  }, [games]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (adminDialogOpen || catalogDialogOpen) return;
      if (event.target instanceof Element && event.target.closest("button, input, textarea"))
        return;
      if (["ArrowRight", "d", "D"].includes(event.key)) {
        event.preventDefault();
        setSelected((current) => (current + 1) % games.length);
      }
      if (["ArrowLeft", "a", "A"].includes(event.key)) {
        event.preventDefault();
        setSelected((current) => (current - 1 + games.length) % games.length);
      }
      if (["ArrowDown", "s", "S"].includes(event.key)) {
        event.preventDefault();
        setSelected((current) => (current + 3) % games.length);
      }
      if (["ArrowUp", "w", "W"].includes(event.key)) {
        event.preventDefault();
        setSelected((current) => (current - 3 + games.length) % games.length);
      }
      if (
        ["Enter", " "].includes(event.key) &&
        !busy &&
        !gameRunning &&
        !interactionLocked.current
      ) {
        event.preventDefault();
        void (installation ? launchInstalledGame() : installGame());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    busy,
    adminDialogOpen,
    catalogDialogOpen,
    gameRunning,
    installation,
    game,
    games,
    installGame,
    launchInstalledGame,
  ]);

  useEffect(() => {
    let animationFrame = 0;
    let heldActions = new Set<string>();

    const activate = (action: string) => {
      if (action === "right") setSelected((current) => (current + 1) % games.length);
      if (action === "left") setSelected((current) => (current - 1 + games.length) % games.length);
      if (action === "down") setSelected((current) => (current + 3) % games.length);
      if (action === "up") setSelected((current) => (current - 3 + games.length) % games.length);
      if (action === "confirm") void activateSelectedGame();
      if (action === "back" && adminDialogOpen) closeAdminDialog();
      if (action === "back" && catalogDialogOpen && !catalogSaving) {
        setCatalogDialogOpen(false);
        setCatalogPassword("");
        setCatalogError("");
        setShowCatalogPassword(false);
      }
    };

    const pollGamepad = () => {
      const gamepad = [...navigator.getGamepads()].find((item) => item !== null);
      const activeActions = new Set<string>();
      if (gamepad) {
        const pressed = (button: number) => gamepad.buttons[button]?.pressed;
        if (!adminDialogOpen && !catalogDialogOpen) {
          if (pressed(14) || gamepad.axes[0] < -0.6) activeActions.add("left");
          if (pressed(15) || gamepad.axes[0] > 0.6) activeActions.add("right");
          if (pressed(12) || gamepad.axes[1] < -0.6) activeActions.add("up");
          if (pressed(13) || gamepad.axes[1] > 0.6) activeActions.add("down");
          if (pressed(0)) activeActions.add("confirm");
        }
        if (pressed(1)) activeActions.add("back");
      }
      for (const action of activeActions) if (!heldActions.has(action)) activate(action);
      heldActions = activeActions;
      animationFrame = window.requestAnimationFrame(pollGamepad);
    };

    animationFrame = window.requestAnimationFrame(pollGamepad);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    busy,
    adminDialogOpen,
    catalogDialogOpen,
    catalogSaving,
    gameRunning,
    installation,
    game,
    games,
    activateSelectedGame,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("game-ended", () => {
      setGameRunning(false);
      interactionLocked.current = false;
      setMessage("Jogo encerrado. Escolha o próximo.");
    }).then((stopListening) => {
      unlisten = stopListening;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (adminDialogOpen) passwordInput.current?.focus();
  }, [adminDialogOpen]);

  useEffect(() => {
    const catalogElement = catalogRef.current;
    const card = cardRefs.current[selected];
    if (!catalogElement || !card) return;
    if (selected < 3) {
      catalogElement.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected]);

  async function uninstallGame() {
    if (!installation || busy || gameRunning) return;
    setBusy(true);
    setMessage(`Desinstalando ${game.title}…`);
    try {
      await invoke("uninstall_game", { gameId: game.id });
      setInstallations((current) => {
        const updated = { ...current };
        delete updated[game.id];
        return updated;
      });
      setCoverSources((current) => {
        const updated = { ...current };
        delete updated[game.id];
        return updated;
      });
      setMessage(`${game.title} e sua capa foram removidos.`);
    } catch (error) {
      setMessage(`Falha ao desinstalar: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exitLauncher() {
    try {
      await invoke("exit_launcher");
    } catch (error) {
      setMessage(`Não foi possível sair: ${String(error)}`);
    }
  }

  function closeAdminDialog() {
    setAdminDialogOpen(false);
    setAdminPassword("");
    setAdminError("");
    setShowAdminPassword(false);
  }

  function requestEventModeToggle() {
    setAdminPassword("");
    setAdminError("");
    setShowAdminPassword(false);
    setAdminDialogOpen(true);
  }

  async function requestAdminAuthorization(event: React.FormEvent) {
    event.preventDefault();
    try {
      const enabled = await invoke<boolean>("toggle_event_mode", { password: adminPassword });
      setEventModeEnabled(enabled);
      closeAdminDialog();
      setMessage(
        enabled
          ? "Modo evento ativado. Saída e desinstalação estão bloqueadas."
          : "Modo evento desativado. Controles administrativos liberados.",
      );
    } catch (error) {
      setAdminError(String(error));
    }
  }

  async function openCatalogEditor() {
    setCatalogError("");
    setCatalogPassword("");
    setShowCatalogPassword(false);
    try {
      const contents = await invoke<string>("get_catalog_json");
      const parsed = JSON.parse(contents) as Array<Game & { cover_url?: string }>;
      setCatalogDraft(
        parsed.map(({ cover_url, ...item }) => ({
          ...item,
          coverUrl: item.coverUrl ?? cover_url ?? "",
        })),
      );
      setCatalogDialogOpen(true);
    } catch (error) {
      setMessage(`Não foi possível abrir o catálogo: ${String(error)}`);
    }
  }

  function closeCatalogEditor() {
    if (catalogSaving) return;
    setCatalogDialogOpen(false);
    setCatalogPassword("");
    setCatalogError("");
    setShowCatalogPassword(false);
  }

  async function saveCatalog(event: React.FormEvent) {
    event.preventDefault();
    setCatalogSaving(true);
    setCatalogError("");
    try {
      const catalogToSave = catalogDraft.map((item) => ({
        ...item,
        coverUrl: item.coverUrl?.trim() || undefined,
        builds: Object.fromEntries(
          Object.entries(item.builds).filter(
            ([, build]) => build.downloadUrl.trim() || build.executable.trim(),
          ),
        ),
      }));
      const result = await invoke<SavedCatalogResponse>("save_catalog", {
        password: catalogPassword,
        contents: JSON.stringify(catalogToSave, null, 2),
      });
      setGames(result.games);
      setSelected(0);
      setCatalogDialogOpen(false);
      setCatalogPassword("");
      setMessage(`Catálogo salvo. Backup anterior: ${result.backupPath}`);
    } catch (error) {
      setCatalogError(String(error));
    } finally {
      setCatalogSaving(false);
    }
  }

  function updateCatalogGame(index: number, changes: Partial<EditableGame>) {
    setCatalogDraft((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...changes } : item)),
    );
  }

  function updateCatalogBuild(
    gameIndex: number,
    platformName: CatalogPlatform,
    changes: Partial<GameBuild>,
  ) {
    setCatalogDraft((current) =>
      current.map((item, itemIndex) => {
        if (itemIndex !== gameIndex) return item;
        const build = item.builds[platformName] ?? { downloadUrl: "", executable: "" };
        return {
          ...item,
          builds: { ...item.builds, [platformName]: { ...build, ...changes } },
        };
      }),
    );
  }

  function addCatalogGame() {
    setCatalogDraft((current) => [
      ...current,
      {
        id: "novo-jogo",
        title: "Novo jogo",
        summary: "",
        accent: "#f6a43a",
        coverUrl: "",
        builds: {},
      },
    ]);
  }

  return (
    <main className="launcher-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">LIGA DE JOGOS</p>
          <h1>UEFS</h1>
        </div>
        <div className="topbar-actions">
          <p className="status">{Object.keys(installations).length} instalados</p>
          <button
            className="admin-action"
            disabled={busy || gameRunning}
            onClick={() => void openCatalogEditor()}
          >
            Editar catálogo
          </button>
          <button
            className={`admin-action ${eventModeEnabled ? "is-active" : ""}`}
            aria-pressed={eventModeEnabled}
            onClick={requestEventModeToggle}
          >
            {eventModeEnabled ? "Desativar modo evento" : "Ativar modo evento"}
          </button>
          <button
            className="exit-action"
            disabled={eventModeEnabled}
            onClick={() => void exitLauncher()}
          >
            Sair
          </button>
        </div>
      </header>
      <section
        ref={catalogRef}
        aria-label="Catálogo de jogos"
        className="catalog"
        data-downloading-game={downloadingGameId ?? undefined}
      >
        {games.map((item, index) => (
          <button
            ref={(element) => {
              cardRefs.current[index] = element;
            }}
            className={`game-card ${selected === index ? "is-selected" : ""}`}
            key={item.id}
            onClick={() => setSelected(index)}
            style={{ "--accent": item.accent } as React.CSSProperties}
          >
            <span className="cover" aria-hidden="true">
              {coverSources[item.id] ? (
                <img src={coverSources[item.id]} alt="" />
              ) : (
                String(index + 1).padStart(2, "0")
              )}
            </span>
            <span className="game-title">{item.title}</span>
            <span className="game-state">
              {item.builds[platform]
                ? installations[item.id]
                  ? "Pronto para jogar"
                  : "Não instalado"
                : "Indisponível nesta plataforma"}
            </span>
          </button>
        ))}
      </section>
      <section className="game-details" aria-live="polite">
        <div>
          <p className="eyebrow">SELECIONADO · {platform.toUpperCase()}</p>
          <h2>{game.title}</h2>
          <p>{game.summary}</p>
        </div>
        <div className="game-actions">
          <button
            className="primary-action"
            disabled={busy || gameRunning || !build}
            onClick={activateSelectedGame}
          >
            {busy
              ? "Aguarde…"
              : gameRunning
                ? "Em execução"
                : !build
                  ? "Indisponível"
                  : installation
                    ? "Jogar"
                    : "Instalar"}
          </button>
          {installation && !eventModeEnabled && (
            <button
              className="secondary-action"
              disabled={busy || gameRunning}
              onClick={() => void uninstallGame()}
            >
              Desinstalar
            </button>
          )}
        </div>
      </section>
      <footer>
        <span>{message}</span>
        <span>Feito por João Victor Anunciação da Silva</span>
        <span>Setas / WASD ou direcional · Enter / A para selecionar</span>
      </footer>
      {adminDialogOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="exit-dialog"
            onSubmit={requestAdminAuthorization}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-dialog-title"
          >
            <p className="eyebrow">ADMINISTRAÇÃO</p>
            <h2 id="admin-dialog-title">Autorização necessária</h2>
            <p>Digite a senha para {eventModeEnabled ? "desativar" : "ativar"} o modo evento.</p>
            <label htmlFor="admin-password">Senha de autorização</label>
            <div className="password-field">
              <input
                ref={passwordInput}
                id="admin-password"
                type={showAdminPassword ? "text" : "password"}
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowAdminPassword((current) => !current)}
                aria-label={showAdminPassword ? "Ocultar senha" : "Mostrar senha"}
                aria-pressed={showAdminPassword}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
                  <circle cx="12" cy="12" r="2.7" />
                  {showAdminPassword && <path d="m4 4 16 16" />}
                </svg>
              </button>
            </div>
            {adminError && <p className="dialog-error">{adminError}</p>}
            <div className="dialog-actions">
              <button type="button" className="cancel-action" onClick={closeAdminDialog}>
                Cancelar
              </button>
              <button type="submit" className="confirm-action">
                {eventModeEnabled ? "Desativar modo evento" : "Ativar modo evento"}
              </button>
            </div>
          </form>
        </div>
      )}
      {catalogDialogOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="exit-dialog catalog-dialog"
            onSubmit={saveCatalog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="catalog-dialog-title"
          >
            <p className="eyebrow">ADMINISTRAÇÃO</p>
            <h2 id="catalog-dialog-title">Editar catálogo local</h2>
            <p>
              Use IDs do Google Drive ou URLs HTTPS completas em <code>coverUrl</code> e{" "}
              <code>downloadUrl</code>. A versão atual será copiada para o backup antes de salvar.
            </p>
            <div className="catalog-editor-list">
              {catalogDraft.map((item, index) => (
                <fieldset className="catalog-editor-game" key={`${item.id}-${index}`}>
                  <legend>Jogo {index + 1}</legend>
                  <div className="catalog-editor-grid">
                    <label>
                      ID do jogo
                      <input
                        value={item.id}
                        onChange={(event) => updateCatalogGame(index, { id: event.target.value })}
                      />
                    </label>
                    <label>
                      Título
                      <input
                        value={item.title}
                        onChange={(event) =>
                          updateCatalogGame(index, { title: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Cor de destaque
                      <span className="color-field">
                        <input
                          type="color"
                          value={item.accent}
                          onChange={(event) =>
                            updateCatalogGame(index, { accent: event.target.value })
                          }
                        />
                        <input
                          value={item.accent}
                          onChange={(event) =>
                            updateCatalogGame(index, { accent: event.target.value })
                          }
                        />
                      </span>
                    </label>
                    <label>
                      ID ou URL da capa
                      <input
                        value={item.coverUrl ?? ""}
                        onChange={(event) =>
                          updateCatalogGame(index, { coverUrl: event.target.value })
                        }
                      />
                    </label>
                    <label className="full-row">
                      Resumo
                      <textarea
                        value={item.summary}
                        onChange={(event) =>
                          updateCatalogGame(index, { summary: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  {(["windows", "linux"] as const).map((platformName) => {
                    const draftBuild = item.builds[platformName] ?? {
                      downloadUrl: "",
                      executable: "",
                    };
                    return (
                      <fieldset className="catalog-build" key={platformName}>
                        <legend>{platformName === "windows" ? "Windows" : "Linux"}</legend>
                        <label>
                          ID ou URL do ZIP
                          <input
                            value={draftBuild.downloadUrl}
                            onChange={(event) =>
                              updateCatalogBuild(index, platformName, {
                                downloadUrl: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Caminho do executável
                          <input
                            value={draftBuild.executable}
                            onChange={(event) =>
                              updateCatalogBuild(index, platformName, {
                                executable: event.target.value,
                              })
                            }
                          />
                        </label>
                      </fieldset>
                    );
                  })}
                  <button
                    type="button"
                    className="remove-game-action"
                    onClick={() =>
                      setCatalogDraft((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    Remover jogo
                  </button>
                </fieldset>
              ))}
              <button type="button" className="add-game-action" onClick={addCatalogGame}>
                Adicionar jogo
              </button>
            </div>
            <label htmlFor="catalog-password">Senha de autorização</label>
            <div className="password-field">
              <input
                id="catalog-password"
                type={showCatalogPassword ? "text" : "password"}
                value={catalogPassword}
                onChange={(event) => setCatalogPassword(event.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowCatalogPassword((current) => !current)}
                aria-label={showCatalogPassword ? "Ocultar senha" : "Mostrar senha"}
                aria-pressed={showCatalogPassword}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
                  <circle cx="12" cy="12" r="2.7" />
                  {showCatalogPassword && <path d="m4 4 16 16" />}
                </svg>
              </button>
            </div>
            {catalogError && <p className="dialog-error">{catalogError}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="cancel-action"
                disabled={catalogSaving}
                onClick={closeCatalogEditor}
              >
                Cancelar
              </button>
              <button type="submit" className="confirm-action" disabled={catalogSaving}>
                {catalogSaving ? "Salvando…" : "Salvar catálogo"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

export default App;
