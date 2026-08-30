import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import "./App.css";

type Game = { id: string; title: string; summary: string; accent: string; installed: boolean };

const games: Game[] = [
  { id: "jogo-um", title: "Jogo 01", summary: "A primeira vaga do catálogo. Em breve, use Instalar para baixar o build.", accent: "#f6a43a", installed: false },
  { id: "jogo-dois", title: "Jogo 02", summary: "O launcher mostrará aqui os jogos prontos para as apresentações.", accent: "#58d4c2", installed: false },
];

function App() {
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("Catálogo local — selecione um jogo.");
  const game = games[selected];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowRight", "d", "D"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current + 1) % games.length); }
      if (["ArrowLeft", "a", "A"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current - 1 + games.length) % games.length); }
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); setMessage(game.installed ? "Abrindo jogo…" : "A instalação será a próxima etapa."); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [game]);

  async function launchInstalledGame() {
    try {
      await invoke("launch_game", { executable: "", workingDirectory: "" });
    } catch (error) { setMessage(String(error)); }
  }

  return (
    <main className="launcher-shell">
      <header className="topbar"><div><p className="eyebrow">LIGA DE JOGOS</p><h1>UEFS Launcher</h1></div><p className="status">{games.filter((item) => item.installed).length} instalados</p></header>
      <section aria-label="Catálogo de jogos" className="catalog">
        {games.map((item, index) => <button className={`game-card ${selected === index ? "is-selected" : ""}`} key={item.id} onClick={() => setSelected(index)} style={{ "--accent": item.accent } as React.CSSProperties}>
          <span className="cover" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span className="game-title">{item.title}</span><span className="game-state">{item.installed ? "Pronto para jogar" : "Não instalado"}</span>
        </button>)}
      </section>
      <section className="game-details" aria-live="polite"><div><p className="eyebrow">SELECIONADO</p><h2>{game.title}</h2><p>{game.summary}</p></div><button className="primary-action" onClick={game.installed ? launchInstalledGame : () => setMessage("Instalação ainda não implementada.")}>{game.installed ? "Jogar" : "Instalar"}</button></section>
      <footer><span>{message}</span><span>← → ou A/D para navegar · Enter para selecionar</span></footer>
    </main>
  );
}

export default App;
