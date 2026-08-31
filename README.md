# Launcher da Liga de Jogos UEFS

Launcher desktop para instalar, iniciar e organizar os jogos da Liga de Jogos UEFS em computadores de uso público e eventos.

## Recursos atuais

- Tela cheia, sem bordas, pensada para apresentações.
- Navegação por teclado e controle.
- Catálogo remoto carregado do Google Drive, com cópia local para uso sem internet.
- Download, extração e instalação local dos jogos.
- Capas baixadas e armazenadas localmente.
- Apenas um jogo pode executar por vez.
- O launcher aguarda o encerramento do jogo e volta a aparecer automaticamente.
- Saída protegida por senha administrativa.
- Desinstalação de jogo e remoção da capa local correspondente.
- Pacotes para Windows e Linux gerados pelo GitHub Actions em tags de versão.

## Arquitetura

O projeto usa [Tauri 2](https://v2.tauri.app/):

- `src/`: interface React + TypeScript.
- `src-tauri/src/lib.rs`: backend Rust, responsável por arquivos, downloads, extração de ZIPs e processos dos jogos.
- `src/catalog.json`: catálogo embutido de fallback.
- Google Drive: fonte remota do catálogo, jogos e capas.

O frontend conversa com o backend nativo somente por comandos locais do Tauri. Não existe servidor próprio nesta versão.

## Requisitos de desenvolvimento

### Windows

- Node.js 22 ou superior.
- Rust estável com alvo `x86_64-pc-windows-msvc`.
- Visual Studio Build Tools ou Visual Studio Community com a carga de trabalho **Desktop development with C++**.

### Linux

- Node.js 22 ou superior.
- Rust estável.
- Dependências de compilação do WebKitGTK. O workflow do GitHub Actions já as instala automaticamente.

## Executar em desenvolvimento

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Crie o arquivo de senha:

   ```bash
   # Windows (Prompt de Comando)
   copy .env.example .env

   # Linux/macOS
   cp .env.example .env
   ```

3. Edite `.env` e defina uma senha:

   ```env
   LAUNCHER_ADMIN_PASSWORD=uma-senha-forte
   ```

4. Inicie o launcher:

   ```bash
   npm run tauri dev
   ```

> `.env` é ignorado pelo Git e não deve ser enviado ao repositório. A senha é lida durante a compilação e incorporada ao executável. Ela protege o programa em Eventos, mas não deve ser tratada como segredo forte: alguém com acesso técnico ao binário pode extraí-la.

## Controles

| Ação                      | Teclado         | Controle                         |
| ------------------------- | --------------- | -------------------------------- |
| Mover seleção             | Setas ou WASD   | Direcional ou analógico esquerdo |
| Instalar / jogar          | Enter ou Espaço | Botão A                          |
| Cancelar diálogo de saída | —               | Botão B                          |

O botão **Sair** abre uma confirmação com senha. `Alt + F4` é bloqueado pelo launcher.

## Catálogo de jogos

O launcher lê primeiro o catálogo remoto configurado no Rust. Se a consulta falhar, usa o último catálogo válido salvo localmente; se não houver cache, usa `src/catalog.json`.

O arquivo remoto deve ser um JSON válido. Exemplo:

```json
[
  {
    "id": "meu-jogo",
    "title": "Meu Jogo",
    "summary": "Descrição curta do jogo.",
    "accent": "#f6a43a",
    "coverUrl": "https://drive.usercontent.google.com/download?id=ID_DA_CAPA&export=download&confirm=t",
    "builds": {
      "windows": {
        "downloadUrl": "https://drive.usercontent.google.com/download?id=ID_DO_ZIP_WINDOWS&export=download&confirm=t",
        "executable": "MeuJogo/MeuJogo.exe"
      },
      "linux": {
        "downloadUrl": "https://drive.usercontent.google.com/download?id=ID_DO_ZIP_LINUX&export=download&confirm=t",
        "executable": "MeuJogo/MeuJogo.x86_64"
      }
    }
  }
]
```

`cover_url` também é aceito por compatibilidade.

### Regras importantes

- O `id` só pode usar letras, números, `_` e `-`.
- As URLs precisam usar HTTPS e os arquivos do Drive devem estar públicos para leitura por link.
- `executable` é o caminho relativo ao conteúdo do ZIP. Se o executável estiver na raiz, use apenas `MeuJogo.exe`; se estiver em uma pasta, inclua a pasta.
- Atualize o conteúdo do mesmo arquivo de catálogo no Drive. Apagar e reenviar cria outro ID e exigiria atualizar o launcher.
- O catálogo é público somente para leitura. Isso não autoriza outras pessoas a editá-lo.

## Adicionar um jogo

1. Exporte e compacte as versões Windows e Linux separadamente.
2. Envie os ZIPs e a capa ao Google Drive e libere leitura por link.
3. Descubra o ID de cada arquivo no link do Drive.
4. Acrescente o item ao `catalog.json` remoto.
5. Confirme o caminho do executável dentro de cada ZIP.
6. Reinicie o launcher para buscar o catálogo novo.

## Dados locais

No Windows, os dados são salvos em:

```text
%APPDATA%\br.edu.uefs.ligadejogos.launcher\
```

Estrutura principal:

```text
games/<id>/    # arquivos instalados do jogo
covers/<id>/   # capa salva localmente
catalog.json   # cache do catálogo remoto
```

Desinstalar um jogo pelo launcher remove `games/<id>` e `covers/<id>`.

## Gerar pacote Windows

Feche o launcher em desenvolvimento e execute:

```bash
npm run tauri build
```

Arquivos gerados:

```text
src-tauri/target/release/liga-jogos-launcher.exe
```

## Gerar Releases Windows e Linux no GitHub

O workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) gera automaticamente:

- Windows: `.exe`.
- Linux: `.AppImage`.

Ele só executa quando uma tag começando com `v` é enviada; `git pull`, push comum para `main` e Pull Requests não iniciam uma Release.

Para publicar uma versão:

```bash
git add .github/workflows/release.yml
git commit -m "ci: gerar releases Windows e Linux"
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

Os artefatos serão anexados à Release `v0.1.0`. Para executar o AppImage em Linux:

```bash
chmod +x Liga*.AppImage
./Liga*.AppImage
```

## Próximas evoluções

- Formulário administrativo para editar o catálogo sem manipular JSON.
- Autenticação Google OAuth para escrita segura no catálogo.
- Favoritos, avaliações e perfis de usuário.
- Testes de foco de janela e retorno do jogo em Wayland/Linux.
