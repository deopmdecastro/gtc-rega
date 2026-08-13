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

## Notas
- `backend/` contém um mock backend Express + Socket.IO para desenvolvimento local (não é usado pela app React).

## Esquema elétrico (PDF)
- A fonte de verdade do PDF é `schematics/Esquema - GTC Rega.pdf` (raiz do repositório).
- A app usa a cópia em `src/assets/esquema-eletrico.pdf` (separador "Esquema").
- Para sincronizar automaticamente após cada `git pull`/`git merge`, ativa os hooks uma única vez (por clone):
  ```bash
  git config core.hooksPath .githooks
  ```
  A partir daí, sempre que o PDF em `schematics/` for atualizado e fizeres pull, a cópia usada pela app é atualizada automaticamente. Sem ativar os hooks, copia manualmente com:
  ```bash
  cp "schematics/Esquema - GTC Rega.pdf" "dc-rega-sistema-web/src/assets/esquema-eletrico.pdf"
  ```

## Ícone da app (PWA / Adicionar ao ecrã principal)
- `public/site.webmanifest` + `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png` e `public/apple-touch-icon.png` foram gerados a partir de `icon gtc rega.PNG` (o ícone da folha, mesmo usado no logo).
- Ao instalar a PWA ou "Adicionar ao ecrã principal" no telemóvel, este ícone é o que aparece.
