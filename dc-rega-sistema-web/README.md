# DC Rega — UI Prototype

Projeto mínimo que converte o ficheiro `dc-rega-sistema.html` numa interface web utilizável como protótipo.

## Conteúdo
- `index.html` — mockup LVGL convertido para HTML/CSS (interface prevista)
- `index-api.html` — protótipo funcional que consome o mock backend e mostra estado em tempo real
- `package.json` — script `npm start` para servir a pasta localmente via `http-server`

## Como correr (opções)

Opcional A — com Node (recomendado se tem npm):

```bash
npm install -g http-server   # opcional, ou use npx
npm start
# depois abra http://localhost:8080
```

Opcional B — com Python (sem instalar nada extra):

```bash
# Python 3
python -m http.server 8080
# depois abra http://localhost:8080
```

## Próximos passos sugeridos
- Separar o CSS numa folha própria e assets em `assets/`.
- Criar um pequeno backend REST no ESP32 (ESP-IDF) e um protótipo da app Flutter que consuma a API.
- Converter os componentes visuais para LVGL (C) no firmware do ESP32-S3.

## Notas
Este repositório é um protótipo de UI para validação visual e contém um *mock backend* para desenvolvimento local.

## Docker
Inclui definições para correr front e back via Docker Compose.

### Como correr com Docker Compose

```bash
# a partir da pasta dc-rega-sistema-web
docker compose up --build
# depois abra http://localhost:8080 (front) e a API fica em http://localhost:3000
```

### Endpoints do mock backend
- `GET /api/status` — devolve o estado atual
- `POST /api/command` — envia comandos JSON, ex: `{ "command":"START" }`
- WebSocket — em `ws://localhost:3000` (Socket.IO) emite eventos `update`

