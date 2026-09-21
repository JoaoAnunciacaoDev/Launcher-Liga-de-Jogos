import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import catalog from "./catalog.json";
import type { CatalogResponse, Game, Platform } from "./catalogTypes";
import { AdminDialog } from "./components/AdminDialog";
import { CatalogEditor } from "./components/CatalogEditor";
import "./App.css";

type Installation = { installPath: string; executablePath: string };
type DownloadProgress = { gameId: string; downloadedBytes: number; totalBytes: number | null };
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
  const [catalogDialogOpen, setCatalogDialogOpen] = useState(false);
  const [eventModeEnabled, setEventModeEnabled] = useState(false);
  const interactionLocked = useRef(false);
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
              ? (detail ?? "Usando catálogo editado neste launcher.")
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
      if (action === "back" && adminDialogOpen) setAdminDialogOpen(false);
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

  const closeAdminDialog = useCallback(() => setAdminDialogOpen(false), []);

  const handleEventModeChanged = useCallback((enabled: boolean) => {
    setEventModeEnabled(enabled);
    setMessage(
      enabled
        ? "Modo evento ativado. Saída e desinstalação estão bloqueadas."
        : "Modo evento desativado. Controles administrativos liberados.",
    );
  }, []);

  const closeCatalogEditor = useCallback(() => setCatalogDialogOpen(false), []);

  const handleCatalogSaved = useCallback((updatedGames: Game[], catalogPath: string) => {
    setGames(updatedGames);
    setSelected(0);
    setMessage(`Catálogo salvo e pronto para enviar ao Drive: ${catalogPath}`);
  }, []);

  const handleCatalogSynced = useCallback((updatedGames: Game[]) => {
    setGames(updatedGames);
    setSelected(0);
    setMessage("Catálogo local substituído pela versão atual do Drive.");
  }, []);

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
            onClick={() => setCatalogDialogOpen(true)}
          >
            Editar catálogo
          </button>
          <button
            className={`admin-action ${eventModeEnabled ? "is-active" : ""}`}
            aria-pressed={eventModeEnabled}
            onClick={() => setAdminDialogOpen(true)}
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
        <AdminDialog
          eventModeEnabled={eventModeEnabled}
          onClose={closeAdminDialog}
          onChanged={handleEventModeChanged}
        />
      )}
      {catalogDialogOpen && (
        <CatalogEditor
          coverSources={coverSources}
          onClose={closeCatalogEditor}
          onFailure={setMessage}
          onSaved={handleCatalogSaved}
          onSynced={handleCatalogSynced}
        />
      )}
    </main>
  );
}

export default App;
