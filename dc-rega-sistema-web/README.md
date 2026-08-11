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
