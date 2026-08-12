import { useEffect, useState } from 'react';

/**
 * Deteta a versão "embedded" (display do ESP32-S3, 240×320 / 320×240).
 *
 * A mesma condição usada no embedded.css:
 *   (max-width: 340px) OU (max-height: 260px em landscape)
 *
 * Também é possível forçar o modo embedded com:
 *   - query string:  ?embedded=1  ou  ?ui=embedded
 *   - build flag:    VITE_EMBEDDED=1
 *
 * Funcionalidades exclusivas da versão web (PC / telemóvel / tablet):
 *   - Mapa de pinos GPIO e edição de pinos
 *   - Mapa de localização dos sensores e válvulas
 */
export const EMBEDDED_MEDIA_QUERY =
  '(max-width: 340px), (max-height: 260px) and (orientation: landscape)';

function forcedEmbedded(): boolean {
  if (import.meta.env.VITE_EMBEDDED === '1' || import.meta.env.VITE_EMBEDDED === 'true') return true;
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('embedded') === '1' || params.get('ui') === 'embedded';
}

function detect(): boolean {
  if (typeof window === 'undefined') return false;
  if (forcedEmbedded()) return true;
  return window.matchMedia(EMBEDDED_MEDIA_QUERY).matches;
}

export function useIsEmbedded(): boolean {
  const [embedded, setEmbedded] = useState<boolean>(detect);

  useEffect(() => {
    const mql = window.matchMedia(EMBEDDED_MEDIA_QUERY);
    const update = () => setEmbedded(forcedEmbedded() || mql.matches);
    update();
    mql.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      mql.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return embedded;
}
