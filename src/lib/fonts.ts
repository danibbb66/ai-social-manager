/**
 * Stack di font per la rasterizzazione del testo (sharp).
 *
 * I server Vercel (Linux minimale) non hanno Arial/Helvetica: senza un font
 * disponibile, qualunque testo composto in "Arial" esce come quadratini
 * (tofu). Si include nel progetto il font libero DejaVu Sans (in
 * `public/fonts/`) e lo si mette per primo nello stack: su Vercel viene
 * risolto via fontconfig (vedi `public/fonts/fonts.conf` e la variabile
 * d'ambiente `FONTCONFIG_FILE`), in locale si ricade su Arial di sistema.
 */
export const APP_FONT_STACK = "'DejaVu Sans', Arial, Helvetica, sans-serif";
