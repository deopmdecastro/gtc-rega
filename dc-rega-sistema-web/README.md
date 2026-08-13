# GTC — Sistema de Rega Automatizada (Web)

Painel de monitorização e controlo do sistema de rega baseado em ESP32-S3.
Aplicação web em **React + Vite + TypeScript**, com registo de eventos
opcional via **Supabase**.

## Funcionalidades
- **Resumo** — estado geral do sistema, atuadores (bomba + válvulas) e sensores.
- **Estado** — leitura em tempo real dos equipamentos e modo de operação.
- **Setpoints** — configuração de humidade mínima, tempo de rega e delay da bomba (teclado numérico).
- **Mapa** — editor visual da propriedade com sensores, válvulas, bomba, microcontrolador e terrenos.
- **Histórico** — eventos de rega e histórico de erros.
- **Comandos** — Start / Stop / Reset, controlo manual e paragem de emergência.
- **Alarmes** — gestão de alarmes ativos e resolvidos.
- **Definições** — idioma (PT/EN) e conta do operador.

## Editor de Mapa (melhorado)
O separador **Mapa** tem agora um modo de edição completo:
- Botão **"Editar mapa"** para entrar/sair do modo de edição.
- **Adicionar sensor** — clicar numa área livre do mapa (em modo edição).
- **Mover** — arrastar qualquer elemento (sensores, válvulas, bomba, ESP32, terrenos).
- **Selecionar** — clicar num elemento mostra a barra de ação com opções.
- **Renomear** — sensores e terrenos (teclado on-screen).
- **Apagar** — sensores (com confirmação) e terrenos.
- **Adicionar terreno** e **redimensionar** terrenos (pega no canto inferior direito).
- **Repor layout** — volta às posições originais.

Fora do modo de edição o mapa é apenas de visualização (evita alterações acidentais).

## Configuração do Supabase (opcional)
O painel funciona **sem** Supabase — o registo de eventos fica em memória
durante a sessão. Para persistir o histórico numa base de dados:

1. Copie `.env.example` para `.env.local`.
2. Preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.

> A correção do erro `supabaseUrl is required` torna o cliente Supabase
> resiliente: quando as variáveis não existem, a app degrada de forma
> silenciosa em vez de rebentar no arranque.

## Como correr
```bash
npm install
npm run dev        # servidor de desenvolvimento (Vite)
npm run build      # build de produção -> dist/
npm run preview    # pré-visualizar o build
npm run typecheck  # verificação de tipos
npm run lint       # ESLint
```

## Arquitetura de dados
- **Modelos**: `Zone` (sensor + válvula), `MapField` (terreno), `EventLogEntry`, `ErrorEvent`.
- **Armazenamento**: Supabase (tabela `event_log`) — opcional; fallback em memória.
- **Fluxo**: ações no painel → `logEvent()` → Supabase / cache local → separador Histórico.

## Stack
- React 18 · TypeScript · Vite 5 · lucide-react · Supabase JS

## Arquitetura geral (Vercel + backend + ESP32-S3)
```text
                INTERNET
                   │
                   ▼
        ┌─────────────────────┐
        │       VERCEL        │   gtc-rega.vercel.app
        │  GTC Rega Web       │   React/Vite (só ficheiros estáticos)
        │  (este projeto)     │
        └──────────┬──────────┘
                   │ HTTPS + WebSocket (VITE_API_URL)
                   ▼
        ┌─────────────────────┐
        │  backend/ (Docker)  │   Express + Socket.IO, auto-hospedado
        │  REST + WebSocket   │   (docker-compose.yml, NÃO corre na Vercel)
        │  DEVICE_TOKEN       │
        └──────────┬──────────┘
                   │ REST (telemetria/comandos) — mesma rede ou VPN/porta exposta
                   ▼
        ┌─────────────────────┐
        │      ESP32-S3       │   GTC_SERVER_HOST/PORT em firmware/…/config.h
        │  Web server local   │   também expõe UI própria: http://gtc-rega.local
        │  BLE de emparelh.   │
        └──────────┬──────────┘
                   │
            Sensores · Válvulas · Bomba
```
- O **frontend** (este repositório) fica só na Vercel — nunca fala diretamente
  com o IP do ESP32 pela Internet; usa sempre `VITE_API_URL` para chegar ao
  `backend/`.
- O **backend** (`backend/`, Express + Socket.IO) é o único componente que
  fala com o ESP32-S3, autentica-o via `DEVICE_TOKEN` e mantém o estado
  (`gtc-state.json`, `gtc-layout.json`) num volume Docker. Corre num
  self-host (Docker/VPS) — **não é um mock** e é o backend real usado em
  produção pela app React (ver `docker-compose.yml` e `.env.example`).
- O **ESP32-S3** nunca fica exposto diretamente à Internet (sem port-forward
  a partir do router); comunica para fora através do backend, e continua a
  servir a sua própria interface local (`gtc-rega.local`, LittleFS) e BLE
  para configuração mesmo sem Internet.
- Não há MQTT no fluxo atual — o par REST + WebSocket entre o ESP32, o
  backend e o frontend já cobre telemetria, comandos e estado em tempo real
  para um único controlador. Um broker MQTT só passaria a valer a pena se o
  projeto evoluir para vários ESP32 em paralelo (ex.: `REGA-001`,
  `REGA-002`, …), cada um a publicar num tópico próprio.

## Esquema elétrico (PDF)
- A fonte de verdade do PDF é `schematics/Esquema - GTC Rega.pdf` (raiz do repositório).
- A app usa a cópia em `src/assets/esquema-eletrico.pdf` (separador "Esquema").
- **Sincronização automática (recomendado):** `npm run dev` e `npm run build`
  correm sempre `scripts/sync-pdf.mjs` antes (via `predev`/`prebuild`), que
  copia a versão mais recente de `schematics/` para `src/assets/`. Isto
  funciona em qualquer máquina e também no build da Vercel — não depende de
  git hooks nem de ninguém correr um comando manualmente.
- Os hooks em `.githooks/` (`post-merge`/`post-checkout`) fazem o mesmo, mas
  só correm localmente e só depois de ativados uma vez por clone com
  `git config core.hooksPath .githooks`; ficam como conveniência extra, não
  como o mecanismo principal. Para sincronizar manualmente a qualquer altura:
  ```bash
  npm run sync-pdf
  ```

## Ícone da app (PWA / Adicionar ao ecrã principal)
- `public/site.webmanifest` + `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png` e `public/apple-touch-icon.png` foram gerados a partir de `icon gtc rega.PNG` (o ícone da folha, mesmo usado no logo).
- Ao instalar a PWA ou "Adicionar ao ecrã principal" no telemóvel, este ícone é o que aparece.
