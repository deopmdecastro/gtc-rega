// Sincroniza automaticamente o PDF do esquema elétrico antes de "dev"/"build".
//
// Fonte de verdade: schematics/Esquema - GTC Rega.pdf (raiz do repositório)
// Destino: src/assets/esquema-eletrico.pdf (importado via ?url do Vite e
//          servido pelo separador "Esquema" da app)
//
// Antes, esta sincronização dependia de git hooks (.githooks/post-merge e
// post-checkout) que só funcionam se cada developer correr manualmente
// `git config core.hooksPath .githooks`, e que NUNCA correm no build da
// Vercel (checkout limpo, sem hooks locais configurados). Resultado: o PDF
// do assets ficava desatualizado sempre que só o `schematics/*.pdf` era
// atualizado e commitado sem correr o hook localmente.
//
// Este script corre sempre antes de "npm run dev" e "npm run build" (via
// predev/prebuild no package.json), garantindo que o PDF usado pela app é
// sempre o mais recente, em qualquer máquina ou ambiente de build.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..'); // dc-rega-sistema-web/
const repoRoot = join(projectRoot, '..'); // raiz do repositório git

const src = join(repoRoot, 'schematics', 'Esquema - GTC Rega.pdf');
const destDir = join(projectRoot, 'src', 'assets');
const dest = join(destDir, 'esquema-eletrico.pdf');

if (!existsSync(src)) {
  console.warn(`[sync-pdf] Aviso: PDF de origem não encontrado em "${src}". A saltar sincronização.`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[sync-pdf] PDF do esquema sincronizado: ${dest}`);
